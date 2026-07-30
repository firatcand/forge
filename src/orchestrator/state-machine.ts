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
import { casGuardedWrite, type CasHolderIdentity } from '../core/fs-atomic.ts';
import { parseLeaseFile } from '../schemas/lease.ts';
import { TaskStateSchema, type TaskState, type TaskStateRecord } from '../schemas/task-state.ts';
import { stateFilePath, leaseFilePath, validateIdSegment } from './questions/paths.ts';
import { isNodeFsError } from './questions/errors.ts';
// FORGE-235: the promotion fence re-reads BOTH durable artifacts under the
// marker, so the caller's argument is never the authority. Neither module
// imports this one — no cycle.
import { readMergeAttestation, sameAttestationIdentity } from './reconciliation-record.ts';
import { readShipRecord } from './ship-record.ts';
import type { MergeAttestation } from '../schemas/merge-attestation.ts';

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
  | 'question_answered_ship'            // FORGE-234: ship park resolved retry_ship → reviewed
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
  // FORGE-234: SHIP policy park — a reviewed task parks durably instead of
  // looping (plan v3 Δ11); resolution is phase-aware (question_answered_ship).
  'reviewed:question_written': 'blocked_on_question',
  'blocked_on_question:question_answered_ship': 'reviewed',
  // FORGE-234: a cancel_task park answer cancels WHILE STILL blocked; a
  // same-attempt ORPHAN park (question published, transition crashed) may be
  // cancelled directly from reviewed (impl-R3 MAJ #2 repair path).
  'blocked_on_question:cancel': 'cancelled',
  'reviewed:cancel': 'cancelled',
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
  // FORGE-234: pre-push drift (worktree HEAD or PR head ≠ reviewed SHA) is a
  // NO-FAULT regression — re-enter verify + review, no budget consumption.
  'reviewed:head_drift': 'ready_for_review',
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
  if (result.success && result.data.task_id !== taskId) {
    // Path↔payload binding (FORGE-235): a state file copied or restored under
    // ANOTHER task's directory must never be adopted as this task's state —
    // otherwise a promotion could ship a task on a different task's evidence.
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `state.json under task ${taskId} declares task_id ${result.data.task_id}`,
      { taskId, path },
    );
  }
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
  // FORGE-231 (impl R2 MAJ-2): verbs whose commits require an ACTIVE lease
  // (complete, dispatch) pass requireActiveLease so expiry is re-checked
  // UNDER the state marker — an entry-time check alone is TOCTOU-prone when
  // verification runs for minutes. Recovery writers (gc) keep identity-only.
  //
  // FORGE-231 (impl R5): expectedCurrentAttemptId fences the commit against
  // the CURRENT state's current_attempt_id UNDER the marker. A phase
  // completion (review/ship) that ran while a superseding attempt dispatched
  // must not advance the task on behalf of a pointer that has moved on.
  opts: { requireActiveLease?: boolean; expectedCurrentAttemptId?: string; expectedStateVersion?: number } = {},
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
      fence: () => {
        assertLeaseOwnershipFromFile(forgeDir, taskId, caller);
        if (opts.requireActiveLease) {
          assertLeaseUnexpiredFromFile(forgeDir, taskId);
        }
        if (opts.expectedCurrentAttemptId !== undefined || opts.expectedStateVersion !== undefined) {
          // Re-read the CURRENT state under marker ownership. buildContent
          // runs on the same post-acquire read, so a superseding dispatch
          // cannot slip between.
          let current: { current_attempt_id: string | null; state_version: number };
          try {
            current = readTaskState(forgeDir, taskId);
          } catch (err) {
            throw new OrchestratorError(
              'STATE_NOT_FOUND',
              `cannot verify current attempt for task ${taskId}`,
              { taskId, cause: err },
            );
          }
          if (opts.expectedCurrentAttemptId !== undefined && current.current_attempt_id !== opts.expectedCurrentAttemptId) {
            throw new OrchestratorError(
              'STALE_ATTEMPT',
              `attempt '${opts.expectedCurrentAttemptId}' was superseded by '${current.current_attempt_id ?? 'none'}' before its commit landed — a superseded phase attempt must not advance the task`,
              { taskId, expected: opts.expectedCurrentAttemptId, actual: current.current_attempt_id ?? null },
            );
          }
          // FORGE-234 (impl R1 MAJ #1): the SHIP success commit pins the
          // ADMITTED state version INSIDE the marker-held fence — a park/
          // answer round-trip (V → V+2) with every other identity intact
          // must invalidate the stale receipt at the final CAS.
          if (opts.expectedStateVersion !== undefined && current.state_version !== opts.expectedStateVersion) {
            throw new OrchestratorError(
              'STALE_ATTEMPT',
              `state version moved to ${current.state_version} (expected ${opts.expectedStateVersion}) before the commit landed — the admitting invocation was invalidated`,
              { taskId, expected: opts.expectedStateVersion, actual: current.state_version },
            );
          }
        }
      },
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

