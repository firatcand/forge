// Lease acquire / heartbeat / steal / release for task ownership.
//
// Invariants (adapters own their own classification — FORGE-78):
// - acquire uses link(tmp, target) — never rename — so concurrent acquires
//   have exactly one winner (EEXIST on the loser). See:
//   docs/learnings/2026-Q2/link-vs-rename-for-never-overwrite-invariant.md
// - heartbeat and steal overwrite an existing file via:
//   unlink(target) → link(tmp, target) → unlink(tmp).
//   This is gated on generation/ownership validation before any I/O, making
//   it safe: only the validated holder (or steal-eligible caller) can overwrite.
// - All write paths use: write tmp → fsync → link/rename → unlink tmp.
// - TOCTOU: every fs call is wrapped in its own try/catch.
//   See: docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md
// - task_id in payload must match task_id used for path construction.
//   See: docs/learnings/2026-Q2/id-in-path-and-payload-must-agree.md
//
// OQ-6 decision: steal writes lease.json (new owner) then state.json
// (unclaimed) before returning. If state.json write fails after lease.json
// succeeds, gc reconciliation detects the divergence and completes the
// transition on next sweep.

import {
  closeSync as _closeSync,
  fsyncSync as _fsyncSync,
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  readFileSync as _readFileSync,
  renameSync as _renameSync,
  unlinkSync as _unlinkSync,
  writeSync as _writeSync,
  linkSync as _linkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { OrchestratorError } from '../core/errors.ts';
import {
  LEASE_TTL_MS_DEFAULT,
  STEAL_GRACE_MS_DEFAULT,
  LeaseSchema,
  type Lease,
} from '../schemas/lease.ts';
import {
  leaseFilePath,
  claimHistoryFilePath,
  stateFilePath,
  validateIdSegment,
} from './questions/paths.ts';
import { isNodeFsError } from './questions/errors.ts';
import { TaskStateSchema, type TaskStateRecord } from '../schemas/task-state.ts';

// Test seam — same pattern as writer.ts.
export const __leasesFsForTesting = {
  closeSync: _closeSync,
  fsyncSync: _fsyncSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  readFileSync: _readFileSync,
  renameSync: _renameSync,
  unlinkSync: _unlinkSync,
  writeSync: _writeSync,
  linkSync: _linkSync,
};
const fs = __leasesFsForTesting;

// ---- ID validation wrapper ----

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

// ---- Temp file infrastructure ----

let tempCounter = 0;

function tempName(targetPath: string): string {
  tempCounter = (tempCounter + 1) >>> 0;
  return `${targetPath}.${process.pid}.${tempCounter}.${randomBytes(8).toString('hex')}.tmp`;
}

function bestEffortUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // best-effort cleanup — never throw from cleanup
  }
}

