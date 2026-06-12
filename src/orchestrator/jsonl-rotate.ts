// Soft rotation for the append-only JSONL logs (events.jsonl,
// claim-history.jsonl) — FORGE-85.
//
// Policy (user decision): ONE generation. When a file's size reaches
// `maxBytes` BEFORE an append, rename `<file>` → `<file>.1` (overwriting any
// prior `.1`) and start fresh. Rename-based, never copies. Readers merge
// `.1` + current (see attempt-events.readAttemptEvents /
// leases.readLastClaimHistoryEntry).
//
// Interprocess race guard (pre-review major): rotation runs only while holding
// `<file>.rotate.lock`, created O_CREAT|O_EXCL. If the lock already exists →
// SKIP rotation for this append (someone else is rotating; a slight size
// overshoot is acceptable). The size is RE-STAT'd UNDER the lock before
// renaming (double-check). The lock is removed in `finally`. Stale locks
// (older than STALE_LOCK_MS) are broken so a crashed rotator can't wedge
// rotation forever. Two concurrent rotators must never destroy a generation
// (process B renaming A's fresh current over `.1`): the lock serializes them,
// and the under-lock re-stat means the loser sees a small fresh file and
// skips.

import {
  closeSync as _closeSync,
  openSync as _openSync,
  renameSync as _renameSync,
  statSync as _statSync,
  unlinkSync as _unlinkSync,
} from 'node:fs';
import { isNodeFsError } from './questions/errors.ts';

// Schema default mirror — fallback for deep orchestrator code that has no
// settings access (the writers accept the resolved value as a parameter and
// fall back to this). Keep in sync with AgentsSchema.log_rotate_max_bytes.
export const LOG_ROTATE_MAX_BYTES_DEFAULT = 10_485_760;

// Break a `.rotate.lock` whose mtime is older than this — covers a crashed
// rotator that never reached the `finally` unlink.
export const STALE_LOCK_MS = 30_000;

// Injectable fs surface so callers thread their existing test seam through
// (the mock then exercises rotation too). Matches the node:fs sync API shapes.
export interface RotateFs {
  statSync: typeof _statSync;
  renameSync: typeof _renameSync;
  openSync: typeof _openSync;
  closeSync: typeof _closeSync;
  unlinkSync: typeof _unlinkSync;
}

const defaultRotateFs: RotateFs = {
  statSync: _statSync,
  renameSync: _renameSync,
  openSync: _openSync,
  closeSync: _closeSync,
  unlinkSync: _unlinkSync,
};

function rotatedPath(path: string): string {
  return `${path}.1`;
}

function lockPath(path: string): string {
  return `${path}.rotate.lock`;
}

// Return the file's size in bytes, or null when it does not exist yet.
function sizeOrNull(fs: RotateFs, path: string): number | null {
  try {
    return fs.statSync(path).size;
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

// Acquire the rotate lock (O_CREAT|O_EXCL). Returns true on success. On EEXIST,
// break the lock if it is stale (mtime older than STALE_LOCK_MS) and retry once;
// otherwise return false (another process is rotating → caller SKIPs rotation).
function acquireLock(fs: RotateFs, lock: string): boolean {
  // 'wx' = O_CREAT|O_WRONLY|O_EXCL — fails with EEXIST if the file exists.
  try {
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (!(isNodeFsError(err) && err.code === 'EEXIST')) throw err;
  }
  // Lock exists — break it only if stale.
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch (statErr) {
    // Lock vanished between open and stat (the holder released) — retry once.
    if (isNodeFsError(statErr) && statErr.code === 'ENOENT') {
      try {
        const fd = fs.openSync(lock, 'wx', 0o600);
        fs.closeSync(fd);
        return true;
      } catch {
        return false;
      }
    }
    throw statErr;
  }
  if (Date.now() - mtimeMs <= STALE_LOCK_MS) {
    return false; // fresh lock — someone is actively rotating
  }
  // Stale lock: remove it and try once more. A racing process may win the
  // re-create; if so we lose the race and SKIP (return false).
  try {
    fs.unlinkSync(lock);
  } catch (unlinkErr) {
    if (!(isNodeFsError(unlinkErr) && unlinkErr.code === 'ENOENT')) {
      throw unlinkErr;
    }
  }
  try {
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(fs: RotateFs, lock: string): void {
  try {
    fs.unlinkSync(lock);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return; // already gone
    throw err;
  }
}

// Rotate `<path>` → `<path>.1` when it has reached `maxBytes`, under a
// lock-or-skip guard. No-op when the file is absent, below the threshold, or
// the lock is contended. Returns true iff a rename happened (mostly for tests).
//
// Errors: surfaced to the caller (the file-not-found and lock-contention cases
// are handled internally and do NOT throw). Callers that must stay best-effort
// (appendClaimHistory) wrap the call in their own try/catch.
export function rotateIfNeeded(
  path: string,
  maxBytes: number,
  fsImpl: RotateFs = defaultRotateFs,
): boolean {
  // Cheap pre-check WITHOUT the lock — avoids lock churn on every append.
  const size = sizeOrNull(fsImpl, path);
  if (size === null || size < maxBytes) return false;

  const lock = lockPath(path);
  if (!acquireLock(fsImpl, lock)) return false; // contended → skip

  try {
    // Re-stat UNDER the lock — a concurrent rotator may have already rotated,
    // leaving a small fresh file we must NOT rotate again (that would rename a
    // near-empty current over the just-created `.1`, destroying a generation).
    const sizeUnderLock = sizeOrNull(fsImpl, path);
    if (sizeUnderLock === null || sizeUnderLock < maxBytes) return false;
    // Overwrites any prior `.1` — single generation by design.
    fsImpl.renameSync(path, rotatedPath(path));
    return true;
  } finally {
    releaseLock(fsImpl, lock);
  }
}
