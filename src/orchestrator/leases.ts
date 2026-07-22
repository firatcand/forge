// Lease acquire / heartbeat / steal / release for task ownership.
//
// FORGE-231: every lease.json mutation is a casGuardedWrite version transition
// on the monotonic `lease_version` field (see core/fs-atomic.ts for the
// marker protocol). Invariants:
// - lease.json is NEVER deleted after its first acquisition — release writes a
//   ReleasedLeaseTombstone instead, so `lease_version` (and via
//   `last_generation`, the generation sequence) survives ownership cycles.
// - An ABSENT lease file with claim history is a LEGACY state (pre-FORGE-231
//   release, or adminReleaseLeaseByIdentity, both of which unlink) — acquire
//   derives the next generation from claim history in that case (R8 CRIT-1);
//   only no-file-AND-no-history starts at generation 0.
// - steal is the two-file protocol from spec/ORCHESTRATOR.md §Leases: RESERVE
//   the state.json transition marker first (a held marker aborts the steal —
//   no lease publish), then commit the successor lease, then the unclaimed
//   state under the reserved marker. Lock order is STATE before LEASE for any
//   path taking both.
// - task_id in payload must match task_id used for path construction.
//   See: docs/learnings/2026-Q2/id-in-path-and-payload-must-agree.md
//
// adminReleaseLeaseByIdentity intentionally KEEPS unlink semantics (it removes
// duplicate/orphaned lease artifacts, identity-gated); the resulting
// absent-with-history state is fully supported by acquire's legacy path.

