// `forge orchestrate dispatch` — register a new worker attempt.
//
// REFUSES without a valid claim_id from a prior `claim`. Generates a new
// attempt_id (UUIDv7) and writes its manifest.json.
//
// FORGE-231 (owner decision PA — first-class phase attempts): dispatch is
// per-phase.
//   implement: from claimed | awaiting_respawn | ready_for_review (the last
//              ONLY in single-host mode — the drift re-verify path) →
//              'dispatched'; attempt_count+1. An exhausted failure budget
//              refuses (defense-in-depth; complete chains the exhaustion
//              transition itself).
//   review:    from ready_for_review, DUAL-HOST only; the task state does NOT
//              change — a pointer-CAS self-loop commits current_attempt_id +
//              review_attempt_count+1. The manifest pins BOTH review diff
//              endpoints (review_target_sha = worktree HEAD,
//              review_base_sha = origin/<frozen-base>) AT DISPATCH TIME.
//   ship:      from reviewed; pointer-CAS self-loop; ship_attempt_count+1.
// Manifest publication ordering: the manifest is written (wx) BEFORE the
// state CAS commits the pointer — a crashed dispatch leaves an orphan
// manifest, inert because the pointer never committed (gc reports).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { DispatchArgsSchema, type DispatchArgs } from '../../schemas/cli-args.ts';
import { OrchestratorError, SettingsError } from '../../core/errors.ts';
import { loadSettings } from '../../core/settings.ts';
import { AttemptManifestSchema } from '../../schemas/attempt.ts';
import { applyTransition } from '../../orchestrator/state-machine.ts';
import { readFrozenBaseBranch, readMarkerTaskId, resolveBaseRef, resolveShaChecked } from '../../orchestrator/worktree-base.ts';
import { sanitizeIssueId } from '../../core/workspace.ts';
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
import { resolveLogRotateMaxBytes } from './log-rotate-settings.ts';
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

  // 0. Settings: review dispatch requires dual-host mode; the single-host
  //    implement re-verify path requires review_host_cli === null; the failure
  //    budget cap comes from agents.retry_attempts.
  let reviewHostCli: string | null;
  let retryAttempts: number;
  try {
    const settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
    reviewHostCli = settings.agents.review_host_cli;
    retryAttempts = settings.agents.retry_attempts;
  } catch (err) {
    if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
      // Unconfigured workspace (mirrors complete's verify handling): fall back
      // to the schema defaults — dual-host with the default review host and
      // the default retry budget.
      reviewHostCli = 'codex';
      retryAttempts = 10;
    } else if (err instanceof SettingsError) {
      return { exitCode: emit(fail(err.code, err.message, false), { json: opts.json }) };
    } else {
      return {
        exitCode: emit(
          fail('IO_ERROR', err instanceof Error ? err.message : String(err), false),
          { json: opts.json },
        ),
      };
    }
  }

  // 1. Read current state and check per-phase dispatch legality.
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

  const phase = opts.phase;
  let legal = false;
  if (phase === 'implement') {
    legal =
      state.state === 'claimed' ||
      state.state === 'awaiting_respawn' ||
      // Single-host drift re-verify: a ready_for_review task re-enters
      // implement to refresh its CLI-verified head. Dual-host mode never
      // dispatches implement from ready_for_review (REVIEW owns that state).
      (state.state === 'ready_for_review' && reviewHostCli === null);
  } else if (phase === 'review') {
    legal = state.state === 'ready_for_review' && reviewHostCli !== null;
  } else {
    legal = state.state === 'reviewed';
  }
  if (!legal) {
    return {
      exitCode: emit(
        fail(
          'INVALID_STATE',
          `cannot dispatch ${phase} for task ${opts.taskId}: current state is '${state.state}'` +
            (phase === 'review' && reviewHostCli === null
              ? ' (review dispatch requires dual-host mode — agents.review_host_cli is null)'
              : ''),
          false,
          { current_state: state.state, phase },
        ),
        { json: opts.json },
      ),
    };
  }

  // Failure-budget refusal (defense-in-depth — complete chains the exhaustion
  // transition itself; a respawn/re-attempt past the budget must not start).
  if (state.state === 'awaiting_respawn' && state.failure_count >= retryAttempts) {
    return {
      exitCode: emit(
        fail(
          'INVALID_STATE',
          `cannot dispatch task ${opts.taskId}: failure budget exhausted (${state.failure_count}/${retryAttempts})`,
          false,
          { current_state: state.state, failure_count: state.failure_count, retry_attempts: retryAttempts },
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

  // FORGE-231 (impl R1 MAJ-3): dispatch is a state-advancing commit — it
  // requires an ACTIVE lease, not merely a matching identity. An hours-expired
  // worker must steal/re-acquire, never advance state on a dead claim.
  if (Date.parse(lease.expires_at) <= Date.now()) {
    return {
      exitCode: emit(
        fail(
          'LEASE_EXPIRED',
          `lease for task ${opts.taskId} expired at ${lease.expires_at} — re-acquire before dispatching`,
          false,
          { expires_at: lease.expires_at },
        ),
        { json: opts.json },
      ),
    };
  }

  // 3. For a REVIEW attempt, pin BOTH diff endpoints NOW (dispatch time) so
  //    the reviewed range can never float (R6/R8): target = the worktree
  //    HEAD under review; base = origin/<frozen-base> from the worktree
  //    marker (owner decision SB — a global default-branch refresh never
  //    retargets an existing task).
  let reviewTargetSha: string | undefined;
  let reviewBaseSha: string | undefined;
  if (phase === 'review') {
    // FORGE-231 (impl R1 MAJ-4): the pinned SHAs are only meaningful if the
    // worktree provably belongs to THIS task — otherwise a caller could pin a
    // review of task B's tree onto task A. The marker's taskId is the binding.
    let expectedMarkerId: string;
    try {
      expectedMarkerId = sanitizeIssueId(opts.taskId);
    } catch {
      expectedMarkerId = opts.taskId;
    }
    const markerTaskId = readMarkerTaskId(opts.worktreePath);
    if (markerTaskId !== expectedMarkerId) {
      return {
        exitCode: emit(
          fail(
            'INVALID_STATE',
            `cannot dispatch review for task ${opts.taskId}: worktree at ${opts.worktreePath} is bound to '${markerTaskId ?? '(no marker)'}' — the reviewed tree must be this task's own worktree`,
            false,
            { worktree_path: opts.worktreePath, marker_task_id: markerTaskId },
          ),
          { json: opts.json },
        ),
      };
    }
    const baseBranch = readFrozenBaseBranch(opts.worktreePath);
    if (baseBranch === null) {
      return {
        exitCode: emit(
          fail(
            'INVALID_STATE',
            `cannot dispatch review for task ${opts.taskId}: the worktree marker has no frozen base_branch — run forge orchestrate ensure-worktree to backfill it`,
            false,
            { worktree_path: opts.worktreePath },
          ),
          { json: opts.json },
        ),
      };
    }
    try {
      reviewTargetSha = await resolveShaChecked(opts.worktreePath, 'HEAD');
      const baseRef = await resolveBaseRef(opts.worktreePath, baseBranch);
      reviewBaseSha = await resolveShaChecked(opts.worktreePath, baseRef);
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
  }

  // 4. Mint attempt_id, validate + write the manifest atomically (wx) BEFORE
  //    the state pointer commits.
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
  const manifestCandidate = {
    version: 1,
    attempt_id: attemptId,
    task_id: opts.taskId,
    run_id: opts.runId,
    claim_id: opts.claimId,
    generation: lease.generation,
    phase,
    worktree_path: opts.worktreePath,
    dispatched_at: new Date().toISOString(),
    ...(reviewTargetSha !== undefined ? { review_target_sha: reviewTargetSha } : {}),
    ...(reviewBaseSha !== undefined ? { review_base_sha: reviewBaseSha } : {}),
  };
  const manifestParsed = AttemptManifestSchema.safeParse(manifestCandidate);
  if (!manifestParsed.success) {
    return {
      exitCode: emit(
        fail('SCHEMA_INVALID', `attempt manifest failed schema validation: ${manifestParsed.error.message}`, false),
        { json: opts.json },
      ),
    };
  }
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifestParsed.data, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to write manifest: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }

  // 5. Append the 'attempt_started' event.
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
        logRotateMaxBytes: resolveLogRotateMaxBytes(opts.forgeDir),
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

  // 6. Commit the state through the table + CAS. implement transitions to
  //    'dispatched'; review/ship are pointer-only self-loops (state unchanged,
  //    current_attempt_id + informational counter advance under the same CAS).
  const trigger =
    phase === 'implement' ? 'dispatch_implement' : phase === 'review' ? 'dispatch_review' : 'dispatch_ship';
  let nextState: TaskStateRecord['state'];
  try {
    nextState = applyTransition(state.state, trigger);
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
  try {
    writeTaskState(
      opts.forgeDir,
      {
        ...state,
        state: nextState,
        state_version: state.state_version + 1,
        attempt_count: phase === 'implement' ? state.attempt_count + 1 : state.attempt_count,
        review_attempt_count: phase === 'review' ? state.review_attempt_count + 1 : state.review_attempt_count,
        ship_attempt_count: phase === 'ship' ? state.ship_attempt_count + 1 : state.ship_attempt_count,
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

  return { exitCode: emit(ok({ attempt_id: attemptId, manifest_path: manifestPath, phase }), { json: opts.json }) };
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
