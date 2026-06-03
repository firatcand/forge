// `forge orchestrate dispatch` — register a new worker attempt.
//
// REFUSES without a valid claim_id from a prior `claim`. Generates a new
// attempt_id (UUIDv7) and writes its manifest.json. Transitions task state
// from 'claimed' (first dispatch) or 'awaiting_respawn' (resume after Q&A)
// to 'dispatched'. Emits the 'attempt_started' event.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { DispatchArgsSchema, type DispatchArgs } from '../../schemas/cli-args.ts';
import { OrchestratorError } from '../../core/errors.ts';
import {
  readTaskState,
  writeTaskState,
} from '../../orchestrator/state-machine.ts';
import { assertLeaseOwnership } from '../../orchestrator/leases.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { manifestFilePath } from '../../orchestrator/questions/paths.ts';
import type { Lease } from '../../schemas/lease.ts';
import type { TaskStateRecord } from '../../schemas/task-state.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import type { VerbHandler } from './index.ts';

export async function runOrchestrateDispatch(
  args: DispatchArgs,
): Promise<{ exitCode: number }> {
  const parsed = DispatchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // 1. Read current state — must be 'claimed' or 'awaiting_respawn'.
  let state: TaskStateRecord;
  try {
    state = readTaskState(opts.forgeDir, opts.taskId);
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
  if (state.state !== 'claimed' && state.state !== 'awaiting_respawn') {
    return {
      exitCode: emit(
        fail(
          'INVALID_STATE',
          `cannot dispatch task ${opts.taskId}: current state is '${state.state}' (expected 'claimed' or 'awaiting_respawn').`,
          false,
          { current_state: state.state },
        ),
        { json: opts.json },
      ),
    };
  }

  // 2. Validate claim_id against current lease.
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
  if (lease.claim_id !== opts.claimId || lease.owner_run_id !== opts.runId) {
    return {
      exitCode: emit(
        fail(
          'LEASE_STOLEN',
          `claim_id/run_id does not match current lease holder for task ${opts.taskId}`,
          false,
          {
            caller_claim_id: opts.claimId,
            stored_claim_id: lease.claim_id,
            caller_run_id: opts.runId,
            stored_run_id: lease.owner_run_id,
          },
        ),
        { json: opts.json },
      ),
    };
  }

  // 3. Mint attempt_id, write manifest atomically.
  const attemptId = uuidv7();
  const manifestPath = manifestFilePath(opts.forgeDir, opts.taskId, attemptId);
  try {
    mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to create attempt dir: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }
  const manifest = {
    version: 1,
    attempt_id: attemptId,
    task_id: opts.taskId,
    run_id: opts.runId,
    claim_id: opts.claimId,
    generation: lease.generation,
    phase: opts.phase,
    worktree_path: opts.worktreePath,
    dispatched_at: new Date().toISOString(),
  };
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to write manifest: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }

  // 4. Append the 'attempt_started' event.
  try {
    appendAttemptEvent(
      {
        type: 'attempt_started',
        ts: new Date().toISOString(),
        attempt_id: attemptId,
        run_id: opts.runId,
        claim_id: opts.claimId,
        generation: lease.generation,
      },
      {
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        attemptId,
        caller: callerFromLease(lease),
      },
    );
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          true,
        ),
        { json: opts.json },
      ),
    };
  }

  // 5. Transition state to 'dispatched' (state_version+1, current_attempt_id set).
  try {
    writeTaskState(
      opts.forgeDir,
      {
        ...state,
        state: 'dispatched',
        state_version: state.state_version + 1,
        attempt_count: state.attempt_count + 1,
        current_attempt_id: attemptId,
        updated_at: new Date().toISOString(),
        updated_by: {
          run_id: opts.runId,
          claim_id: opts.claimId,
          generation: lease.generation,
        },
      },
      {
        run_id: opts.runId,
        claim_id: opts.claimId,
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
        ),
        { json: opts.json },
      ),
    };
  }

  return { exitCode: emit(ok({ attempt_id: attemptId, manifest_path: manifestPath }), { json: opts.json }) };
}

// Then. assertLeaseOwnership-style fence — kept as a separate import for parity with leases.ts call sites.
// (Used inside appendAttemptEvent and writeTaskState already.)
void assertLeaseOwnership;

export const dispatchHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Register a new worker attempt (requires prior claim).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const claimId = parseFlag(rest, 'claim') ?? '';
    const runId = parseFlag(rest, 'run') ?? parseFlag(rest, 'run-id') ?? '';
    const worktreePath = parseFlag(rest, 'worktree') ?? '';
    const phaseFlag = parseFlag(rest, 'phase');
    const phase = (phaseFlag === 'implement' || phaseFlag === 'review' || phaseFlag === 'ship')
      ? phaseFlag
      : 'implement';
    const json = hasFlag(rest, 'json');
    return runOrchestrateDispatch({
      taskId,
      claimId,
      runId,
      worktreePath,
      phase,
      forgeDir,
      json,
    });
  },
};
