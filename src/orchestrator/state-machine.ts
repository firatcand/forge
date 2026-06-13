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
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { OrchestratorError } from '../core/errors.ts';
import { LeaseSchema } from '../schemas/lease.ts';
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
  | 'ship_completed'
  | 'lease_expired'
  | 'steal'
  | 'cancel'
  | 'retries_exhausted'
  | 'changes_requested';

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
  'reviewed:ship_completed': 'shipped',
  'running:lease_expired': 'abandoned',
  'dispatched:lease_expired': 'abandoned',
  'blocked_on_question:lease_expired': 'abandoned',
  'abandoned:steal': 'unclaimed',
  'running:cancel': 'cancelled',
  'claimed:cancel': 'cancelled',
  'dispatched:cancel': 'cancelled',
  'running:retries_exhausted': 'failed',
  'ready_for_review:changes_requested': 'running',
} as const;

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

// ---- Temp file helpers ----

let tempCounter = 0;

function tempName(targetPath: string): string {
  tempCounter = (tempCounter + 1) >>> 0;
  return `${targetPath}.${process.pid}.${tempCounter}.${randomBytes(8).toString('hex')}.tmp`;
}

function bestEffortUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // best-effort cleanup; never throw from cleanup
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

  // 2. Read and validate lease ownership before any I/O.
  //    Throws LEASE_STOLEN if caller's (claim_id, generation) don't match.
  assertLeaseOwnershipFromFile(forgeDir, taskId, caller);

  // 3. Read current state.json to enforce state_version CAS.
  //    Initial write (no prior state.json) expects state_version === 0.
  //    H2: if the file exists but contains non-parseable JSON, throw SCHEMA_INVALID.
  //    Silently treating corruption as a missing file would bypass CAS and allow
  //    a stale writer to land a version-0 write over valid state.
  let priorVersion: number | null = null;
  const currentStatePath = stateFilePath(forgeDir, taskId);
  try {
    const currentRaw = fs.readFileSync(currentStatePath, 'utf8');
    // H2: file exists — parse strictly. Non-empty bytes that fail JSON.parse
    // indicate corruption; surface as SCHEMA_INVALID rather than silently
    // falling through to initial-write path.
    let currentParsed: unknown;
    try {
      currentParsed = JSON.parse(currentRaw);
    } catch (parseErr) {
      throw new OrchestratorError(
        'SCHEMA_INVALID',
        `state.json for task ${taskId} contains invalid JSON (corruption detected)`,
        { taskId, path: currentStatePath, cause: parseErr },
      );
    }
    const currentResult = TaskStateSchema.safeParse(currentParsed);
    if (currentResult.success) {
      priorVersion = currentResult.data.state_version;
    }
    // If safeParse fails (valid JSON but wrong schema shape), priorVersion stays
    // null and the version-0 check below will gate the write.
  } catch (err) {
    if (err instanceof OrchestratorError) throw err; // re-throw SCHEMA_INVALID from above
    if (!(isNodeFsError(err) && err.code === 'ENOENT')) {
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to read current state.json for task ${taskId}`,
        { taskId, cause: err },
      );
    }
    // ENOENT: no prior state.json — initial write, priorVersion stays null
  }

  const expectedVersion = priorVersion === null ? 0 : priorVersion + 1;
  if (state.state_version !== expectedVersion) {
    throw new OrchestratorError(
      'STATE_VERSION_CONFLICT',
      `state_version conflict for task ${taskId}: expected ${expectedVersion}, got ${state.state_version}`,
      { taskId, expected: expectedVersion, actual: state.state_version },
    );
  }

  // 4. Stamp updated_by and updated_at from caller.
  const stamped: TaskStateRecord = {
    ...state,
    updated_by: {
      run_id: caller.run_id,
      claim_id: caller.claim_id,
      generation: caller.generation,
    },
    updated_at: new Date().toISOString(),
  };

  // 5. Validate the final record before writing.
  const validation = TaskStateSchema.safeParse(stamped);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `State record failed schema validation for task ${taskId}`,
      { taskId, zodError: validation.error.message },
    );
  }

  // 6. Write atomically: tmp → fsync → rename(tmp, state.json).
  //    rename is the correct primitive here: state.json IS overwritten on each
  //    transition (unlike lease.json / question files which use link+unlink).
  //    The version-CAS guard above serializes correctness — only the holder
  //    with the correct state_version can land the rename.
  const targetPath = currentStatePath;
  const dir = dirname(targetPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to create directory ${dir}`,
      { taskId, dir, cause: err },
    );
  }

  const payload = JSON.stringify(validation.data);
  const tmpPath = tempName(targetPath);

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
          `writeSync returned 0 at offset ${offset}`,
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
  if (primaryError !== undefined) {
    bestEffortUnlink(tmpPath);
    throw primaryError;
  }

  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    bestEffortUnlink(tmpPath);
    throw new OrchestratorError(
      'IO_ERROR',
      `rename failed: ${tmpPath} → ${targetPath}`,
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

  const result = LeaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `Schema validation failed for lease.json of task ${taskId}`,
      { taskId, zodError: result.error.message },
    );
  }

  const stored = result.data;
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
