import {
  closeSync as _closeSync,
  fsyncSync as _fsyncSync,
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  readFileSync as _readFileSync,
  renameSync as _renameSync,
  unlinkSync as _unlinkSync,
  writeSync as _writeSync,
} from 'node:fs';
import { CasError, OrchestratorError } from '../core/errors.ts';
import { casGuardedWrite } from '../core/fs-atomic.ts';
import { parseLeaseFile } from '../schemas/lease.ts';
import { TaskStateSchema, type TaskState, type TaskStateRecord } from '../schemas/task-state.ts';
import { stateFilePath, leaseFilePath, validateIdSegment } from './questions/paths.ts';
import { isNodeFsError } from './questions/errors.ts';

// Test seam — same pattern as writer.ts. Tests use mock.method to override.
export const __smFsForTesting = {
  closeSync: _closeSync,
  fsyncSync: _fsyncSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  readFileSync: _readFileSync,
  renameSync: _renameSync,
  unlinkSync: _unlinkSync,
  writeSync: _writeSync,
};
const fs = __smFsForTesting;

// ---- Transition table ----
// Keyed as `${from}:${trigger}` → to. Only legal moves are listed.
// Triggers match the verb names used in the CLI (FORGE-20). Any (from, trigger)
// pair not in this table is illegal and throws ILLEGAL_TRANSITION.

export type TransitionTrigger =
  | 'claim'
  | 'dispatch'
  | 'first_heartbeat'
  | 'question_written'
  | 'answer_recorded'
  | 'complete_ready_for_review'
  | 'review_passed'
  | 'lease_expired'
  | 'steal'
  | 'cancel'
  | 'retries_exhausted'
  | 'changes_requested'
  // FORGE-231 (spec/ORCHESTRATOR.md §Phase 3 + §failure accounting):
  | 'changes_needed'                    // implement/review failure (composed vocabulary)
  | 'blocked'                           // composed blocked outcome → question semantics
  | 'ship_op_completed'                 // ship side effects submitted → async merge wait
  | 'merge_confirmed'                   // RepoHost.mergeResult() proof → shipped
  | 'head_drift'                        // PR head ≠ reviewed SHA → back to review
  | 'pr_closed_unmerged'                // PR closed without merging → park
  | 'probe_or_policy_loss'              // honesty probe / policy revoked → park
  | 'implement_verified_single_host'    // single-host direct path (no review hop)
  | 'ship_failed'                       // ship attempt failure (budget consumed)
  | 'dispatch_implement'                // per-phase dispatch legality (owner decision PA)
  | 'dispatch_review'                   // pointer-only self-loop (state unchanged)
  | 'dispatch_ship';                    // pointer-only self-loop (state unchanged)

type TransitionKey = `${TaskState}:${TransitionTrigger}`;

const TRANSITION_TABLE: Readonly<Partial<Record<TransitionKey, TaskState>>> = {
  'unclaimed:claim': 'claimed',
  'claimed:dispatch': 'dispatched',
  'dispatched:first_heartbeat': 'running',
  'running:question_written': 'blocked_on_question',
  'ready_for_review:question_written': 'blocked_on_question',
  'blocked_on_question:answer_recorded': 'awaiting_respawn',
  'awaiting_respawn:dispatch': 'dispatched',
  'running:complete_ready_for_review': 'ready_for_review',
  'ready_for_review:review_passed': 'reviewed',
  'running:lease_expired': 'abandoned',
  'dispatched:lease_expired': 'abandoned',
  'blocked_on_question:lease_expired': 'abandoned',
  'abandoned:steal': 'unclaimed',
  'running:cancel': 'cancelled',
  'claimed:cancel': 'cancelled',
  'dispatched:cancel': 'cancelled',
  'running:retries_exhausted': 'failed',
  // FORGE-231 — failure lifecycle (single total budget; every failure path
  // ends in a DISPATCHABLE or terminal state; the pre-FORGE-231
  // ready_for_review:changes_requested → running stranded the task because
  // dispatch is not legal from running):
  'ready_for_review:changes_requested': 'awaiting_respawn',
  'ready_for_review:changes_needed': 'awaiting_respawn',
  'running:changes_needed': 'awaiting_respawn',
  'running:blocked': 'blocked_on_question',
  'reviewed:ship_failed': 'reviewed',
  'awaiting_respawn:retries_exhausted': 'failed',
  'reviewed:retries_exhausted': 'failed',
  // FORGE-231 — merge_pending lifecycle (ADR orchestrator-ship-auto-merge):
  // ship side effects are submitted, the PLATFORM merge is the only proof.
  'reviewed:ship_op_completed': 'merge_pending',
  'merge_pending:merge_confirmed': 'shipped',
  'merge_pending:head_drift': 'ready_for_review',
  'merge_pending:pr_closed_unmerged': 'blocked_on_question',
  'merge_pending:probe_or_policy_loss': 'blocked_on_question',
  'merge_pending:cancel': 'cancelled',
  // FORGE-231 — single-host direct path (owner decision SH): CLI-verified
  // implement head becomes the reviewed binding; no ready_for_review hop.
  'running:implement_verified_single_host': 'reviewed',
  'ready_for_review:implement_verified_single_host': 'reviewed',
  // FORGE-231 — per-phase dispatch legality (owner decision PA). REVIEW/SHIP
  // dispatches are pointer-only self-loops: the task state does not change,
  // only current_attempt_id (committed through the same state CAS).
  'claimed:dispatch_implement': 'dispatched',
  'awaiting_respawn:dispatch_implement': 'dispatched',
  'ready_for_review:dispatch_implement': 'dispatched',
  'ready_for_review:dispatch_review': 'ready_for_review',
  'reviewed:dispatch_ship': 'reviewed',
} as const;

