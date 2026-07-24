import { applyTransition, readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import {
  QuestionChannelError,
  findQuestionFile,
  readAnswer,
  readQuestion,
  writeAnswerAtomic,
} from '../../orchestrator/questions/index.ts';
import { AnswerSchema } from '../../schemas/questions.ts';

export interface OrchestrateAnswerOptions {
  readonly questionId: string;
  readonly optionId: string;
  readonly note?: string;
  readonly forgeDir: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injectable clock for deterministic tests.
  readonly now?: () => Date;
  readonly answeredBy?: string;
}

export interface OrchestrateAnswerResult {
  readonly exitCode: number;
}

export function runOrchestrateAnswer(
  opts: OrchestrateAnswerOptions,
): OrchestrateAnswerResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  if (!opts.questionId || !opts.optionId) {
    err.write(
      'Usage: forge orchestrate answer <question_id> --option <id> [--note <text>] [--forge-dir <path>]\n',
    );
    return { exitCode: 1 };
  }

  // v2 layout: questions live task-keyed under .forge/orchestrator/tasks/.../
  // attempts/.../questions/<id>.json, but the supervisor only knows the global
  // question id. Walk the task tree once to locate (taskId, attemptId), then
  // read/write strictly within that attempt directory. The walk is the
  // FORGE-73 fallback for spec/ORCHESTRATOR.md §"Answer lookup — global index"
  // until FORGE-20 ships .forge/orchestrator/index/questions.json as a fast
  // path. Both will coexist: index is best-effort, walk is canonical.
  let location;
  try {
    location = findQuestionFile(opts.questionId, { forgeDir: opts.forgeDir });
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  if (location === null) {
    err.write(
      `forge orchestrate answer: NOT_FOUND: question '${opts.questionId}' does not exist under ${opts.forgeDir}\n`,
    );
    return { exitCode: 1 };
  }

  const readOpts = {
    forgeDir: opts.forgeDir,
    taskId: location.taskId,
    attemptId: location.attemptId,
  };

  let q;
  try {
    q = readQuestion(opts.questionId, readOpts);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }

  const validOptionIds = q.options.map((o) => o.id);
  if (!validOptionIds.includes(opts.optionId)) {
    err.write(
      `forge orchestrate answer: invalid option '${opts.optionId}'. Valid: ${validOptionIds.join(', ')}\n`,
    );
    return { exitCode: 1 };
  }

  // Check whether an answer already exists. readAnswer throwing NOT_FOUND
  // is the expected happy path; any other code surfaces as an error.
  try {
    const existing = readAnswer(opts.questionId, readOpts);
    // FORGE-234 (plan v3 Δ11): an identical pre-existing answer on a
    // SHIP-origin park is a REPLAY — repair the missing state transition
    // (answer-file write and state CAS are not atomic; a crash between them
    // must converge, not dead-end).
    if (q.origin?.phase === 'ship' && existing.option_id === opts.optionId) {
      const repaired = resolveShipPark(opts.forgeDir, location.taskId, location.attemptId, opts.optionId, err);
      if (repaired.ok) {
        out.write(`Answer already recorded; ship park resolution ${repaired.action}.\n`);
        return { exitCode: 0 };
      }
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: question '${opts.questionId}' has already been answered.\n`,
    );
    return { exitCode: 1 };
  } catch (e) {
    if (e instanceof QuestionChannelError && e.code !== 'NOT_FOUND') {
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    // NOT_FOUND or non-channel error → proceed (latter rethrown below)
    if (!(e instanceof QuestionChannelError)) throw e;
  }

  const now = opts.now ?? (() => new Date());
  const answeredBy = opts.answeredBy ?? 'supervisor';
  const answer = AnswerSchema.parse({
    version: 1,
    question_id: opts.questionId,
    answered_at: now().toISOString(),
    answered_by: answeredBy,
    option_id: opts.optionId,
    ...(opts.note ? { note: opts.note } : {}),
  });

  try {
    writeAnswerAtomic(answer, readOpts);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      if (e.code === 'DUPLICATE_ID') {
        err.write(
          `forge orchestrate answer: answer was written by a concurrent supervisor; refusing to overwrite.\n`,
        );
        return { exitCode: 1 };
      }
      err.write(`forge orchestrate answer: ${e.code}: ${e.message}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate answer: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  // FORGE-234 (plan v3 Δ11 + R3 ΔR3): the answer verb OWNS the state
  // resolution for SHIP-origin parks — retry_ship → reviewed (re-ship);
  // cancel_task → cancelled while still blocked. Worker-origin questions keep
  // the existing lifecycle (dispatch re-spawns; no transition here).
  if (q.origin?.phase === 'ship') {
    const resolved = resolveShipPark(opts.forgeDir, location.taskId, location.attemptId, opts.optionId, err);
    if (!resolved.ok) return { exitCode: 1 };
    out.write(`Answered ${opts.questionId} with option ${opts.optionId}; ship park resolution ${resolved.action}.\n`);
    return { exitCode: 0 };
  }
  out.write(`Answered ${opts.questionId} with option ${opts.optionId}.\n`);
  return { exitCode: 0 };
}

// FORGE-234: phase-aware ship-park resolution. CAS against the live state;
// a superseded parked attempt refuses (stale answer must not move the task).
function resolveShipPark(
  forgeDir: string,
  taskId: string,
  parkedAttemptId: string,
  optionId: string,
  err: { write: (s: string) => void },
): { ok: true; action: string } | { ok: false } {
  let state;
  try {
    state = readTaskState(forgeDir, taskId);
  } catch (e) {
    err.write(`forge orchestrate answer: cannot read task state: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false };
  }
  if (state.state !== 'blocked_on_question') {
    // Already resolved (crash-replay after the CAS landed) — converged.
    return { ok: true, action: `already applied (state ${state.state})` };
  }
  if (state.current_attempt_id !== parkedAttemptId) {
    err.write(
      `forge orchestrate answer: ship park for attempt ${parkedAttemptId} was superseded by ${state.current_attempt_id ?? 'none'} — stale answer refused\n`,
    );
    return { ok: false };
  }
  let lease;
  try {
    lease = readLease(forgeDir, taskId);
  } catch (e) {
    err.write(`forge orchestrate answer: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false };
  }
  const trigger = optionId === 'cancel_task' ? 'cancel' : 'question_answered_ship';
  const next = applyTransition(state.state, trigger);
  try {
    writeTaskState(
      forgeDir,
      {
        ...state,
        state: next,
        state_version: state.state_version + 1,
        updated_at: new Date().toISOString(),
        updated_by: callerFromLease(lease),
      },
      callerFromLease(lease),
      { expectedCurrentAttemptId: parkedAttemptId },
    );
  } catch (e) {
    err.write(`forge orchestrate answer: state transition failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false };
  }
  return { ok: true, action: `${trigger} → ${next}` };
}
