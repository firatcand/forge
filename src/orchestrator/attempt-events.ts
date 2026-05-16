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
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  readFileSync as _readFileSync,
  writeSync as _writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { OrchestratorError } from '../core/errors.ts';
import { AttemptEventSchema, type AttemptEvent } from '../schemas/attempt.ts';
import { eventsFilePath, validateIdSegment } from './questions/paths.ts';
import { isNodeFsError } from './questions/errors.ts';

// Test seam — same pattern as writer.ts and leases.ts.
export const __eventsFsForTesting = {
  closeSync: _closeSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  readFileSync: _readFileSync,
  writeSync: _writeSync,
};
const fs = __eventsFsForTesting;

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
}

export function appendAttemptEvent(
  event: AttemptEvent,
  opts: AppendAttemptEventOptions,
): void {
  const { forgeDir } = opts;
  const taskId = validateOrchestratorId(opts.taskId, 'taskId');
  const attemptId = validateOrchestratorId(opts.attemptId, 'attemptId');

  // Validate event against schema before any I/O.
  const validation = AttemptEventSchema.safeParse(event);
  if (!validation.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `AttemptEvent failed schema validation`,
      { taskId, attemptId, zodError: validation.error.message },
    );
  }

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

  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, 'utf8');
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return [];
    }
    throw new OrchestratorError(
      'IO_ERROR',
      `Failed to read events.jsonl at ${targetPath}`,
      { taskId, attemptId, path: targetPath, cause: err },
    );
  }

  // Split on newlines. A partial trailing line (no trailing \n) is silently
  // skipped — the writer's writeSync loop guarantees complete line writes
  // but a crash mid-write can leave a partial line.
  const lines = raw.split('\n');
  const results: ParsedEventLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue; // skip empty lines including the final \n-generated empty entry
    results.push(tryParseEventLine(trimmed));
  }

  return results;
}