import {
  closeSync as _closeSync,
  fsyncSync as _fsyncSync,
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  readFileSync as _readFileSync,
  renameSync as _renameSync,
  statSync as _statSync,
  unlinkSync as _unlinkSync,
  writeSync as _writeSync,
  linkSync as _linkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { CasError, OrchestratorError } from '../core/errors.ts';
import {
  acquireCasMarker,
  casGuardedWrite,
  type HeldCasMarker,
  cleanupCompletedCasMarkers,
  commitUnderCasMarker,
  releaseCasMarker,
} from '../core/fs-atomic.ts';
import {
  LEASE_TTL_MS_DEFAULT,
  STEAL_GRACE_MS_DEFAULT,
  LeaseFileSchema,
  LeaseSchema,
  type Lease,
  type LeaseFileRecord,
  type ReleasedLeaseTombstone,
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
import {
  LOG_ROTATE_MAX_BYTES_DEFAULT,
  rotateIfNeeded,
} from './jsonl-rotate.ts';

// Test seam — same pattern as writer.ts.
export const __leasesFsForTesting = {
  closeSync: _closeSync,
  fsyncSync: _fsyncSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  readFileSync: _readFileSync,
  renameSync: _renameSync,
  statSync: _statSync,
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

// ---- Read existing lease (discriminated: active | released tombstone) ----

// FORGE-231 (R8 MAJ-2): the full read contract. Callers that mean "is this
// task actively leased?" use readLeaseFile below, which maps a tombstone to
// null — a tombstone is version/generation HISTORY, never an active lease.
export function readLeaseRecord(taskId: string, leasePath: string): LeaseFileRecord | null {
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

  const result = LeaseFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Schema validation failed for lease.json of task ${taskId}`,
      { taskId, zodError: result.error.message },
    );
  }
  if ('status' in result.data && result.data.status === 'released') {
    return { kind: 'released', tombstone: result.data };
  }
  return { kind: 'active', lease: result.data as Lease };
}

// Active-lease view: tombstone and absence both read as null.
function readLeaseFile(taskId: string, leasePath: string): Lease | null {
  const record = readLeaseRecord(taskId, leasePath);
  if (record === null || record.kind === 'released') return null;
  return record.lease;
}

// casGuardedWrite version extractor for lease.json — both variants carry
// lease_version (legacy active leases default to 1 via the schema).
function leaseVersionOf(raw: string): number {
  const parsed = LeaseFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError('SCHEMA_INVALID', 'lease.json failed schema validation during CAS read', {
      zodError: parsed.error.message,
    });
  }
  return parsed.data.lease_version;
}

// Map CasError codes to this module's typed error surface.
function translateLeaseCasError(
  err: unknown,
  taskId: string,
  operation: 'acquire' | 'heartbeat' | 'release' | 'steal',
): never {
  if (err instanceof OrchestratorError) throw err;
  if (err instanceof CasError) {
    if (err.code === 'cas_conflict') {
      throw new OrchestratorError(
        operation === 'acquire' ? 'LEASE_EXISTS' : 'LEASE_CONTENDED',
        `Concurrent ${operation} on task ${taskId}: lease transition marker is held`,
        { taskId, operation, cause: err },
      );
    }
    if (err.code === 'version_conflict') {
      // acquire: the file appeared/changed → effectively "lease exists".
      // steal: the judged lease mutated (heartbeat renewal, another steal…) —
      //   the caller must re-evaluate eligibility → LEASE_CONTENDED.
      // heartbeat/release: our own lease advanced without us → stolen.
      const code =
        operation === 'acquire' ? 'LEASE_EXISTS' : operation === 'steal' ? 'LEASE_CONTENDED' : 'LEASE_STOLEN';
      throw new OrchestratorError(
        code,
        `Lease for task ${taskId} changed concurrently during ${operation}`,
        { taskId, operation, cause: err },
      );
    }
    if (err.code === 'lease_lost') {
      throw new OrchestratorError(
        'LEASE_STOLEN',
        `Lease ownership lost during ${operation} for task ${taskId}`,
        { taskId, operation, cause: err },
      );
    }
    throw new OrchestratorError('IO_ERROR', `Lease ${operation} failed for task ${taskId}: ${err.message}`, {
      taskId,
      operation,
      cause: err,
    });
  }
  throw new OrchestratorError('IO_ERROR', `Lease ${operation} failed for task ${taskId}`, {
    taskId,
    operation,
    cause: err,
  });
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
// Outcome of scanning ONE history file for its last parseable generation.
type HistoryScan =
  | { kind: 'found'; generation: number }
  | { kind: 'absent' } // ENOENT
  | { kind: 'empty' } // file exists, 0 parseable-eligible lines
  | { kind: 'unparseable' }; // non-empty, but no parseable entry

// Read + scan a single claim-history file. Throws IO_ERROR on a non-ENOENT
// read failure; otherwise classifies the outcome for the caller's fallback.
function scanClaimHistoryFile(
  path: string,
  taskId: string,
): HistoryScan {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return { kind: 'absent' };
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read claim-history.jsonl for task ${taskId}`,
      { taskId, path, cause: err },
    );
  }

  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { kind: 'empty' };

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (
        typeof entry.generation === 'number' &&
        Number.isInteger(entry.generation)
      ) {
        return { kind: 'found', generation: entry.generation };
      }
    } catch {
      // skip malformed lines
    }
  }
  return { kind: 'unparseable' };
}

function readLastClaimHistoryEntry(
  forgeDir: string,
  taskId: string,
): { generation: number } | null {
  const historyPath = claimHistoryFilePath(forgeDir, taskId);

  // FORGE-85: generation continuity across rotation is the correctness case.
  // Scan the CURRENT file first; if it is ENOENT, EMPTY, or has no parseable
  // entry, fall back to the rotated `.1` (the last generation may live there
  // when a rotation just happened). A non-perfect snapshot is acceptable: a
  // rotation racing between the two reads still yields *a* generation, never a
  // RESET (which would re-introduce B3).
  const current = scanClaimHistoryFile(historyPath, taskId);
  if (current.kind === 'found') return { generation: current.generation };

  // Current is absent/empty/unparseable — consult the rotated generation.
  const rotated = scanClaimHistoryFile(`${historyPath}.1`, taskId);
  if (rotated.kind === 'found') return { generation: rotated.generation };

  // Neither file has a parseable entry.
  // - Both absent/empty → no history yet (legitimate; generation starts at 0).
  // - Either file non-empty with no parseable entry → corruption: do NOT
  //   return null (that would silently reset generation to 0 and re-introduce
  //   B3).
  if (current.kind === 'unparseable' || rotated.kind === 'unparseable') {
    throw new OrchestratorError(
      'CLAIM_HISTORY_CORRUPT',
      `claim-history.jsonl for task ${taskId} is non-empty but contains no parseable entries`,
      {
        taskId,
        path: historyPath,
        detail: 'no parseable entries in non-empty history file (current or .1)',
      },
    );
  }
  return null;
}