// FORGE-231: table-driven transition application. Verbs that mutate task
// state derive the TO-state from the table instead of hardcoding it, so the
// table stops being documentation-only for every path this ticket touches.
// Throws ILLEGAL_TRANSITION when no row exists for (from, trigger).
export function applyTransition(from: TaskState, trigger: TransitionTrigger): TaskState {
  const key: TransitionKey = `${from}:${trigger}`;
  const to = TRANSITION_TABLE[key];
  if (to === undefined) {
    throw new OrchestratorError(
      'ILLEGAL_TRANSITION',
      `Illegal transition: no row for ${from} --[${trigger}]--> ?`,
      { from, trigger, expected: null },
    );
  }
  return to;
}

export function assertLegalTransition(
  from: TaskState,
  to: TaskState,
  trigger: TransitionTrigger,
): void {
  const key: TransitionKey = `${from}:${trigger}`;
  const expected = TRANSITION_TABLE[key];
  if (expected === undefined || expected !== to) {
    throw new OrchestratorError(
      'ILLEGAL_TRANSITION',
      `Illegal transition: ${from} --[${trigger}]--> ${to}`,
      { from, to, trigger, expected: expected ?? null },
    );
  }
}

// ---- State.json read/write ----

function validateOrchestratorId(id: string, fieldName: string): string {
  try {
    return validateIdSegment(id, fieldName);
  } catch {
    throw new OrchestratorError(
      'INVALID_ID',
      `${fieldName} failed segment validation: "${id}"`,
      { fieldName, value: id },
    );
  }
}