function ensureDirectory(dir: string, taskId: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to create directory ${dir}`,
      { taskId, dir, cause: err },
    );
  }
}

function writeTempFile(tmpPath: string, payload: string, taskId: string): void {
  let fd: number;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to open temp file ${tmpPath}`,
      { taskId, path: tmpPath, cause: err },
    );
  }

  const buf = Buffer.from(payload, 'utf8');
  let primaryError: unknown;
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
      if (written === 0) {
        throw new OrchestratorError(
          'IO_ERROR',
          `writeSync returned 0 at offset ${offset} for ${tmpPath}`,
          { taskId, path: tmpPath, offset },
        );
      }
      offset += written;
    }
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      throw new OrchestratorError(
        'IO_ERROR',
        `fsync failed for ${tmpPath}`,
        { taskId, path: tmpPath, cause: err },
      );
    }
  } catch (err) {
    primaryError = err;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (closeErr) {
      if (primaryError === undefined) {
        primaryError = new OrchestratorError(
          'IO_ERROR',
          `closeSync failed for ${tmpPath}`,
          { taskId, path: tmpPath, cause: closeErr },
        );
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

// Place a temp file atomically using link (never overwrites — EEXIST on collision).
// Used only by acquire.
function placeAtomicLink(tmpPath: string, targetPath: string, taskId: string): void {
  try {
    fs.linkSync(tmpPath, targetPath);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'EEXIST') {
      throw new OrchestratorError(
        'LEASE_EXISTS',
        `Lease already exists for task ${taskId}: ${targetPath}`,
        { taskId, path: targetPath, cause: err },
      );
    }
    if (isNodeFsError(err) && (err.code === 'EPERM' || err.code === 'ENOTSUP')) {
      throw new OrchestratorError(
        'IO_ERROR',
        `Filesystem does not support hard links at ${targetPath} — .forge/ must be on a local POSIX filesystem`,
        { taskId, path: targetPath, cause: err },
      );
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `link failed: ${tmpPath} → ${targetPath}`,
      { taskId, path: targetPath, cause: err },
    );
  }
}

// Overwrite an existing file via: unlink(target) → link(tmp, target) → unlink(tmp).
// Used by heartbeat and steal. Caller must have validated ownership before calling.
function overwriteAtomicLink(tmpPath: string, targetPath: string, taskId: string): void {
  try {
    fs.unlinkSync(targetPath);
  } catch (err) {
    if (!(isNodeFsError(err) && err.code === 'ENOENT')) {
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to unlink existing file ${targetPath}`,
        { taskId, path: targetPath, cause: err },
      );
    }
    // ENOENT is fine — treat as idempotent
  }
  try {
    fs.linkSync(tmpPath, targetPath);
  } catch (err) {
    if (isNodeFsError(err) && (err.code === 'EPERM' || err.code === 'ENOTSUP')) {
      throw new OrchestratorError(
        'IO_ERROR',
        `Filesystem does not support hard links at ${targetPath} — .forge/ must be on a local POSIX filesystem`,
        { taskId, path: targetPath, cause: err },
      );
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `link failed after unlink: ${tmpPath} → ${targetPath}`,
      { taskId, path: targetPath, cause: err },
    );
  }
}

// ---- Read existing lease ----

function readLeaseFile(taskId: string, leasePath: string): Lease | null {
  let raw: string;
  try {
    raw = fs.readFileSync(leasePath, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return null;
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

  const result = LeaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Schema validation failed for lease.json of task ${taskId}`,
      { taskId, zodError: result.error.message },
    );
  }
  return result.data;
}

// ---- Append to claim-history.jsonl (best-effort) ----

function appendClaimHistory(
  forgeDir: string,
  taskId: string,
  entry: Record<string, unknown>,
): void {
  const historyPath = claimHistoryFilePath(forgeDir, taskId);
  const line = JSON.stringify(entry) + '\n';
  const buf = Buffer.from(line, 'utf8');

  let fd: number;
  try {
    fd = fs.openSync(historyPath, 'a', 0o600);
  } catch {
    return; // best-effort: don't fail the caller on history write errors
  }

  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
      if (written === 0) break;
      offset += written;
    }
  } catch {
    // best-effort
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort
    }
  }
}

// ---- Write state.json unclaimed (used by steal — OQ-6 decision) ----
// Writes state.json with state=unclaimed using rename (not link).
// If this fails after lease.json was already updated, gc reconciliation
// detects the divergence (lease=new_owner, state not yet unclaimed) and
// completes the transition on next sweep. Document the gap explicitly.

function writeStateUnclaimed(
  forgeDir: string,
  taskId: string,
  newLease: Lease,
): void {
  const statePath = stateFilePath(forgeDir, taskId);

  // Read current state to get attempt_count; if absent, start fresh.
  let currentAttemptCount = 0;
  let currentStateVersion = -1;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const res = TaskStateSchema.safeParse(parsed);
      if (res.success) {
        currentAttemptCount = res.data.attempt_count;
        currentStateVersion = res.data.state_version;
      }
    }
  } catch {
    // ENOENT or any read error — start fresh
  }

  const newStateVersion = currentStateVersion + 1;

  const unclaimed: TaskStateRecord = {
    version: 1,
    task_id: taskId,
    state: 'unclaimed',
    state_version: newStateVersion,
    attempt_count: currentAttemptCount,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: {
      run_id: newLease.owner_run_id,
      claim_id: newLease.claim_id,
      generation: newLease.generation,
    },
  };

  const payload = JSON.stringify(unclaimed);
  const tmpPath = tempName(statePath);
  const dir = dirname(statePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return; // best-effort — gc will reconcile
  }

  let fd: number;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch {
    return; // best-effort
  }

  const buf = Buffer.from(payload, 'utf8');
  let writeOk = false;
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
      if (written === 0) break;
      offset += written;
    }
    try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    writeOk = true;
  } catch {
    // best-effort
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  if (!writeOk) {
    bestEffortUnlink(tmpPath);
    return;
  }

  try {
    fs.renameSync(tmpPath, statePath);
  } catch {
    bestEffortUnlink(tmpPath);
    // gc will reconcile
  }
}

