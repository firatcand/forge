// `forge orchestrate complete` — finalize an attempt.
//
// Reads --verdict-file, validates against VerdictSchema, writes both
// verdict.json (worker-reported) and verdict.verified.json (CLI-recomputed
// is deferred to a follow-up; v0.4 stores the verified copy = the reported
// copy plus a `verified_by: 'cli'` envelope). Transitions task state per
// (verdict, phase):
//   implement + ready_for_review → ready_for_review
//   review    + ready_for_review → reviewed
//   ship      + ready_for_review → shipped (terminal)
//   _         + changes_needed   → running (loop back)
//   _         + blocked          → running (then worker writes a question)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { CompleteArgsSchema, type CompleteArgs } from '../../schemas/cli-args.ts';
import { VerdictSchema } from '../../schemas/verdict.ts';
import { readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { attemptDir } from '../../orchestrator/questions/paths.ts';
import { OrchestratorError } from '../../core/errors.ts';
import type { TaskState } from '../../schemas/task-state.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export async function runOrchestrateComplete(
  args: CompleteArgs,
): Promise<{ exitCode: number }> {
  const parsed = CompleteArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // 1. Read verdict file.
  let verdictRaw: string;
  try {
    verdictRaw = readFileSync(opts.verdictFile, 'utf8');
  } catch (err) {
    return {
      exitCode: emit(
        fail('VERDICT_FILE_READ_FAILED', err instanceof Error ? err.message : String(err), false),
        { json: opts.json },
      ),
    };
  }
  let verdictParsed: unknown;
  try {
    verdictParsed = JSON.parse(verdictRaw);
  } catch (err) {
    return {
      exitCode: emit(
        fail('INVALID_VERDICT_FILE', `not valid JSON: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }
  const verdict = VerdictSchema.safeParse(verdictParsed);
  if (!verdict.success) {
    return {
      exitCode: emit(
        fail('INVALID_VERDICT', verdict.error.message, false),
        { json: opts.json },
      ),
    };
  }

  // 2. Read lease for caller identity.
  let lease: Lease;
  try {
    lease = readLease(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  // 3. Write verdict.json + verdict.verified.json atomically.
  const dir = attemptDir(opts.forgeDir, opts.taskId, opts.attemptId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to ensure attempt dir: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }
  const verdictPath = path.join(dir, 'verdict.json');
  const verifiedPath = path.join(dir, 'verdict.verified.json');
  try {
    writeFileSync(verdictPath, `${JSON.stringify(verdict.data, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `verdict.json write failed: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }
  // verdict.verified.json: CLI re-verification is deferred; for v0.4 we record
  // the verbatim verdict with a verified_by stamp. Adopters can re-run tests/lint
  // out-of-band and replace this file.
  const verified = {
    ...verdict.data,
    verified_by: 'cli@v0.4-self-attest',
    verified_at: new Date().toISOString(),
  };
  try {
    writeFileSync(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `verdict.verified.json write failed: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }

  // 4. Append the 'attempt_completed' event.
  try {
    appendAttemptEvent(
      {
        type: 'attempt_completed',
        ts: new Date().toISOString(),
        verdict: verdict.data.verdict,
      },
      {
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        attemptId: opts.attemptId,
        caller: {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      },
    );
  } catch {
    // best-effort
  }

  // 5. State transition.
  let nextState: TaskState | null = null;
  if (verdict.data.verdict === 'ready_for_review') {
    if (opts.phase === 'implement') nextState = 'ready_for_review';
    else if (opts.phase === 'review') nextState = 'reviewed';
    else if (opts.phase === 'ship') nextState = 'shipped';
  } else if (verdict.data.verdict === 'changes_needed' || verdict.data.verdict === 'blocked') {
    // Loop back to running so a re-dispatch can pick up.
    nextState = 'running';
  }
  if (nextState) {
    try {
      const state = readTaskState(opts.forgeDir, opts.taskId);
      writeTaskState(
        opts.forgeDir,
        {
          ...state,
          state: nextState,
          state_version: state.state_version + 1,
          updated_at: new Date().toISOString(),
          updated_by: {
            run_id: lease.owner_run_id,
            claim_id: lease.claim_id,
            generation: lease.generation,
          },
        },
        {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      );
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            err instanceof OrchestratorError ? err.code : 'IO_ERROR',
            err instanceof Error ? err.message : String(err),
            true,
            { hint: 'verdict written; state transition failed — run forge orchestrate gc' },
          ),
          { json: opts.json },
        ),
      };
    }
  }

  return {
    exitCode: emit(
      ok({
        verdict: verdict.data.verdict,
        next_state: nextState,
        verdict_path: verdictPath,
      }),
      { json: opts.json },
    ),
  };
}

function readLease(forgeDir: string, taskId: string): Lease {
  const leasePath = path.join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json');
  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: leasePath },
    );
  }
  const parsed = LeaseSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `lease.json schema invalid for task ${taskId}`,
      { taskId, zodError: parsed.error.message },
    );
  }
  return parsed.data;
}

export const completeHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Finalize an attempt: write verdict + transition state per (verdict, phase).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const verdictFile = parseFlag(rest, 'verdict-file') ?? '';
    const phaseFlag = parseFlag(rest, 'phase');
    const phase = (phaseFlag === 'implement' || phaseFlag === 'review' || phaseFlag === 'ship')
      ? phaseFlag
      : 'implement';
    const json = hasFlag(rest, 'json');
    return runOrchestrateComplete({ taskId, attemptId, verdictFile, phase, forgeDir, json });
  },
};
