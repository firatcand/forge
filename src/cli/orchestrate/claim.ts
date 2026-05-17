// `forge orchestrate claim` — atomic tracker claim + local lease acquire.
//
// State transition: unclaimed → claimed.
//
// Atomic semantics (spec §State machine / §Lease semantics):
//   1. Read current task state. Must be 'unclaimed' (or absent — initial).
//   2. tracker.claim(taskId, runId). On {ok:false} → REFUSE with ALREADY_CLAIMED.
//   3. leases.acquire({forgeDir, taskId, runId}). On LEASE_EXISTS →
//      tracker.releaseClaim(taskId, runId) (best-effort rollback); REFUSE with
//      LEASE_CONFLICT.
//   4. writeTaskState({ task_id, state: 'claimed', state_version: 0, ... }).
//   5. Return ok({ claim_id, expires_at, generation }).
//
// Caller (the dispatch skill) MUST have user approval before invoking claim;
// per spec the verb itself does not prompt — that's the skill's job.

import path from 'node:path';

import { ClaimArgsSchema, type ClaimArgs } from '../../schemas/cli-args.ts';
import { acquire, release as releaseLease } from '../../orchestrator/leases.ts';
import {
  writeTaskState,
  readTaskState,
} from '../../orchestrator/state-machine.ts';
import type { TaskStateRecord } from '../../schemas/task-state.ts';
import { OrchestratorError } from '../../core/errors.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import {
  resolveTrackerForCLI,
  type ClaimableTracker,
} from './tracker-factory.ts';
import type { SpecRevisionResult } from '../../orchestrator/spec-diff.ts';
import type { VerbHandler } from './index.ts';

export interface ClaimDeps {
  readonly tracker?: ClaimableTracker;
  // Test seam: allow callers to override the spec_revision passed to acquire().
  readonly specRevision?: SpecRevisionResult;
  readonly repoRoot?: string;
}

export async function runOrchestrateClaim(
  args: ClaimArgs,
  deps: ClaimDeps = {},
): Promise<{ exitCode: number }> {
  const parsed = ClaimArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // Pre-flight: task state must be 'unclaimed' or absent.
  try {
    const state = readTaskState(opts.forgeDir, opts.taskId);
    if (state.state !== 'unclaimed') {
      return {
        exitCode: emit(
          fail(
            'INVALID_STATE',
            `cannot claim task ${opts.taskId}: current state is '${state.state}' (expected 'unclaimed').`,
            false,
            { current_state: state.state },
          ),
          { json: opts.json },
        ),
      };
    }
  } catch (err) {
    // STATE_NOT_FOUND is the initial-write happy path. Re-throw anything else.
    if (!(err instanceof OrchestratorError) || err.code !== 'STATE_NOT_FOUND') {
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
  }

  // Resolve tracker (injected for tests, NoopTracker for bootstrap, real one elsewhere).
  let t: ClaimableTracker;
  if (deps.tracker) {
    t = deps.tracker;
  } else {
    const resolved = resolveTrackerOrFail(opts);
    if ('error' in resolved) {
      return { exitCode: emit(resolved.error, { json: opts.json }) };
    }
    t = resolved.tracker;
  }

  // 1. Tracker claim.
  let claimRes;
  try {
    claimRes = await t.claim(opts.taskId, opts.runId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'TRACKER_ERROR',
          `tracker.claim failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        ),
        { json: opts.json },
      ),
    };
  }
  if (!claimRes.ok) {
    return {
      exitCode: emit(
        fail(
          mapClaimReasonToCode(claimRes.reason),
          `tracker refused claim: ${claimRes.reason}${claimRes.detail ? ` (${claimRes.detail})` : ''}`,
          claimRes.reason === 'transient_error',
        ),
        { json: opts.json },
      ),
    };
  }

  // 2. Acquire local lease.
  let lease;
  try {
    lease = acquire({
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      runId: opts.runId,
      ...(deps.specRevision ? { specRevision: deps.specRevision } : {}),
      ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : { repoRoot: path.dirname(opts.forgeDir) }),
    });
  } catch (err) {
    // Rollback tracker (best-effort).
    try {
      await t.releaseClaim(opts.taskId, opts.runId);
    } catch {
      // best-effort
    }
    if (err instanceof OrchestratorError && err.code === 'LEASE_EXISTS') {
      return {
        exitCode: emit(
          fail(
            'LEASE_CONFLICT',
            `lease already held for task ${opts.taskId}; tracker claim rolled back`,
            true,
          ),
          { json: opts.json },
        ),
      };
    }
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

  // 3. Transition state to 'claimed'.
  const stateRecord: TaskStateRecord = {
    version: 1,
    task_id: opts.taskId,
    state: 'claimed',
    state_version: 0,
    attempt_count: 0,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: {
      run_id: opts.runId,
      claim_id: lease.claim_id,
      generation: lease.generation,
    },
  };
  try {
    writeTaskState(opts.forgeDir, stateRecord, {
      run_id: opts.runId,
      claim_id: lease.claim_id,
      generation: lease.generation,
    });
  } catch (err) {
    // Codex 2nd-pass: rollback explicitly so the next claim doesn't see a
    // dangling lease + tracker claim. Without this, the failure mode is
    // "claim returns error envelope, but the next claim sees ALREADY_CLAIMED
    // from tracker and LEASE_EXISTS locally". gc has a row for the missing-
    // state case but assumes the lease is also gone. We undo what we can
    // before reporting the failure.
    const rollbackErrors: string[] = [];
    try {
      releaseLease({
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        caller: {
          run_id: opts.runId,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      });
    } catch (rbErr) {
      rollbackErrors.push(`lease release: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
    try {
      await t.releaseClaim(opts.taskId, opts.runId);
    } catch (rbErr) {
      rollbackErrors.push(`tracker release: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          true,
          rollbackErrors.length > 0
            ? { rolled_back: false, rollback_errors: rollbackErrors, hint: 'partial rollback failed — run forge orchestrate gc to reconcile' }
            : { rolled_back: true, hint: 'state write failed; tracker claim + local lease rolled back; safe to retry' },
        ),
        { json: opts.json },
      ),
    };
  }

  return {
    exitCode: emit(
      ok({
        claim_id: lease.claim_id,
        generation: lease.generation,
        expires_at: lease.expires_at,
      }),
      { json: opts.json },
    ),
  };
}

function mapClaimReasonToCode(reason: string): string {
  switch (reason) {
    case 'already_claimed':
      return 'ALREADY_CLAIMED';
    case 'version_conflict':
      return 'VERSION_CONFLICT';
    case 'transient_error':
      return 'TRACKER_TRANSIENT_ERROR';
    default:
      return 'TRACKER_ERROR';
  }
}

function resolveTrackerOrFail(opts: ClaimArgs):
  | { tracker: ClaimableTracker }
  | { error: ReturnType<typeof fail> } {
  const result = resolveTrackerForCLI(opts.forgeDir);
  if (!result.ok) {
    return {
      error: fail(result.code, result.message, false),
    };
  }
  return { tracker: result.tracker };
}

export const claimHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Atomically claim a task (tracker + local lease).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const runId = parseFlag(rest, 'run') ?? parseFlag(rest, 'run-id') ?? '';
    const json = hasFlag(rest, 'json');
    return runOrchestrateClaim({
      taskId,
      runId,
      forgeDir,
      json,
    });
  },
};