// ---- Public API ----

export interface AcquireOptions {
  forgeDir: string;
  taskId: string;
  runId: string;
  leaseTtlMs?: number;
}

export function acquire(opts: AcquireOptions): Lease {
  const { forgeDir, runId, leaseTtlMs = LEASE_TTL_MS_DEFAULT } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');

  const targetPath = leaseFilePath(forgeDir, taskId);
  ensureDirectory(dirname(targetPath), taskId);

  // Read prior lease (if any) to determine the next generation number.
  // If a lease file exists at this point, acquire fails via EEXIST on linkSync.
  // We read purely to get the generation for the record; the race is safe because
  // linkSync is the atomic gate.
  let nextGeneration = 0;
  const priorLease = readLeaseFile(taskId, targetPath);
  if (priorLease !== null) {
    // A lease exists — linkSync will fail with EEXIST and we'll throw LEASE_EXISTS.
    // Still compute generation in case a concurrent steal cleared it between read and link.
    nextGeneration = priorLease.generation + 1;
  }

  const now = Date.now();
  const lease: Lease = {
    version: 1,
    claim_id: uuidv7(),
    task_id: taskId,
    attempt_id: null,
    owner_run_id: runId,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + leaseTtlMs).toISOString(),
    last_heartbeat_at: new Date(now).toISOString(),
    generation: nextGeneration,
  };

  // id-in-path-and-payload invariant: already equal since we derived taskId from opts.taskId
  if (lease.task_id !== taskId) {
    throw new OrchestratorError(
      'INVALID_ID',
      `task_id mismatch: path=${taskId} payload=${lease.task_id}`,
      { taskId },
    );
  }

  const validation = LeaseSchema.safeParse(lease);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Lease record failed schema validation`,
      { taskId, zodError: validation.error.message },
    );
  }

  const payload = JSON.stringify(validation.data);
  const tmpPath = tempName(targetPath);

  try {
    writeTempFile(tmpPath, payload, taskId);
    placeAtomicLink(tmpPath, targetPath, taskId);
  } finally {
    bestEffortUnlink(tmpPath);
  }

  appendClaimHistory(forgeDir, taskId, {
    event: 'acquired',
    ts: new Date().toISOString(),
    claim_id: lease.claim_id,
    run_id: runId,
    generation: lease.generation,
  });

  return validation.data;
}

export interface CallerIdentity {
  run_id: string;
  claim_id: string;
  generation: number;
}

// assertLeaseOwnership is the shared fence used by all state-mutating verbs.
// Each verb that mutates attempt or task state must call this before any mutation.
// Reads lease.json, compares all three identity fields, throws LEASE_STOLEN on mismatch.
export function assertLeaseOwnership(
  forgeDir: string,
  taskId: string,
  caller: CallerIdentity,
): void {
  const leasePath = leaseFilePath(forgeDir, taskId);
  const stored = readLeaseFile(taskId, leasePath);
  if (stored === null) {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: leasePath },
    );
  }
  if (stored.claim_id !== caller.claim_id || stored.generation !== caller.generation) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Lease ownership mismatch for task ${taskId}: caller generation ${caller.generation} vs stored ${stored.generation}`,
      {
        taskId,
        stored_claim_id: stored.claim_id,
        caller_claim_id: caller.claim_id,
        stored_generation: stored.generation,
        caller_generation: caller.generation,
      },
    );
  }
}

export interface HeartbeatOptions {
  forgeDir: string;
  taskId: string;
  caller: CallerIdentity;
  leaseTtlMs?: number;
}

export function heartbeat(opts: HeartbeatOptions): Lease {
  const { forgeDir, leaseTtlMs = LEASE_TTL_MS_DEFAULT } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const { caller } = opts;

  const targetPath = leaseFilePath(forgeDir, taskId);

  // 1. Read and validate current lease.
  const stored = readLeaseFile(taskId, targetPath);
  if (stored === null) {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: targetPath },
    );
  }

  // 2. Validate ownership — throws LEASE_STOLEN on mismatch.
  if (stored.claim_id !== caller.claim_id || stored.generation !== caller.generation) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Heartbeat rejected: lease has been stolen for task ${taskId}`,
      {
        taskId,
        stored_claim_id: stored.claim_id,
        caller_claim_id: caller.claim_id,
        stored_generation: stored.generation,
        caller_generation: caller.generation,
      },
    );
  }

  // 3. Build updated lease.
  const now = Date.now();
  const updated: Lease = {
    ...stored,
    expires_at: new Date(now + leaseTtlMs).toISOString(),
    last_heartbeat_at: new Date(now).toISOString(),
  };

  const validation = LeaseSchema.safeParse(updated);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Updated lease record failed schema validation`,
      { taskId, zodError: validation.error.message },
    );
  }

  // 4. Write atomically: tmp → fsync → unlink(target) → link(tmp, target) → unlink(tmp).
  //    This is the one write path that intentionally replaces an existing file.
  //    It is gated on the ownership check above, so only the validated holder can overwrite.
  const payload = JSON.stringify(validation.data);
  const tmpPath = tempName(targetPath);
  try {
    writeTempFile(tmpPath, payload, taskId);
    overwriteAtomicLink(tmpPath, targetPath, taskId);
  } finally {
    bestEffortUnlink(tmpPath);
  }

  return validation.data;
}