// ---- Append to claim-history.jsonl (best-effort) ----

function appendClaimHistory(
  forgeDir: string,
  taskId: string,
  entry: Record<string, unknown>,
  // FORGE-85: soft-rotation threshold. These deep call sites have no settings
  // access, so the schema default is the fallback (plan: wiring stays minimal).
  logRotateMaxBytes: number = LOG_ROTATE_MAX_BYTES_DEFAULT,
): void {
  const historyPath = claimHistoryFilePath(forgeDir, taskId);
  const line = JSON.stringify(entry) + '\n';
  const buf = Buffer.from(line, 'utf8');

  // FORGE-85: soft-rotate BEFORE the append. STAYS BEST-EFFORT — a rotation
  // failure is swallowed exactly like this writer's write failures, so it never
  // fails the claim. (Contrast appendAttemptEvent, which surfaces.)
  try {
    rotateIfNeeded(historyPath, logRotateMaxBytes, fs);
  } catch {
    // best-effort: rotation failure must not fail the claim
  }

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

// ---- State-file helpers for the steal path (§C4 two-file protocol) ----

// Version extractor for state.json used by the steal reserve. Only the
// monotonic state_version matters for CAS serialization; writeTaskState owns
// full schema validation.
function stateVersionOf(raw: string): number {
  const parsed = JSON.parse(raw) as { state_version?: unknown };
  if (typeof parsed?.state_version !== 'number' || !Number.isInteger(parsed.state_version)) {
    throw new OrchestratorError('SCHEMA_INVALID', 'state.json has no integer state_version', {});
  }
  return parsed.state_version;
}

// Build the unclaimed state record a successful steal commits (OQ-6). Derives
// ONLY from the post-acquire read held by the reserved marker.
function buildUnclaimedPayload(taskId: string, currentRaw: string | null, newLease: Lease): string {
  let currentAttemptCount = 0;
  let currentStateVersion = -1;
  // FORGE-231: the failure budget + informational counters survive a steal —
  // a steal is an ownership transfer, not a failure.
  let currentFailureCount = 0;
  let currentLastFailureKey: string | null = null;
  let currentReviewAttempts = 0;
  let currentShipAttempts = 0;
  if (currentRaw !== null) {
    try {
      const res = TaskStateSchema.safeParse(JSON.parse(currentRaw));
      if (res.success) {
        currentAttemptCount = res.data.attempt_count;
        currentStateVersion = res.data.state_version;
        currentFailureCount = res.data.failure_count;
        currentLastFailureKey = res.data.last_failure_key;
        currentReviewAttempts = res.data.review_attempt_count;
        currentShipAttempts = res.data.ship_attempt_count;
      } else {
        // state_version was CAS-validated; preserve it even when the full
        // record fails schema validation (gc reports the divergence).
        currentStateVersion = stateVersionOf(currentRaw);
      }
    } catch {
      // unreadable current state — fall through to a fresh record
    }
  }
  const unclaimed: TaskStateRecord = {
    version: 1,
    task_id: taskId,
    state: 'unclaimed',
    state_version: currentStateVersion + 1,
    attempt_count: currentAttemptCount,
    failure_count: currentFailureCount,
    last_failure_key: currentLastFailureKey,
    review_attempt_count: currentReviewAttempts,
    ship_attempt_count: currentShipAttempts,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: {
      run_id: newLease.owner_run_id,
      claim_id: newLease.claim_id,
      generation: newLease.generation,
    },
  };
  return JSON.stringify(unclaimed);
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
  // FORGE-118: soft-rotation threshold for claim-history.jsonl, sourced from
  // agents.log_rotate_max_bytes by the CLI caller. Omitted → schema default.
  logRotateMaxBytes?: number;
}

export function acquire(opts: AcquireOptions): Lease {
  const { forgeDir, runId, leaseTtlMs = LEASE_TTL_MS_DEFAULT } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const repoRoot = opts.repoRoot ?? dirname(forgeDir);
  const specRevision =
    opts.specRevision ?? computeSpecRevisionSync(repoRoot);

  const targetPath = leaseFilePath(forgeDir, taskId);

  // Acquisition mode from the current lease file:
  // - ACTIVE lease present → LEASE_EXISTS (steal is the expired-lease path);
  // - tombstone → numeric CAS on its lease_version; generation continues from
  //   last_generation (written atomically at release — authoritative);
  // - absent + claim history → LEGACY (pre-FORGE-231 release / admin release):
  //   create-domain CAS; generation continues from history (R8 CRIT-1);
  // - absent + no history → genuine first acquire; generation 0.
  const record = readLeaseRecord(taskId, targetPath);
  if (record?.kind === 'active') {
    throw new OrchestratorError(
      'LEASE_EXISTS',
      `Lease already exists for task ${taskId}: ${targetPath}`,
      { taskId, path: targetPath },
    );
  }

  let expectedVersion: number | 'create';
  let nextGeneration: number;
  if (record?.kind === 'released') {
    expectedVersion = record.tombstone.lease_version;
    nextGeneration = record.tombstone.last_generation + 1;
  } else {
    expectedVersion = 'create';
    const lastHistory = readLastClaimHistoryEntry(forgeDir, taskId);
    nextGeneration = lastHistory !== null ? lastHistory.generation + 1 : 0;
  }

  const now = Date.now();
  const claimId = uuidv7();
  const makeLease = (generation: number, leaseVersion: number): Lease => ({
    version: 1,
    claim_id: claimId,
    task_id: taskId,
    attempt_id: null,
    owner_run_id: runId,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + leaseTtlMs).toISOString(),
    last_heartbeat_at: new Date(now).toISOString(),
    generation,
    spec_revision: specRevision.revision,
    lease_version: leaseVersion,
  });

  let placed: Lease | undefined;
  try {
    casGuardedWrite({
      filePath: targetPath,
      expectedVersion,
      holder: { run_id: runId, claim_id: claimId, generation: nextGeneration },
      readVersion: leaseVersionOf,
      buildContent: (raw) => {
        // Derive from the POST-ACQUIRE read. On the tombstone path the version
        // pin makes the content stable, but never trust the pre-read.
        let candidate: Lease;
        if (raw !== null) {
          const current = LeaseFileSchema.safeParse(JSON.parse(raw));
          if (!current.success || !('status' in current.data && current.data.status === 'released')) {
            throw new CasError('lease_lost', `lease.json for ${taskId} is not a release tombstone during re-acquire`);
          }
          candidate = makeLease(current.data.last_generation + 1, current.data.lease_version + 1);
        } else {
          candidate = makeLease(nextGeneration, 1);
        }
        const validation = LeaseSchema.safeParse(candidate);
        if (!validation.success) {
          throw new OrchestratorError(
            'SCHEMA_INVALID',
            `Lease record failed schema validation`,
            { taskId, zodError: validation.error.message },
          );
        }
        placed = validation.data;
        return JSON.stringify(placed);
      },
    });
  } catch (err) {
    translateLeaseCasError(err, taskId, 'acquire');
  }

  appendClaimHistory(
    forgeDir,
    taskId,
    {
      event: 'acquired',
      ts: new Date().toISOString(),
      claim_id: placed!.claim_id,
      run_id: runId,
      generation: placed!.generation,
    },
    opts.logRotateMaxBytes,
  );

  return placed!;
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
  now?: number; // injectable for testing (mirrors steal); defaults to Date.now()
}

