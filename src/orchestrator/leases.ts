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
import {
  TaskStateSchema,
  TERMINAL_TASK_STATES,
  type TaskStateRecord,
  type TerminalTaskState,
} from '../schemas/task-state.ts';
import {
  computeSpecRevisionSync,
  type SpecRevisionResult,
} from './spec-diff.ts';

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

// ---- Read last claim-history.jsonl entry (used by acquire for generation continuity) ----
// Returns the last entry's generation number, or null if history is absent/empty.
// This prevents generation resetting to 0 after a release-then-reacquire cycle.
//
// Error contract:
// - ENOENT: return null (no history yet — legitimate).
// - File exists, 0 bytes: return null (legitimate edge case after first release).
// - File exists, non-empty, but zero parseable lines: throw CLAIM_HISTORY_CORRUPT.
//   Caller (acquire) must NOT silently re-use generation 0, as that would re-introduce B3.
// - Non-ENOENT read error: throw IO_ERROR.
function readLastClaimHistoryEntry(
  forgeDir: string,
  taskId: string,
): { generation: number } | null {
  const historyPath = claimHistoryFilePath(forgeDir, taskId);
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return null; // no history yet
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read claim-history.jsonl for task ${taskId}`,
      { taskId, path: historyPath, cause: err },
    );
  }

  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null; // empty file — legitimate

  // Walk backwards to find the last parseable line.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (typeof entry.generation === 'number' && Number.isInteger(entry.generation)) {
        return { generation: entry.generation };
      }
    } catch {
      // skip malformed lines
    }
  }

  // File is non-empty but contains no parseable entries. This is corruption —
  // do NOT return null (which would silently reset generation to 0 and re-introduce B3).
  throw new OrchestratorError(
    'CLAIM_HISTORY_CORRUPT',
    `claim-history.jsonl for task ${taskId} is non-empty but contains no parseable entries`,
    { taskId, path: historyPath, detail: 'no parseable entries in non-empty history file' },
  );
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
    // H3: set writeOk ONLY after fsync completes without error. Setting it
    // before fsync would allow rename to proceed on a file whose data hasn't
    // been flushed to stable storage, defeating the durability guarantee.
    try {
      fs.fsyncSync(fd);
      writeOk = true; // only set after successful fsync
    } catch { /* best-effort — gc will reconcile */ }
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
  // Pre-computed SPEC revision marker. If omitted, computeSpecRevisionSync()
  // is invoked against `repoRoot` (defaulting to dirname(forgeDir), since by
  // convention forgeDir is "<root>/.forge"). Provide explicitly when the caller
  // already computed the revision asynchronously, or for deterministic tests.
  specRevision?: SpecRevisionResult;
  repoRoot?: string;
}

export function acquire(opts: AcquireOptions): Lease {
  const { forgeDir, runId, leaseTtlMs = LEASE_TTL_MS_DEFAULT } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const repoRoot = opts.repoRoot ?? dirname(forgeDir);
  const specRevision =
    opts.specRevision ?? computeSpecRevisionSync(repoRoot);

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
  } else {
    // B3: No lease file — but there may be history from a prior release.
    // Use last history entry's generation + 1 to prevent reset to 0 after
    // a release-then-reacquire cycle. Only use 0 if this is truly the first ever acquire.
    const lastHistory = readLastClaimHistoryEntry(forgeDir, taskId);
    if (lastHistory !== null) {
      nextGeneration = lastHistory.generation + 1;
    }
    // else: nextGeneration stays 0 (genuine first acquire — no history file)
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
    spec_revision: specRevision.revision,
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
// Reads lease.json, compares all three identity fields (run_id, claim_id, generation),
// throws LEASE_STOLEN on mismatch.
//
// H1: run_id is included in the comparison. A process with the correct claim_id
// and generation but a different run_id indicates a forged or replayed caller —
// treat as a stolen lease.
//
// TWIN: assertLeaseOwnershipFromFile in state-machine.ts is an intentional
// duplicate (avoids circular dependency). Any change to the comparison logic
// here MUST be mirrored there. Search for "TWIN" to locate it.
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
  if (
    stored.claim_id !== caller.claim_id ||
    stored.generation !== caller.generation ||
    stored.owner_run_id !== caller.run_id
  ) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Lease ownership mismatch for task ${taskId}: caller generation ${caller.generation} vs stored ${stored.generation}`,
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
  // H1: include run_id in the comparison (same logic as assertLeaseOwnership).
  if (
    stored.claim_id !== caller.claim_id ||
    stored.generation !== caller.generation ||
    stored.owner_run_id !== caller.run_id
  ) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Heartbeat rejected: lease has been stolen for task ${taskId}`,
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

  // B1 — Verify-after-write: re-read lease.json immediately after overwrite and
  // confirm the written (claim_id, generation, owner_run_id) is still present. A concurrent
  // steal that unlinked our file between our unlink and our link would have won
  // and replaced the file with a new generation. If the re-read disagrees with
  // what we wrote, surface LEASE_STOLEN so the caller can abort safely.
  // Fix 3: include owner_run_id in the mismatch condition for consistency with
  // the 3-field comparison used at all H1 sites (assertLeaseOwnership, heartbeat
  // initial check, assertLeaseOwnershipFromFile).
  const reread = readLeaseFile(taskId, targetPath);
  if (
    reread === null ||
    reread.claim_id !== validation.data.claim_id ||
    reread.generation !== validation.data.generation ||
    reread.owner_run_id !== validation.data.owner_run_id
  ) {
    throw new OrchestratorError(
      'LEASE_STOLEN',
      `Lease was stolen concurrently during heartbeat for task ${taskId}`,
      {
        taskId,
        from_generation: caller.generation,
        stored_generation: reread?.generation ?? null,
        stored_run_id: reread?.owner_run_id ?? null,
        reason: 'concurrent_steal_after_heartbeat_write',
      },
    );
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
  // Pre-computed SPEC revision marker for the new claim. See AcquireOptions.specRevision.
  specRevision?: SpecRevisionResult;
  repoRoot?: string;
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
  const repoRoot = opts.repoRoot ?? dirname(forgeDir);
  const specRevision =
    opts.specRevision ?? computeSpecRevisionSync(repoRoot);

  ensureDirectory(dirname(targetPath), taskId);

  const existing = readLeaseFile(taskId, targetPath);

  if (existing === null) {
    // No existing lease — proceed as normal acquire. Forward the resolved
    // specRevision so the steal-as-acquire path doesn't recompute (and so
    // tests passing a sentinel via steal() see the same value on the lease).
    return acquire({
      forgeDir,
      taskId,
      runId,
      leaseTtlMs,
      specRevision,
      repoRoot,
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
    spec_revision: specRevision.revision,
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

  // Fix 1 (steal verify-before-write): re-read lease.json just before overwrite to
  // close the race where heartbeat refreshes the lease after our eligibility check
  // but before our write. If the lease has changed since we judged it stealable,
  // the holder has been actively renewed and we must not silently un-renew them.
  //
  // Residual window: a nanosecond gap remains between this re-read and the
  // unlink+link in overwriteAtomicLink. Closing it fully requires OS-level file
  // locking (e.g., flock(2)) which is out of scope for local-FS use. This check
  // closes the practically significant race (heartbeat completing between
  // readLeaseFile and overwriteAtomicLink) and is the accepted trade-off.
  //
  // Defense-in-depth: even if the nanosecond race fires, every downstream state
  // mutation (writeTaskState, appendAttemptEvent, heartbeat, release) calls
  // assertLeaseOwnership which reads fresh from disk and throws LEASE_STOLEN if
  // generation/claim_id/run_id have advanced. A silently-stolen holder cannot
  // corrupt state — they fail-fast on their next mutation. Follow-up: optional
  // flock-based hardening tracked separately as a Phase 3 ticket.
  const preWriteLease = readLeaseFile(taskId, targetPath);
  if (
    preWriteLease === null ||
    preWriteLease.claim_id !== existing.claim_id ||
    preWriteLease.generation !== existing.generation ||
    preWriteLease.owner_run_id !== existing.owner_run_id ||
    preWriteLease.expires_at !== existing.expires_at
  ) {
    throw new OrchestratorError(
      'LEASE_NOT_EXPIRED',
      `Lease for task ${taskId} was refreshed between eligibility check and write — concurrent heartbeat renewed it`,
      {
        taskId,
        reason: 'concurrent_heartbeat_renewed_lease',
        detail: 'lease was refreshed after eligibility check',
        judged_expires_at: existing.expires_at,
        current_expires_at: preWriteLease?.expires_at ?? null,
      },
    );
  }

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

// ---- adminReleaseLeaseByIdentity (gc-only — identity-gated, NOT ownership-bypassing) ----
//
// Used by `src/orchestrator/gc.ts` for divergence-table rows 13 and 14 (per
// spec/ORCHESTRATOR.md §"gc reconciliation rules"). The caller (planner)
// captures the exact identity of the lease file it intends to delete during
// snapshot; the executor (this function) re-reads at unlink time and confirms.
// Identity mismatch → LEASE_IDENTITY_MISMATCH. State-guard mismatch (row 14) →
// LEASE_STATE_NOT_TERMINAL. Never silently no-op.
//
// SAFETY: this primitive does NOT require caller ownership of the lease (gc has
// no lease for the orphan it is releasing), but it requires the caller to have
// observed the lease's exact identity in a recent snapshot. The fresh on-disk
// re-read ensures we don't unlink a lease that was concurrently renewed via
// heartbeat — generation/claim_id/owner_run_id would have advanced.
//
// Only `src/orchestrator/gc.ts` should import this symbol.

export type AdminReleaseReason =
  | 'gc:row-13:duplicate'    // older-generation duplicate lease file
  | 'gc:row-14:terminal-state'; // canonical lease present but task state is terminal

export interface AdminReleaseByIdentityOptions {
  forgeDir: string;
  taskId: string;
  // Exact identity of the lease file the caller intends to delete.
  expectedClaimId: string;
  expectedGeneration: number;
  expectedOwnerRunId: string;
  // The lease's expires_at AT SNAPSHOT TIME. heartbeat() preserves
  // (claim_id, generation, owner_run_id) — only expires_at and
  // last_heartbeat_at change — so without this field a heartbeat firing
  // between snapshot and unlink would silently bypass identity detection and
  // we'd unlink a live, freshly-renewed lease. (Codex 3rd-pass BLOCK 1.)
  expectedExpiresAt: string;
  // Exact file path. For row 14 this is the canonical lease path; for row 13 a
  // non-canonical duplicate (e.g., `lease.json.<bak>`) — the function will read
  // and unlink whatever file lives at this path.
  expectedPath: string;
  // When true (row 14), also re-read state.json at the canonical state path
  // and confirm state ∈ TERMINAL_TASK_STATES before unlink. State is re-read
  // IMMEDIATELY before unlink to minimise the state-check → unlink TOCTOU
  // window. (Codex 3rd-pass BLOCK 1.)
  requireTerminalState: boolean;
  reason: AdminReleaseReason;
}

export function adminReleaseLeaseByIdentity(
  opts: AdminReleaseByIdentityOptions,
): void {
  const { forgeDir, expectedPath, requireTerminalState, reason } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');

  // 1. Read the lease at the exact expected path. Use readLeaseFile to validate
  //    schema. If absent, treat as idempotent success — another gc pass may
  //    have already cleaned up.
  let storedLease: Lease | null;
  try {
    storedLease = readLeaseFile(taskId, expectedPath);
  } catch (err) {
    if (err instanceof OrchestratorError) throw err;
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read lease at ${expectedPath} for admin release`,
      { taskId, path: expectedPath, cause: err },
    );
  }
  if (storedLease === null) {
    // Already gone — idempotent. Do not append a history event for a no-op.
    return;
  }

  // 2. Identity check — all FOUR fields must match. expires_at catches
  //    heartbeat-renewals that preserve (claim_id, generation, owner_run_id)
  //    but change expires_at. Without this check, a heartbeat firing between
  //    snapshot and unlink would slip through identity validation and we'd
  //    unlink an actively-renewed lease. (Codex 3rd-pass BLOCK 1.)
  if (
    storedLease.claim_id !== opts.expectedClaimId ||
    storedLease.generation !== opts.expectedGeneration ||
    storedLease.owner_run_id !== opts.expectedOwnerRunId ||
    storedLease.expires_at !== opts.expectedExpiresAt
  ) {
    throw new OrchestratorError(
      'LEASE_IDENTITY_MISMATCH',
      `Lease at ${expectedPath} for task ${taskId} does not match expected identity (possible concurrent heartbeat)`,
      {
        taskId,
        path: expectedPath,
        expected_claim_id: opts.expectedClaimId,
        expected_generation: opts.expectedGeneration,
        expected_owner_run_id: opts.expectedOwnerRunId,
        expected_expires_at: opts.expectedExpiresAt,
        stored_claim_id: storedLease.claim_id,
        stored_generation: storedLease.generation,
        stored_owner_run_id: storedLease.owner_run_id,
        stored_expires_at: storedLease.expires_at,
        reason,
      },
    );
  }

  // 3. For row 14: re-read state.json at the canonical state path and confirm
  //    state is terminal. Mismatch (e.g., concurrent transition back to running)
  //    must abort the unlink.
  if (requireTerminalState) {
    const statePath = stateFilePath(forgeDir, taskId);
    let stateRaw: string;
    try {
      stateRaw = fs.readFileSync(statePath, 'utf8');
    } catch (err) {
      if (isNodeFsError(err) && err.code === 'ENOENT') {
        // No state.json means we cannot confirm terminal — refuse.
        throw new OrchestratorError(
          'LEASE_STATE_NOT_TERMINAL',
          `Cannot confirm terminal state for task ${taskId}: state.json absent`,
          { taskId, path: statePath, reason },
        );
      }
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to read state.json for terminal-state guard on task ${taskId}`,
        { taskId, path: statePath, cause: err },
      );
    }
    let stateParsed: unknown;
    try {
      stateParsed = JSON.parse(stateRaw);
    } catch (err) {
      throw new OrchestratorError(
        'SCHEMA_INVALID',
        `state.json for task ${taskId} contains invalid JSON during admin release`,
        { taskId, path: statePath, cause: err },
      );
    }
    const stateValidation = TaskStateSchema.safeParse(stateParsed);
    if (!stateValidation.success) {
      throw new OrchestratorError(
        'SCHEMA_INVALID',
        `state.json for task ${taskId} failed schema validation during admin release`,
        { taskId, path: statePath, zodError: stateValidation.error.message },
      );
    }
    const currentState = stateValidation.data.state;
    if (!isTerminalTaskState(currentState)) {
      throw new OrchestratorError(
        'LEASE_STATE_NOT_TERMINAL',
        `Refusing admin release: task ${taskId} state '${currentState}' is not terminal`,
        {
          taskId,
          path: statePath,
          current_state: currentState,
          terminal_states: TERMINAL_TASK_STATES,
          reason,
        },
      );
    }
  }

  // 4. Verify-before-unlink: re-read the lease ONE more time immediately
  //    before unlink. This is defense-in-depth on top of the identity check
  //    at step 2 — if a heartbeat refreshed the lease between step 2 and now,
  //    expires_at will have advanced. We cannot fully close the unlink-then-
  //    re-link race (would need flock or equivalent), but this check
  //    eliminates the most common observable window. Same shape as the
  //    "Fix 1 (steal verify-before-write)" pattern in steal() above.
  //    (Codex 3rd-pass BLOCK 1.)
  const finalLease = readLeaseFile(taskId, expectedPath);
  if (finalLease === null) {
    return; // raced with another unlinker — benign
  }
  if (
    finalLease.claim_id !== opts.expectedClaimId ||
    finalLease.generation !== opts.expectedGeneration ||
    finalLease.owner_run_id !== opts.expectedOwnerRunId ||
    finalLease.expires_at !== opts.expectedExpiresAt
  ) {
    throw new OrchestratorError(
      'LEASE_IDENTITY_MISMATCH',
      `Lease at ${expectedPath} for task ${taskId} was modified between identity check and unlink (concurrent heartbeat)`,
      {
        taskId,
        path: expectedPath,
        reason,
        detail: 'verify-before-unlink check failed',
      },
    );
  }

  // 4b. For row 14: re-read state.json IMMEDIATELY before unlink and re-
  //     confirm terminal state. complete.ts can transition state from a
  //     terminal value back to 'running' (e.g., on changes_requested) so a
  //     stale terminal check is not safe. (Codex 3rd-pass BLOCK 1 — row 14
  //     state-check-to-unlink window.)
  if (requireTerminalState) {
    const statePath = stateFilePath(forgeDir, taskId);
    let stateRaw: string;
    try {
      stateRaw = fs.readFileSync(statePath, 'utf8');
    } catch (err) {
      if (isNodeFsError(err) && err.code === 'ENOENT') {
        throw new OrchestratorError(
          'LEASE_STATE_NOT_TERMINAL',
          `State for task ${taskId} disappeared between snapshot and unlink`,
          { taskId, reason },
        );
      }
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to re-read state.json for task ${taskId} during admin release`,
        { taskId, cause: err, reason },
      );
    }
    const stateParsed = TaskStateSchema.safeParse(JSON.parse(stateRaw));
    if (!stateParsed.success || !isTerminalTaskState(stateParsed.data.state)) {
      throw new OrchestratorError(
        'LEASE_STATE_NOT_TERMINAL',
        `Refusing admin release: task ${taskId} state '${stateParsed.success ? stateParsed.data.state : 'invalid'}' is not terminal (re-check before unlink)`,
        {
          taskId,
          current_state: stateParsed.success ? stateParsed.data.state : null,
          reason,
        },
      );
    }
  }

  // 5. Unlink. ENOENT is benign (idempotent re-run after partial failure).
  try {
    fs.unlinkSync(expectedPath);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return; // already gone — idempotent
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to unlink lease at ${expectedPath} for task ${taskId}`,
      { taskId, path: expectedPath, cause: err, reason },
    );
  }

  // 6. Record the admin release in claim-history.jsonl with the reason. This
  //    is the audit trail — any unexpected admin_released event in a production
  //    run is a bug to investigate.
  appendClaimHistory(forgeDir, taskId, {
    event: 'admin_released',
    ts: new Date().toISOString(),
    claim_id: opts.expectedClaimId,
    run_id: opts.expectedOwnerRunId,
    generation: opts.expectedGeneration,
    reason,
    path: expectedPath,
  });
}

function isTerminalTaskState(state: string): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

// ---- Lease health classification (read-only; used by the dashboard verb) ----
//
// Grace runs AFTER expiry, mirroring steal eligibility in steal() above
// (`now > expires_at + grace`). A lease is:
//   - alive:         now < expires_at
//   - expiring_soon: expires_at <= now <= expires_at + stealGraceMs
//                    (expired, in the grace window, not yet stealable)
//   - stale:         now > expires_at + stealGraceMs (stealable / orphaned) —
//                    also when expires_at is unparseable.
// Pure: no I/O. stealGraceMs defaults to STEAL_GRACE_MS_DEFAULT; settings.agents
// has no steal_grace field, so there is no override source to consult.
export type LeaseHealth = 'alive' | 'expiring_soon' | 'stale';

export function classifyLeaseHealth(
  expiresAt: string,
  now: Date,
  stealGraceMs: number = STEAL_GRACE_MS_DEFAULT,
): LeaseHealth {
  const exp = new Date(expiresAt).getTime();
  if (Number.isNaN(exp)) return 'stale';
  const t = now.getTime();
  if (t < exp) return 'alive';
  if (t <= exp + stealGraceMs) return 'expiring_soon';
  return 'stale';
}