export interface StealOptions {
  forgeDir: string;
  taskId: string;
  runId: string;
  leaseTtlMs?: number;
  stealGraceMs?: number;
  now?: number; // injectable for testing
}

export function steal(opts: StealOptions): Lease {
  const {
    forgeDir,
    runId,
    leaseTtlMs = LEASE_TTL_MS_DEFAULT,
    stealGraceMs = STEAL_GRACE_MS_DEFAULT,
    now: nowOverride,
  } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const targetPath = leaseFilePath(forgeDir, taskId);
  const now = nowOverride ?? Date.now();

  ensureDirectory(dirname(targetPath), taskId);

  const existing = readLeaseFile(taskId, targetPath);

  if (existing === null) {
    // No existing lease — proceed as normal acquire.
    return acquire({
      forgeDir,
      taskId,
      runId,
      leaseTtlMs,
    });
  }

  // Check if steal is eligible (past expiry + grace period).
  const expiresAt = new Date(existing.expires_at).getTime();
  if (now <= expiresAt + stealGraceMs) {
    throw new OrchestratorError(
      'LEASE_NOT_EXPIRED',
      `Lease for task ${taskId} has not expired yet (expires ${existing.expires_at}, grace ${stealGraceMs}ms)`,
      {
        taskId,
        expires_at: existing.expires_at,
        steal_grace_ms: stealGraceMs,
        now: new Date(now).toISOString(),
      },
    );
  }

  // Steal is eligible. Build new lease with incremented generation.
  const newGeneration = existing.generation + 1;
  const newLease: Lease = {
    version: 1,
    claim_id: uuidv7(),
    task_id: taskId,
    attempt_id: null,
    owner_run_id: runId,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + leaseTtlMs).toISOString(),
    last_heartbeat_at: new Date(now).toISOString(),
    generation: newGeneration,
  };

  const validation = LeaseSchema.safeParse(newLease);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `New lease record failed schema validation`,
      { taskId, zodError: validation.error.message },
    );
  }

  const payload = JSON.stringify(validation.data);
  const tmpPath = tempName(targetPath);
  try {
    writeTempFile(tmpPath, payload, taskId);
    overwriteAtomicLink(tmpPath, targetPath, taskId);
  } finally {
    bestEffortUnlink(tmpPath);
  }

  // OQ-6: write state.json = unclaimed after new lease is placed.
  // If this write fails, gc reconciles on next sweep.
  writeStateUnclaimed(forgeDir, taskId, validation.data);

  appendClaimHistory(forgeDir, taskId, {
    event: 'stolen',
    ts: new Date(now).toISOString(),
    claim_id: validation.data.claim_id,
    run_id: runId,
    generation: newGeneration,
    from_generation: existing.generation,
    from_claim_id: existing.claim_id,
  });

  return validation.data;
}

export interface ReleaseOptions {
  forgeDir: string;
  taskId: string;
  caller: CallerIdentity;
}

export function release(opts: ReleaseOptions): void {
  const { forgeDir } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const { caller } = opts;

  // Validate ownership before releasing.
  assertLeaseOwnership(forgeDir, taskId, caller);

  const targetPath = leaseFilePath(forgeDir, taskId);
  try {
    fs.unlinkSync(targetPath);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      // Already gone — idempotent release.
      return;
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to unlink lease.json for task ${taskId}`,
      { taskId, path: targetPath, cause: err },
    );
  }

  appendClaimHistory(forgeDir, taskId, {
    event: 'released',
    ts: new Date().toISOString(),
    claim_id: caller.claim_id,
    run_id: caller.run_id,
    generation: caller.generation,
  });
}