export function readTaskState(
  forgeDir: string,
  taskId: string,
): TaskStateRecord {
  validateOrchestratorId(taskId, 'taskId');
  const path = stateFilePath(forgeDir, taskId);

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      throw new OrchestratorError(
        'STATE_NOT_FOUND',
        `state.json not found for task ${taskId}`,
        { taskId, path },
      );
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read state.json for task ${taskId}`,
      { taskId, path, cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Invalid JSON in state.json for task ${taskId}`,
      { taskId, path, cause: err },
    );
  }

  const result = TaskStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Schema validation failed for state.json of task ${taskId}`,
      { taskId, path, zodError: result.error.message },
    );
  }
  return result.data;
}

export interface StateCaller {
  run_id: string;
  claim_id: string;
  generation: number;
}

export function writeTaskState(
  forgeDir: string,
  state: TaskStateRecord,
  caller: StateCaller,
): void {
  // 1. Validate path/payload task_id agreement (id-in-path-and-payload learning).
  validateOrchestratorId(state.task_id, 'task_id');
  const taskId = state.task_id;

  // 2. Fast-fail lease ownership check. Identity-only (no expiry) — verbs that
  //    additionally require an UNEXPIRED lease (complete/dispatch commits)
  //    assert that themselves; recovery writers (gc row 2) legitimately write
  //    under an expired-but-identity-matching lease. The same check re-runs as
  //    the CAS fence below, under marker ownership.
  assertLeaseOwnershipFromFile(forgeDir, taskId, caller);

  // 3. Stamp and validate the record BEFORE entering the guarded write.
  const stamped: TaskStateRecord = {
    ...state,
    updated_by: {
      run_id: caller.run_id,
      claim_id: caller.claim_id,
      generation: caller.generation,
    },
    updated_at: new Date().toISOString(),
  };
  const validation = TaskStateSchema.safeParse(stamped);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `State record failed schema validation for task ${taskId}`,
      { taskId, zodError: validation.error.message },
    );
  }
  const payload = JSON.stringify(validation.data);

  // 4. FORGE-231: the write is a casGuardedWrite version transition. The
  //    caller's record carries state_version V; V === 0 is initial creation
  //    (the 'create' domain — distinct from the numeric 0→1 marker), V > 0
  //    guards the (V-1)→V transition. The mandatory post-acquire re-read makes
  //    a stale caller (whose V-1 read was overtaken) fail typed instead of
  //    silently losing an update — the pre-FORGE-231 read-check-rename here
  //    was not atomic (R6 CRIT-2).
  const targetPath = stateFilePath(forgeDir, taskId);
  const expectedVersion: number | 'create' =
    state.state_version === 0 ? 'create' : state.state_version - 1;

  const readStateVersion = (raw: string): number => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // H2: non-parseable bytes are corruption — never treated as absent.
      throw new OrchestratorError(
        'SCHEMA_INVALID',
        `state.json for task ${taskId} contains invalid JSON (corruption detected)`,
        { taskId, path: targetPath, cause: parseErr },
      );
    }
    const v = (parsed as { state_version?: unknown }).state_version;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      // Fail-closed: an unversioned file cannot participate in CAS; recovery
      // is a manual/gc concern, never a silent overwrite.
      throw new OrchestratorError(
        'SCHEMA_INVALID',
        `state.json for task ${taskId} has no integer state_version`,
        { taskId, path: targetPath },
      );
    }
    return v;
  };

  try {
    casGuardedWrite({
      filePath: targetPath,
      expectedVersion,
      holder: {
        run_id: caller.run_id,
        claim_id: caller.claim_id,
        generation: caller.generation,
      },
      readVersion: readStateVersion,
      fence: () => assertLeaseOwnershipFromFile(forgeDir, taskId, caller),
      buildContent: () => payload,
    });
  } catch (err) {
    // Unwrap OrchestratorErrors thrown by the reader/fence inside the guard.
    if (err instanceof OrchestratorError) throw err;
    if (err instanceof CasError) {
      if (err.cause instanceof OrchestratorError) throw err.cause;
      if (err.code === 'cas_conflict' || err.code === 'version_conflict') {
        throw new OrchestratorError(
          'STATE_VERSION_CONFLICT',
          `state_version conflict for task ${taskId}: transition to ${state.state_version} is ${err.code === 'cas_conflict' ? 'reserved by another writer' : 'stale'}`,
          { taskId, actual: state.state_version, cause: err },
        );
      }
      if (err.code === 'lease_lost') {
        throw new OrchestratorError(
          'LEASE_STOLEN',
          `Lease ownership lost while writing state for task ${taskId}`,
          { taskId, cause: err },
        );
      }
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to write state.json for task ${taskId}: ${err.message}`,
        { taskId, cause: err },
      );
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to write state.json for task ${taskId}`,
      { taskId, cause: err },
    );
  }
}

// ---- Lease ownership assertion (used by writeTaskState + leases.ts) ----
// Reads lease.json and asserts caller matches stored (run_id, claim_id, generation).
// Exported so leases.ts can import and reuse without circular dependency.
//
// H1: run_id is included in the comparison — see same logic in leases.ts
// assertLeaseOwnership.
// TWIN: assertLeaseOwnership in leases.ts is an intentional duplicate (avoids
// circular dependency). Any change to the comparison logic here MUST be mirrored
// there. Search for "TWIN" to locate it.

export function assertLeaseOwnershipFromFile(
  forgeDir: string,
  taskId: string,
  caller: StateCaller,
): void {
  const leasePath = leaseFilePath(forgeDir, taskId);
  let raw: string;
  try {
    raw = fs.readFileSync(leasePath, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      throw new OrchestratorError(
        'LEASE_NOT_FOUND',
        `lease.json not found for task ${taskId}`,
        { taskId, path: leasePath },
      );
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read lease.json for task ${taskId}`,
      { taskId, path: leasePath, cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Invalid JSON in lease.json for task ${taskId}`,
      { taskId, path: leasePath, cause: err },
    );
  }

  const record = parseLeaseFile(parsed);
  if (record.kind === 'released') {
    // FORGE-231: a release tombstone is not an active lease — same outcome as
    // an absent file (mirrors leases.ts assertLeaseOwnership via readLeaseFile).
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease for task ${taskId} is released (tombstone) — task is not claimed`,
      { taskId, path: leasePath },
    );
  }
  if (record.kind === 'invalid') {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Schema validation failed for lease.json of task ${taskId}`,
      { taskId, zodError: record.error },
    );
  }

  const stored = record.lease;
  if (
    stored.claim_id !== caller.claim_id ||
    stored.generation !== caller.generation ||
    stored.owner_run_id !== caller.run_id
  ) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Lease ownership mismatch for task ${taskId}: caller generation ${caller.generation} vs stored generation ${stored.generation}`,
      {
        taskId,
        stored_claim_id: stored.claim_id,
        caller_claim_id: caller.claim_id,
        stored_generation: stored.generation,
        caller_generation: caller.generation,
        stored_run_id: stored.owner_run_id,
        caller_run_id: caller.run_id,
      },
    );
  }
}