// FORGE-231 (impl R2 MAJ-2): expiry companion to the identity TWIN below —
// reads the CANONICAL lease and requires expires_at to be in the future.
// Tombstone/absent surfaces through assertLeaseOwnershipFromFile first.
export function assertLeaseUnexpiredFromFile(forgeDir: string, taskId: string): void {
  const leasePath = leaseFilePath(forgeDir, taskId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  } catch (err) {
    throw new OrchestratorError('LEASE_NOT_FOUND', `lease.json unreadable for task ${taskId}`, {
      taskId,
      cause: err,
    });
  }
  const record = parseLeaseFile(parsed);
  if (record.kind !== 'active') {
    throw new OrchestratorError('LEASE_NOT_FOUND', `no active lease for task ${taskId}`, { taskId });
  }
  if (Date.parse(record.lease.expires_at) <= Date.now()) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `lease for task ${taskId} expired at ${record.lease.expires_at} — a commit requires an ACTIVE lease`,
      { taskId, expires_at: record.lease.expires_at },
    );
  }
}

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

// ─── FORGE-235: the ONE constrained merge-reconciliation authority ───────────

function promotionStateVersion(raw: string): number {
  const parsed = JSON.parse(raw) as { state_version?: unknown };
  if (typeof parsed?.state_version !== 'number' || !Number.isInteger(parsed.state_version)) {
    throw new OrchestratorError('SCHEMA_INVALID', 'state.json has no integer state_version', {});
  }
  return parsed.state_version;
}

// The evidence contract for `merge_pending → shipped`: a VALID durable
// attestation that is the same witness as the caller's, and a live ship record
// still carrying the binding the proof was read against. Shared by the CAS
// fence and the already-shipped resume path so neither can drift from the other.
function verifyDurableProof(forgeDir: string, taskId: string, attestation: MergeAttestation): void {
  const durable = readMergeAttestation(forgeDir, taskId);
  if (durable.kind !== 'valid') {
    throw new OrchestratorError(
      'MERGE_PROOF_MISSING',
      `merge promotion requires a valid durable attestation (${durable.kind === 'invalid' ? durable.detail : 'absent'})`,
      { taskId },
    );
  }
  if (!sameAttestationIdentity(durable.attestation, attestation)) {
    throw new OrchestratorError('MERGE_PROOF_MISMATCH', `the durable attestation for ${taskId} is a different witness`, {
      taskId,
    });
  }
  const record = readShipRecord(forgeDir, taskId);
  if (
    record === null ||
    record.revision !== attestation.ship_record_revision ||
    record.reviewed_head_sha !== attestation.reviewed_head_sha ||
    record.cycle !== attestation.cycle ||
    record.pr === null ||
    record.pr.repo !== attestation.pr.repo ||
    record.pr.number !== attestation.pr.number ||
    record.base === null ||
    record.base.repo !== attestation.base_repo ||
    record.base.branch !== attestation.base_branch
  ) {
    throw new OrchestratorError('STATE_VERSION_CONFLICT', `ship record binding moved during merge promotion`, { taskId });
  }
}