export function heartbeat(opts: HeartbeatOptions): Lease {
  const { forgeDir, leaseTtlMs = LEASE_TTL_MS_DEFAULT, now: nowOverride } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const { caller } = opts;

  const targetPath = leaseFilePath(forgeDir, taskId);

  // 1. Fast-fail read + ownership check. The AUTHORITATIVE check happens on
  //    the post-acquire read inside the guarded write below; this one exists
  //    for precise typed errors on the common paths.
  const stored = readLeaseFile(taskId, targetPath);
  if (stored === null) {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: targetPath },
    );
  }

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

  // 2. Guarded renewal: single-committer on lease_version. A concurrent steal
  //    either holds the marker (we abort with LEASE_CONTENDED) or has already
  //    advanced the version (version_conflict → LEASE_STOLEN via the
  //    translator). The pre-FORGE-231 verify-after-write is subsumed by the
  //    marker protocol.
  const now = nowOverride ?? Date.now();
  let renewed: Lease | undefined;
  try {
    casGuardedWrite({
      filePath: targetPath,
      expectedVersion: stored.lease_version,
      holder: { run_id: caller.run_id, claim_id: caller.claim_id, generation: caller.generation },
      readVersion: leaseVersionOf,
      buildContent: (raw) => {
        if (raw === null) {
          throw new CasError('lease_lost', `lease.json disappeared during heartbeat for ${taskId}`);
        }
        const current = LeaseFileSchema.safeParse(JSON.parse(raw));
        if (!current.success) {
          throw new CasError('io', `lease.json unparseable during heartbeat for ${taskId}`);
        }
        if ('status' in current.data && current.data.status === 'released') {
          throw new CasError('lease_lost', `lease for ${taskId} was released concurrently`);
        }
        const active = current.data as Lease;
        if (
          active.claim_id !== caller.claim_id ||
          active.generation !== caller.generation ||
          active.owner_run_id !== caller.run_id
        ) {
          throw new CasError('lease_lost', `lease ownership changed during heartbeat for ${taskId}`);
        }
        const candidate: Lease = {
          ...active,
          expires_at: new Date(now + leaseTtlMs).toISOString(),
          last_heartbeat_at: new Date(now).toISOString(),
          lease_version: active.lease_version + 1,
        };
        const validation = LeaseSchema.safeParse(candidate);
        if (!validation.success) {
          throw new OrchestratorError(
            'SCHEMA_INVALID',
            `Updated lease record failed schema validation`,
            { taskId, zodError: validation.error.message },
          );
        }
        renewed = validation.data;
        return JSON.stringify(renewed);
      },
    });
  } catch (err) {
    translateLeaseCasError(err, taskId, 'heartbeat');
  }

  return renewed!;
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
  // FORGE-118: soft-rotation threshold for claim-history.jsonl. See AcquireOptions.
  logRotateMaxBytes?: number;
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
  const statePath = stateFilePath(forgeDir, taskId);
  const now = nowOverride ?? Date.now();
  const repoRoot = opts.repoRoot ?? dirname(forgeDir);
  const specRevision =
    opts.specRevision ?? computeSpecRevisionSync(repoRoot);

  // 1. Observe: an ACTIVE lease must exist. Tombstone/absent → acquire is the
  //    correct verb (the pre-FORGE-231 steal-as-acquire fall-through is gone —
  //    with tombstones, an absent file for a once-leased task is a legacy
  //    state that acquire handles).
  const record = readLeaseRecord(taskId, targetPath);
  if (record === null || record.kind === 'released') {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `No active lease to steal for task ${taskId} — use acquire`,
      { taskId, path: targetPath },
    );
  }
  const existing = record.lease;

  // 2. Eligibility (past expiry + grace period).
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

  const newGeneration = existing.generation + 1;
  const newClaimId = uuidv7();
  const holder = { run_id: runId, claim_id: newClaimId, generation: newGeneration };

  // 3. RESERVE the state transition FIRST (lock order: STATE before LEASE).
  //    A held state marker means some writer owns an in-flight state commit —
  //    the steal aborts entirely, publishing nothing. Conservative: a steal
  //    never overlaps a held commit right.
  let stateExpected: number | 'create';
  {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (err) {
      if (!(isNodeFsError(err) && err.code === 'ENOENT')) {
        throw new OrchestratorError(
          'IO_ERROR',
          `Failed to read state.json for steal of task ${taskId}`,
          { taskId, path: statePath, cause: err },
        );
      }
    }
    stateExpected = raw === null ? 'create' : stateVersionOf(raw);
  }

  let stateMarker: HeldCasMarker;
  try {
    stateMarker = acquireCasMarker(statePath, stateExpected, holder, stateVersionOf);
  } catch (err) {
    if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
      throw new OrchestratorError(
        'LEASE_CONTENDED',
        `Steal aborted for task ${taskId}: the state transition is reserved or moved concurrently`,
        { taskId, cause: err },
      );
    }
    translateLeaseCasError(err, taskId, 'steal');
  }

  // 4-5. Publish the successor lease under the lease CAS. buildContent runs on
  //      the post-acquire read: the lease must STILL be the exact one judged
  //      stealable, and still expired.
  let published: Lease | undefined;
  try {
    casGuardedWrite({
      filePath: targetPath,
      expectedVersion: existing.lease_version,
      holder,
      readVersion: leaseVersionOf,
      buildContent: (raw) => {
        if (raw === null) {
          throw new CasError('lease_lost', `lease.json disappeared during steal of ${taskId}`);
        }
        const current = LeaseFileSchema.safeParse(JSON.parse(raw));
        if (!current.success) {
          throw new CasError('io', `lease.json unparseable during steal of ${taskId}`);
        }
        if ('status' in current.data && current.data.status === 'released') {
          throw new CasError('lease_lost', `lease for ${taskId} was released during steal`);
        }
        const active = current.data as Lease;
        if (
          active.claim_id !== existing.claim_id ||
          active.generation !== existing.generation ||
          active.owner_run_id !== existing.owner_run_id ||
          active.expires_at !== existing.expires_at
        ) {
          throw new CasError('lease_lost', `lease for ${taskId} was refreshed between eligibility check and write`);
        }
        if (now <= new Date(active.expires_at).getTime() + stealGraceMs) {
          throw new CasError('lease_lost', `lease for ${taskId} is no longer expired`);
        }
        const candidate: Lease = {
          version: 1,
          claim_id: newClaimId,
          task_id: taskId,
          attempt_id: null,
          owner_run_id: runId,
          acquired_at: new Date(now).toISOString(),
          expires_at: new Date(now + leaseTtlMs).toISOString(),
          last_heartbeat_at: new Date(now).toISOString(),
          generation: newGeneration,
          spec_revision: specRevision.revision,
          lease_version: active.lease_version + 1,
        };
        const validation = LeaseSchema.safeParse(candidate);
        if (!validation.success) {
          throw new OrchestratorError(
            'SCHEMA_INVALID',
            `New lease record failed schema validation`,
            { taskId, zodError: validation.error.message },
          );
        }
        published = validation.data;
        return JSON.stringify(published);
      },
    });
  } catch (err) {
    // Pre-publish abort: release the reserved state marker (its transition
    // never began placement), then translate. Preserve the pre-FORGE-231
    // "concurrent heartbeat renewed it" error surface.
    releaseCasMarker(stateMarker);
    if (err instanceof CasError && err.code === 'lease_lost') {
      throw new OrchestratorError(
        'LEASE_NOT_EXPIRED',
        `Lease for task ${taskId} was refreshed between eligibility check and write — concurrent heartbeat renewed it`,
        {
          taskId,
          reason: 'concurrent_heartbeat_renewed_lease',
          detail: 'lease was refreshed after eligibility check',
          cause: err,
        },
      );
    }
    translateLeaseCasError(err, taskId, 'steal');
  }

  // 6. Commit state.json = unclaimed under the RESERVED marker (OQ-6). Best-
  //    effort like before FORGE-231: the lease already changed hands; a failed
  //    state commit leaves lease(new)/state(old) divergence for gc. The marker
  //    follows commitUnderCasMarker's policy (released on proven pre-placement
  //    failure, retained + reported on ambiguity).
  try {
    commitUnderCasMarker(
      stateMarker,
      buildUnclaimedPayload(taskId, stateMarker.raw, published!),
    );
    cleanupCompletedCasMarkers(
      statePath,
      stateExpected === 'create' ? 0 : stateExpected + 1,
    );
  } catch {
    // gc reconciles (divergence row) — see module header.
  }

  appendClaimHistory(
    forgeDir,
    taskId,
    {
      event: 'stolen',
      ts: new Date(now).toISOString(),
      claim_id: published!.claim_id,
      run_id: runId,
      generation: newGeneration,
      from_generation: existing.generation,
      from_claim_id: existing.claim_id,
    },
    opts.logRotateMaxBytes,
  );

  return published!;
}

