import { applyTransition, readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { release as releaseLease } from '../../orchestrator/leases.ts';
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

  // FORGE-234 (impl R1 MAJ #4): a SHIP-origin answer validates the park is
  // still CURRENT before persisting anything — a superseded question must
  // never receive a durable answer.
  if (q.origin?.phase === 'ship') {
    try {
      const stateNow = readTaskState(opts.forgeDir, location.taskId);
      // impl-R2 MAJ #2: a ship question whose ATTEMPT is no longer the
      // current pointer is stale in EVERY state — the answer must refuse
      // BEFORE persisting (a durable answer on a superseded park would
      // consume the operator's cancellation without honoring it).
      // A cancel is task-level (see resolveShipPark) — only retry_ship is
      // refused when its parked attempt was superseded.
      if (opts.optionId !== 'cancel_task' && stateNow.current_attempt_id !== location.attemptId) {
        err.write(
          `forge orchestrate answer: ship park for attempt ${location.attemptId} was superseded by ${stateNow.current_attempt_id ?? 'none'} — stale answer refused\n`,
        );
        return { exitCode: 1 };
      }
    } catch (e) {
      err.write(`forge orchestrate answer: cannot read task state: ${e instanceof Error ? e.message : String(e)}\n`);
      return { exitCode: 1 };
    }
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

  // FORGE-234 (impl R5): the ANSWER FILE is the single-writer reservation —
  // its `wx` write serializes competing supervisors (the loser gets
  // DUPLICATE_ID and never touches state), so the DURABLE option always
  // decides the resolution. Resolution therefore runs AFTER publication.
  //
  // The R4 hazard this once created — a published cancel that could never be
  // applied because a dispatch stole the attempt pointer — is closed by
  // cancellation being TASK-level rather than attempt-level (see
  // applyCancelTransaction): a durable cancel is always applicable.
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
  // impl-R5: cancel_task is a TASK-level decision, not an attempt-level one.
  // A durable cancellation is applicable from any cancellable state and is
  // fenced on the CURRENT attempt pointer — a concurrent SHIP dispatch that
  // steals the pointer can therefore never orphan the operator's cancel
  // (the R4 hazard), while the answer file's single-writer reservation keeps
  // competing options from committing contradictory outcomes (the R5 hazard).
  if (optionId === 'cancel_task') {
    if (state.state === 'cancelled') return { ok: true, action: 'already applied (state cancelled)' };
    if (state.state !== 'blocked_on_question' && state.state !== 'reviewed') {
      err.write(
        `forge orchestrate answer: cannot cancel task ${taskId} from state '${state.state}'\n`,
      );
      return { ok: false };
    }
    return applyCancelTransaction(forgeDir, taskId, state.current_attempt_id ?? parkedAttemptId, state, err);
  }
  if (state.state !== 'blocked_on_question') {
    // retry_ship is ATTEMPT-scoped: it means "re-ship THIS attempt's work".
    // Destination-aware replay convergence (impl R1 MAJ #4).
    if (state.state === 'reviewed' && state.current_attempt_id === parkedAttemptId) {
      return { ok: true, action: `already applied (state ${state.state})` };
    }
    err.write(
      `forge orchestrate answer: ship park resolution expected 'reviewed' but the task is '${state.state}' — cannot repair\n`,
    );
    return { ok: false };
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
  const next = applyTransition(state.state, 'question_answered_ship');
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
  return { ok: true, action: `question_answered_ship → ${next}` };
}

// The cancel TRANSACTION (impl R1 MAJ #4 / R3 MAJ #2): event + state →
// cancelled + lease release — never a bare state write that strands the
// lease. Legal from blocked_on_question (normal park) AND from reviewed
// (same-attempt orphan park repair).
function applyCancelTransaction(
  forgeDir: string,
  taskId: string,
  attemptIdForFence: string,
  state: ReturnType<typeof readTaskState>,
  err: { write: (s: string) => void },
): { ok: true; action: string } | { ok: false } {
  let lease;
  try {
    lease = readLease(forgeDir, taskId);
  } catch (e) {
    err.write(`forge orchestrate answer: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false };
  }
  try {
    appendAttemptEvent(
      {
        type: 'attempt_cancelled',
        ts: new Date().toISOString(),
        reason: 'ship park: cancel_task answer',
      },
      { forgeDir, taskId, attemptId: attemptIdForFence, caller: callerFromLease(lease) },
    );
  } catch {
    // best-effort audit event
  }
  try {
    writeTaskState(
      forgeDir,
      {
        ...state,
        state: applyTransition(state.state, 'cancel'),
        state_version: state.state_version + 1,
        updated_at: new Date().toISOString(),
        updated_by: callerFromLease(lease),
      },
      callerFromLease(lease),
      { expectedCurrentAttemptId: attemptIdForFence },
    );
  } catch (e) {
    err.write(`forge orchestrate answer: cancel transition failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false };
  }
  try {
    releaseLease({ forgeDir, taskId, caller: callerFromLease(lease) });
  } catch {
    // best-effort — state 'cancelled' is the source of truth
  }
  return { ok: true, action: 'cancel → cancelled (event + state + lease release)' };
}