// `commitMergePromotion` is the ONLY task-state write FORGE-235 performs, and
// the ONLY lease-free writer in the codebase. Its narrowness is the safety
// property (plan v5 Δ9/Δ17):
//
//  * destination is FIXED — `merge_pending → shipped` via `merge_confirmed`.
//    There is no `next`-state parameter, so no caller can request an arbitrary
//    transition without merge proof;
//  * the caller's argument is NOT the authority: the DURABLE attestation file
//    is re-read and every binding field compared, so a fabricated in-memory
//    object cannot promote anything. `writeMergeAttestation` mints that file
//    only from an exact live `mergeResult` proof (ORCHESTRATOR:880 preserved);
//  * the live ship record is re-read too — a binding that moved after the proof
//    (new PR, new reviewed head, advanced revision) refuses;
//  * all of it is re-validated UNDER the state CAS marker — a marker is never
//    held across network I/O, so a stale observation cannot commit;
//  * a LIVE worker lease means a crash leftover: refuse (LEASE_EXISTS) and let
//    gc row 15 release it, rather than reconciling under someone's ownership.
export function commitMergePromotion(
  forgeDir: string,
  taskId: string,
  attestation: MergeAttestation,
  holder: CasHolderIdentity,
): number {
  if (attestation.task_id !== taskId) {
    throw new OrchestratorError('SCHEMA_INVALID', `attestation task_id ${attestation.task_id} != ${taskId}`, { taskId });
  }
  const observed = readTaskState(forgeDir, taskId);
  if (observed.state !== 'merge_pending' && observed.state !== 'shipped') {
    throw new OrchestratorError(
      'ILLEGAL_TRANSITION',
      `merge promotion is legal only from merge_pending (task is '${observed.state}')`,
      { taskId },
    );
  }
  if (observed.state === 'shipped') {
    // Resume no-op — but NOT an unchecked one. The caller treats a successful
    // return as authorization to sync the tracker, so the same durable evidence
    // the promotion path requires must still hold.
    verifyDurableProof(forgeDir, taskId, attestation);
    return observed.state_version;
  }

  const next = applyTransition(observed.state, 'merge_confirmed');
  const payloadState: TaskStateRecord = {
    ...observed,
    state: next,
    state_version: observed.state_version + 1,
    updated_at: new Date().toISOString(),
    updated_by: { run_id: holder.run_id, claim_id: holder.claim_id, generation: holder.generation },
  };
  const payload = JSON.stringify(TaskStateSchema.parse(payloadState), null, 2);

  // casGuardedWrite wraps ANY non-CasError thrown by the fence into
  // CasError('io'), which would flatten the fence's typed refusals into a
  // generic CAS conflict. The refusal reason is load-bearing here — the merge
  // tick routes LEASE_EXISTS to "defer to gc row 15" — so the fence records it
  // in a box and we re-throw the original after unwinding.
  const refusal: { err: OrchestratorError | null } = { err: null };
  const refuse = (err: OrchestratorError): never => {
    refusal.err = err;
    throw err;
  };

  try {
    casGuardedWrite({
      filePath: stateFilePath(forgeDir, taskId),
      expectedVersion: observed.state_version,
      holder,
      readVersion: promotionStateVersion,
      fence: () => {
        // A live (non-tombstone, unexpired) worker lease → defer to gc row 15.
        const parsed = readLeaseFileOrNull(forgeDir, taskId);
        if (parsed !== null && parsed.kind === 'active' && Date.parse(parsed.lease.expires_at) > Date.now()) {
          refuse(new OrchestratorError('LEASE_EXISTS', `task ${taskId} still holds a live worker lease`, { taskId }));
        }
        // The DURABLE artifacts are the authority, not the argument.
        try {
          verifyDurableProof(forgeDir, taskId, attestation);
        } catch (err) {
          refuse(err as OrchestratorError);
        }
        // Re-validate the observation's identity UNDER the marker.
        const live = readTaskState(forgeDir, taskId);
        if (live.state !== 'merge_pending' || live.state_version !== observed.state_version) {
          refuse(new OrchestratorError('STALE_ATTEMPT', `task ${taskId} moved during merge promotion`, { taskId }));
        }
        if (live.current_attempt_id !== observed.current_attempt_id) {
          refuse(new OrchestratorError('STALE_ATTEMPT', `attempt pointer moved during merge promotion`, { taskId }));
        }
      },
      buildContent: () => payload,
    });
  } catch (err) {
    if (refusal.err !== null) throw refusal.err;
    if (err instanceof OrchestratorError) throw err;
    if (err instanceof CasError) {
      throw new OrchestratorError('STATE_VERSION_CONFLICT', `merge promotion lost the state CAS for ${taskId}`, {
        taskId,
        cause: err,
      });
    }
    throw err;
  }
  return payloadState.state_version;
}

// Lease read that never throws for the promotion fence: absent/tombstoned/
// invalid all mean "no live worker".
function readLeaseFileOrNull(
  forgeDir: string,
  taskId: string,
): ReturnType<typeof parseLeaseFile> | null {
  try {
    const raw = _readFileSync(leaseFilePath(forgeDir, taskId), 'utf8');
    return parseLeaseFile(JSON.parse(raw));
  } catch {
    return null;
  }
}
