// Append-only attempt event log (events.jsonl).
//
// Each event is a single JSON line terminated by \n. The writer uses writeSync
// in a loop (same pattern as writer.ts) to ensure the full line is written
// atomically at the OS level — appendFileSync is not atomic for multi-line
// writes.
//
// Reader design:
// - Reads all complete lines (terminated by \n).
// - Skips a partial trailing line (no trailing \n) without crashing.
//   See plan §Edge cases 7: events.jsonl partial write.
// - Lines that fail AttemptEventSchema parse are returned as { ok: false }
//   so callers can skip unknown event types without throwing.
//
// TOCTOU: mkdirSync and openSync are each wrapped in their own try/catch.
// See docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md.

import {
  closeSync as _closeSync,
  constants as _constants,
  fstatSync as _fstatSync,
  lstatSync as _lstatSync,
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  readFileSync as _readFileSync,
  readSync as _readSync,
  realpathSync as _realpathSync,
  renameSync as _renameSync,
  statSync as _statSync,
  unlinkSync as _unlinkSync,
  writeSync as _writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { OrchestratorError } from '../core/errors.ts';
import { AttemptEventSchema, type AttemptEvent } from '../schemas/attempt.ts';
import { eventsFilePath, validateIdSegment } from './questions/paths.ts';
import { isNodeFsError } from './questions/errors.ts';
import { assertLeaseOwnership, type CallerIdentity } from './leases.ts';
import {
  LOG_ROTATE_MAX_BYTES_DEFAULT,
  rotateIfNeeded,
} from './jsonl-rotate.ts';

// Test seam — same pattern as writer.ts and leases.ts. statSync/renameSync/
// unlinkSync added for FORGE-85 rotation (threaded into rotateIfNeeded so a
// mocked seam exercises rotation too).
export const __eventsFsForTesting = {
  closeSync: _closeSync,
  constants: _constants,
  fstatSync: _fstatSync,
  lstatSync: _lstatSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  readFileSync: _readFileSync,
  readSync: _readSync,
  realpathSync: _realpathSync,
  renameSync: _renameSync,
  statSync: _statSync,
  unlinkSync: _unlinkSync,
  writeSync: _writeSync,
};
const fs = __eventsFsForTesting;

// Bound a single event-log read. Generous vs the 10 MiB rotation default so a
// legitimate (un-rotated) log still reads in full, but a multi-GB malicious /
// runaway log is truncated rather than loaded whole.
const MAX_EVENTS_FILE_BYTES = 32 * 1024 * 1024;

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

export interface AppendAttemptEventOptions {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  // B2: caller identity required — ownership must be validated before any mutation.
  caller: CallerIdentity;
  // FORGE-85: soft-rotation threshold in bytes. Deep orchestrator code has no
  // settings access, so callers pass the resolved value; absent → schema
  // default (LOG_ROTATE_MAX_BYTES_DEFAULT).
  logRotateMaxBytes?: number;
}

export function appendAttemptEvent(
  event: AttemptEvent,
  opts: AppendAttemptEventOptions,
): void {
  const { forgeDir } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const attemptId = validateOrchestratorId(opts.attemptId, 'attemptId');
  const { caller } = opts;

  // Validate event against schema before any I/O.
  const validation = AttemptEventSchema.safeParse(event);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `AttemptEvent failed schema validation`,
      { taskId, attemptId, zodError: validation.error.message },
    );
  }

  // B2: Assert lease ownership before writing. An event written by a stale
  // worker (generation mismatch) would corrupt the audit log for the new holder.
  assertLeaseOwnership(forgeDir, taskId, caller);

  const targetPath = eventsFilePath(forgeDir, taskId, attemptId);
  const dir = dirname(targetPath);

  // mkdirSync wrapped independently — TOCTOU: another process may delete the
  // directory between mkdirSync and openSync. openSync is wrapped separately.
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to create attempt directory ${dir}`,
      { taskId, attemptId, dir, cause: err },
    );
  }

  const line = JSON.stringify(validation.data) + '\n';
  const buf = Buffer.from(line, 'utf8');

  // FORGE-85: soft-rotate BEFORE the append. Rotation errors SURFACE (like this
  // writer's other IO errors) — events.jsonl is a durable audit log and a
  // silently-dropped rotation could grow it unbounded. rotateIfNeeded is a
  // no-op when the file is absent, below threshold, or the lock is contended.
  try {
    rotateIfNeeded(
      targetPath,
      opts.logRotateMaxBytes ?? LOG_ROTATE_MAX_BYTES_DEFAULT,
      fs,
    );
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to rotate events.jsonl at ${targetPath}`,
      { taskId, attemptId, path: targetPath, cause: err },
    );
  }

  // openSync with 'a' — atomic append flag. Each call is wrapped independently.
  let fd: number;
  try {
    fd = fs.openSync(targetPath, 'a', 0o600);
  } catch (err) {
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to open events.jsonl at ${targetPath}`,
      { taskId, attemptId, path: targetPath, cause: err },
    );
  }

  let primaryError: unknown;
  try {
    let offset = 0;
    while (offset < buf.length) {
      let written: number;
      try {
        written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
      } catch (err) {
        throw new OrchestratorError(
          'IO_ERROR',
          `writeSync failed at offset ${offset} for ${targetPath}`,
          { taskId, attemptId, path: targetPath, offset, cause: err },
        );
      }
      if (written === 0) {
        throw new OrchestratorError(
          'IO_ERROR',
          `writeSync returned 0 at offset ${offset} for ${targetPath}`,
          { taskId, attemptId, path: targetPath, offset },
        );
      }
      offset += written;
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
          `closeSync failed for ${targetPath}`,
          { taskId, attemptId, path: targetPath, cause: closeErr },
        );
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

export type ParsedEventLine =
  | { ok: true; event: AttemptEvent }
  | { ok: false; raw: string; reason: string };

export interface ReadAttemptEventsOptions {
  forgeDir: string;
  taskId: string;
  attemptId: string;
}

export function tryParseEventLine(raw: string): ParsedEventLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, raw, reason: `JSON parse error: ${String(err)}` };
  }
  const result = AttemptEventSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, raw, reason: result.error.message };
  }
  return { ok: true, event: result.data };
}

export function readAttemptEvents(
  opts: ReadAttemptEventsOptions,
): ParsedEventLine[] {
  const { forgeDir } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const attemptId = validateOrchestratorId(opts.attemptId, 'attemptId');

  const targetPath = eventsFilePath(forgeDir, taskId, attemptId);

  // FORGE-226: parent-dir containment. O_NOFOLLOW below guards only the
  // events.jsonl LEAF; a symlinked PARENT (e.g. tasks/<id> or attempts/<id> →
  // external) would still be followed, letting the projectors ingest event logs
  // from outside .forge. Canonical real .forge root, kept for BOTH the pre-open
  // fast reject AND readOne's per-file post-open re-check (the TOCTOU close).
  let realForge: string;
  try {
    realForge = fs.realpathSync(forgeDir);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return []; // no .forge → no events
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to resolve .forge root at ${forgeDir}`,
      { taskId, attemptId, path: forgeDir, cause: err },
    );
  }
  // Pre-open fast reject for a statically-escaping parent (the common, non-race
  // case). The TOCTOU race — parent swapped to a symlink AFTER this check — is
  // caught per-file by the post-open re-check in readOne (mirrors symbols.ts).
  try {
    const realParent = fs.realpathSync(dirname(targetPath));
    const relParent = relative(realForge, realParent);
    if (relParent === '' || relParent.startsWith('..') || isAbsolute(relParent)) {
      return []; // attempt dir resolves outside .forge — never read it.
    }
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return []; // no attempt dir
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to resolve events dir for ${taskId}/${attemptId}`,
      { taskId, attemptId, path: targetPath, cause: err },
    );
  }

  // FORGE-85: merge the rotated generation with the current file. Read `.1`
  // FIRST (older events) then `<file>` (newer), concatenated in chronological
  // order so a rotation that just happened doesn't drop the older half.
  const readOne = (path: string): string | null => {
    // lstat the path's OWN type (never the target's). ENOENT → absent (null);
    // any other lstat error is a genuine IO failure → surface as OrchestratorError.
    let st;
    try {
      st = fs.lstatSync(path);
    } catch (err) {
      if (isNodeFsError(err) && err.code === 'ENOENT') return null;
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to stat events.jsonl at ${path}`,
        { taskId, attemptId, path, cause: err },
      );
    }
    // NEVER follow an event-log symlink — a best-effort reader treats it as absent.
    if (st.isSymbolicLink()) return null;
    if (!st.isFile()) return null;

    // O_NOFOLLOW open (TOCTOU: reject a symlink swapped in after lstat). A genuine
    // open failure surfaces; a symlink-swap (ELOOP) / vanished file is treated as
    // absent.
    let fd: number;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      if (isNodeFsError(err) && (err.code === 'ELOOP' || err.code === 'ENOENT')) {
        return null;
      }
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to open events.jsonl at ${path}`,
        { taskId, attemptId, path, cause: err },
      );
    }
    try {
      // TOCTOU re-check on the fd itself.
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) return null;
      // FORGE-226 post-open re-check (mirror symbols.ts): O_NOFOLLOW guards only
      // the LEAF, so a PARENT dir swapped to a symlink between the pre-open
      // containment check and this open could point the fd OUTSIDE .forge.
      // Re-resolve the real path post-open and require (a) it is still contained
      // under .forge, (b) the opened fd is that same inode (dev+ino). Either
      // failing means a swap happened mid-flight → treat as absent.
      let real: string;
      try {
        real = fs.realpathSync(path);
      } catch {
        return null; // vanished between checks
      }
      const relReal = relative(realForge, real);
      if (relReal === '' || relReal.startsWith('..') || isAbsolute(relReal)) {
        return null; // resolves outside .forge — a parent was swapped post-check
      }
      try {
        const realStat = fs.statSync(real);
        if (fst.dev !== realStat.dev || fst.ino !== realStat.ino) return null;
      } catch {
        return null; // vanished between checks
      }
      // Bounded read: at most MAX_EVENTS_FILE_BYTES (truncate an oversized log
      // rather than load it whole). A truncated trailing line is already tolerated
      // by the line-split below.
      const limit = Math.min(fst.size, MAX_EVENTS_FILE_BYTES);
      const buf = Buffer.allocUnsafe(limit);
      let offset = 0;
      while (offset < limit) {
        const n = fs.readSync(fd, buf, offset, limit - offset, offset);
        if (n === 0) break;
        offset += n;
      }
      return buf.subarray(0, offset).toString('utf8');
    } catch (err) {
      throw new OrchestratorError(
        'IO_ERROR',
        `Failed to read events.jsonl at ${path}`,
        { taskId, attemptId, path, cause: err },
      );
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort: a close failure must not mask a successful read.
      }
    }
  };

  const results: ParsedEventLine[] = [];
  for (const path of [`${targetPath}.1`, targetPath]) {
    const raw = readOne(path);
    if (raw === null) continue;
    // Split on newlines. A partial trailing line (no trailing \n) is silently
    // skipped — the writer's writeSync loop guarantees complete line writes
    // but a crash mid-write can leave a partial line.
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue; // skip empty / final-\n-generated entry
      results.push(tryParseEventLine(trimmed));
    }
  }

  return results;
}