export interface ReleaseOptions {
  forgeDir: string;
  taskId: string;
  caller: CallerIdentity;
  // FORGE-118: soft-rotation threshold for claim-history.jsonl. See AcquireOptions.
  logRotateMaxBytes?: number;
}

export function release(opts: ReleaseOptions): void {
  const { forgeDir } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const { caller } = opts;

  // Validate ownership before releasing. Identity-only — releasing an EXPIRED
  // but still-owned lease is legal (R8 MAJ-1). Absent file AND tombstone both
  // read as no active lease → LEASE_NOT_FOUND (pre-FORGE-231 parity).
  assertLeaseOwnership(forgeDir, taskId, caller);

  const targetPath = leaseFilePath(forgeDir, taskId);
  const stored = readLeaseFile(taskId, targetPath);
  if (stored === null) {
    // Raced with another releaser between the assert and here — idempotent.
    return;
  }

  try {
    casGuardedWrite({
      filePath: targetPath,
      expectedVersion: stored.lease_version,
      holder: { run_id: caller.run_id, claim_id: caller.claim_id, generation: caller.generation },
      readVersion: leaseVersionOf,
      buildContent: (raw) => {
        if (raw === null) {
          throw new CasError('lease_lost', `lease.json disappeared during release of ${taskId}`);
        }
        const current = LeaseFileSchema.safeParse(JSON.parse(raw));
        if (!current.success) {
          throw new CasError('io', `lease.json unparseable during release of ${taskId}`);
        }
        if ('status' in current.data && current.data.status === 'released') {
          throw new CasError('lease_lost', `lease for ${taskId} was already released`);
        }
        const active = current.data as Lease;
        if (
          active.claim_id !== caller.claim_id ||
          active.generation !== caller.generation ||
          active.owner_run_id !== caller.run_id
        ) {
          throw new CasError('lease_lost', `lease ownership changed during release of ${taskId}`);
        }
        const tombstone: ReleasedLeaseTombstone = {
          version: 1,
          status: 'released',
          task_id: taskId,
          lease_version: active.lease_version + 1,
          last_generation: active.generation,
          released_at: new Date().toISOString(),
          released_by: {
            run_id: caller.run_id,
            claim_id: caller.claim_id,
            generation: caller.generation,
          },
        };
        return JSON.stringify(tombstone);
      },
    });
  } catch (err) {
    translateLeaseCasError(err, taskId, 'release');
  }

  appendClaimHistory(
    forgeDir,
    taskId,
    {
      event: 'released',
      ts: new Date().toISOString(),
      claim_id: caller.claim_id,
      run_id: caller.run_id,
      generation: caller.generation,
    },
    opts.logRotateMaxBytes,
  );
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
  | 'gc:row-14:terminal-state' // canonical lease present but task state is terminal
  | 'gc:row-15:merge-pending-lease'; // FORGE-231: merge_pending task whose worker lease expired (no heartbeat source exists)

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
  // FORGE-118: soft-rotation threshold for claim-history.jsonl. See AcquireOptions.
  logRotateMaxBytes?: number;
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

  // 5. Release. FORGE-231 (impl R1 CRIT-2): the CANONICAL lease file is a
  //    CAS-guarded, never-deleted file — its admin release writes a TOMBSTONE
  //    through the same single-committer protocol every other lease mutation
  //    uses, so a paused gc can never unlink a concurrently-renewed lease and
  //    a paused heartbeat can never resurrect one over gc's release.
  //    NON-canonical duplicate artifacts (row 13 — e.g. `lease.json.bak`) are
  //    not CAS-guarded files; they keep the identity-gated unlink.
  const canonicalPath = leaseFilePath(forgeDir, taskId);
  if (expectedPath === canonicalPath) {
    try {
      casGuardedWrite({
        filePath: canonicalPath,
        expectedVersion: finalLease.lease_version,
        holder: {
          run_id: opts.expectedOwnerRunId,
          claim_id: opts.expectedClaimId,
          generation: opts.expectedGeneration,
        },
        readVersion: leaseVersionOf,
        buildContent: (raw) => {
          if (raw === null) {
            throw new CasError('lease_lost', `lease.json disappeared during admin release of ${taskId}`);
          }
          const current = LeaseFileSchema.safeParse(JSON.parse(raw));
          if (!current.success) {
            throw new CasError('io', `lease.json unparseable during admin release of ${taskId}`);
          }
          if ('status' in current.data && current.data.status === 'released') {
            throw new CasError('lease_lost', `lease for ${taskId} was already released`);
          }
          const active = current.data as Lease;
          // Post-acquire identity re-verification — ALL FOUR fields, so a
          // heartbeat renewal (which preserves identity but changes
          // expires_at AND bumps lease_version) can never be released.
          if (
            active.claim_id !== opts.expectedClaimId ||
            active.generation !== opts.expectedGeneration ||
            active.owner_run_id !== opts.expectedOwnerRunId ||
            active.expires_at !== opts.expectedExpiresAt
          ) {
            throw new CasError('lease_lost', `lease for ${taskId} changed identity during admin release`);
          }
          const tombstone: ReleasedLeaseTombstone = {
            version: 1,
            status: 'released',
            task_id: taskId,
            lease_version: active.lease_version + 1,
            last_generation: active.generation,
            released_at: new Date().toISOString(),
            released_by: {
              run_id: opts.expectedOwnerRunId,
              claim_id: opts.expectedClaimId,
              generation: opts.expectedGeneration,
            },
          };
          return JSON.stringify(tombstone);
        },
      });
    } catch (err) {
      if (err instanceof CasError && err.code === 'lease_lost') {
        // Already released (idempotent) or mutated under us — the mutated
        // case is exactly the concurrent-heartbeat detection this row exists
        // to respect.
        const now = readLeaseRecord(taskId, canonicalPath);
        if (now?.kind === 'released') return; // idempotent
        throw new OrchestratorError(
          'LEASE_IDENTITY_MISMATCH',
          `Lease at ${expectedPath} for task ${taskId} changed during admin release (concurrent mutation)`,
          { taskId, path: expectedPath, reason, cause: err },
        );
      }
      if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
        throw new OrchestratorError(
          'LEASE_IDENTITY_MISMATCH',
          `Lease at ${expectedPath} for task ${taskId} is being mutated concurrently — refusing admin release`,
          { taskId, path: expectedPath, reason, cause: err },
        );
      }
      if (err instanceof OrchestratorError) throw err;
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to release canonical lease for task ${taskId}`,
        { taskId, path: expectedPath, reason, cause: err },
      );
    }
  } else {
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
  }

  // 6. Record the admin release in claim-history.jsonl with the reason. This
  //    is the audit trail — any unexpected admin_released event in a production
  //    run is a bug to investigate.
  appendClaimHistory(
    forgeDir,
    taskId,
    {
      event: 'admin_released',
      ts: new Date().toISOString(),
      claim_id: opts.expectedClaimId,
      run_id: opts.expectedOwnerRunId,
      generation: opts.expectedGeneration,
      reason,
      path: expectedPath,
    },
    opts.logRotateMaxBytes,
  );
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
