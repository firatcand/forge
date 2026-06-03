// `forge orchestrate cancel` — terminate a task, release lease, preserve worktree.
//
// Legal from any non-terminal state: claimed / dispatched / running /
// blocked_on_question / awaiting_respawn. Marks the task state 'cancelled'
// (terminal), appends 'attempt_cancelled' event if there's a current attempt,
// and releases the lease so the next claim attempt can proceed.

import { CancelArgsSchema, type CancelArgs } from '../../schemas/cli-args.ts';
import {
  readTaskState,
  writeTaskState,
} from '../../orchestrator/state-machine.ts';
import { release as releaseLease } from '../../orchestrator/leases.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import type { Lease } from '../../schemas/lease.ts';
import { OrchestratorError } from '../../core/errors.ts';
import type { TaskState } from '../../schemas/task-state.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import {
  resolveTrackerForCLI,
  type ClaimableTracker,
} from './tracker-factory.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import type { VerbHandler } from './index.ts';

export interface CancelDeps {
  // Test seam: inject a tracker instead of resolving one from settings.yaml.
  readonly tracker?: ClaimableTracker;
}

const CANCELLABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
]);

export async function runOrchestrateCancel(
  args: CancelArgs,
  deps: CancelDeps = {},
): Promise<{ exitCode: number }> {
  const parsed = CancelArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // 1. Read state.
  let state;
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
  if (!CANCELLABLE_STATES.has(state.state)) {
    return {
      exitCode: emit(
        fail(
          'INVALID_STATE',
          `cannot cancel task ${opts.taskId}: state is '${state.state}' (terminal or not yet claimed).`,
          false,
          { current_state: state.state },
        ),
        { json: opts.json },
      ),
    };
  }

  // 2. Read lease for caller identity (so state write + lease release pass ownership).
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

  // 3. Append 'attempt_cancelled' event if there's a current attempt.
  if (state.current_attempt_id) {
    try {
      appendAttemptEvent(
        {
          type: 'attempt_cancelled',
          ts: new Date().toISOString(),
          reason: opts.reason ?? 'user-initiated cancel',
        },
        {
          forgeDir: opts.forgeDir,
          taskId: opts.taskId,
          attemptId: state.current_attempt_id,
          caller: callerFromLease(lease),
        },
      );
    } catch {
      // best-effort
    }
  }

  // 4. Transition to 'cancelled' (terminal).
  try {
    writeTaskState(
      opts.forgeDir,
      {
        ...state,
        state: 'cancelled',
        state_version: state.state_version + 1,
        updated_at: new Date().toISOString(),
        updated_by: {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      },
      callerFromLease(lease),
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

  // 5. Release lease (idempotent).
  try {
    releaseLease({
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      caller: callerFromLease(lease),
    });
  } catch {
    // Best-effort lease release; state is already cancelled which is the source of truth.
  }

  // 6. Best-effort: strip the forge:claim footer from the tracker issue. The
  //    lease is gone; a lingering footer would make gc see tracker-claim-
  //    without-local-lease divergence. Never fail the cancel on tracker error.
  await stripClaimFence(opts, deps);

  return {
    exitCode: emit(
      ok({ state: 'cancelled', released_lease: true, reason: opts.reason ?? null }),
      { json: opts.json },
    ),
  };
}

// Resolve a tracker (injected or from settings.yaml) and clear the forge:claim
// footer best-effort. Swallows every failure (warns to stderr) — the cancel has
// already committed; footer cleanup is advisory. Tears down the tracker
// transport (Notion MCP child) in a finally.
async function stripClaimFence(opts: CancelArgs, deps: CancelDeps): Promise<void> {
  let t: ClaimableTracker;
  let close: (() => Promise<void>) | undefined;
  if (deps.tracker) {
    t = deps.tracker;
  } else {
    const resolved = resolveTrackerForCLI(opts.forgeDir);
    if (!resolved.ok) {
      process.stderr.write(
        `warning: cancel could not resolve a tracker to clear the forge:claim footer (${resolved.code}); continuing\n`,
      );
      return;
    }
    t = resolved.tracker;
    close = resolved.close;
  }
  try {
    await t.setClaimFence(opts.taskId, null);
  } catch (err) {
    // Truncate untrusted tracker error text (FORGE-167 review: sec L2).
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    process.stderr.write(
      `warning: setClaimFence(null) failed for ${opts.taskId} on cancel (tracker footer not cleared): ${detail}\n`,
    );
  } finally {
    if (close) {
      try {
        await close();
      } catch {
        // best-effort teardown of the tracker transport (Notion MCP child)
      }
    }
  }
}

export const cancelHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Cancel a task: state → cancelled (terminal), release lease, preserve worktree.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const reason = parseFlag(rest, 'reason');
    const json = hasFlag(rest, 'json');
    return runOrchestrateCancel({
      taskId,
      forgeDir,
      json,
      ...(reason ? { reason } : {}),
    });
  },
};
