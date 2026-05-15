import {
  closeSync as _closeSync,
  fsyncSync as _fsyncSync,
  linkSync as _linkSync,
  mkdirSync as _mkdirSync,
  openSync as _openSync,
  unlinkSync as _unlinkSync,
  writeSync as _writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  AnswerSchema,
  QUESTION_FILE_MAX_BYTES,
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../schemas/questions.ts';
import { QuestionChannelError, isNodeFsError } from './errors.ts';
import {
  answerFilePath,
  questionFilePath,
  validateIdSegment,
} from './paths.ts';

// Test seam: tests use node:test's `mock.method` to override individual entries
// here when simulating fs failures (partial writeSync, closeSync errors, etc.).
// The node:fs module namespace is a frozen Module Namespace Object so it cannot
// be patched directly; this plain object holds mutable references the writer
// uses. Production code must NOT touch this — call writeQuestionAtomic /
// writeAnswerAtomic and let them route through `fs`. Marked __ to signal the
// intent at the call site.
export const __fsForTesting = {
  closeSync: _closeSync,
  fsyncSync: _fsyncSync,
  linkSync: _linkSync,
  mkdirSync: _mkdirSync,
  openSync: _openSync,
  unlinkSync: _unlinkSync,
  writeSync: _writeSync,
};
const fs = __fsForTesting;

// Atomic file placement is implemented as: write to a uniquely-named temp
// file in the same directory, fsync, then `link` the temp file at the final
// target path and `unlink` the temp. We use `link`+`unlink` (not `rename`)
// deliberately: POSIX `rename` overwrites an existing target silently, which
// would violate the "never overwritten" invariant in spec/ORCHESTRATOR.md
// §"File semantics" under a race between two writers. `link` fails with
// EEXIST when the target exists, giving us OS-level duplicate safety.
//
// Tradeoff: `link` is not supported on some non-POSIX filesystems (FAT,
// some NFS mounts). `.forge/` is co-located with the git repo, which
// already requires a local POSIX filesystem, so this is acceptable.
//
// Per docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md,
// EVERY fs call in the chain is wrapped in its own try/catch — we never
// assume a prior call's success implies the next one will work.

let tempCounter = 0;

function tempName(targetPath: string): string {
  // Per-call counter prevents collisions between concurrent same-pid writers
  // (e.g. inside a Promise.all); randomBytes hardens against a hostile same-UID
  // process attempting to plant predictable temp names.
  tempCounter = (tempCounter + 1) >>> 0;
  return `${targetPath}.${process.pid}.${tempCounter}.${randomBytes(8).toString('hex')}.tmp`;
}

function ensureDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to create directory ${dir}`,
      { path: dir, cause: err },
    );
  }
}

function writeTempFile(tmpPath: string, payload: string): void {
  // O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if the temp file
  // already exists. This is a defense against same-pid collisions even
  // before the counter (extremely unlikely to fire, but cheap insurance).
  let fd: number;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (err) {
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to open temp file ${tmpPath}`,
      { path: tmpPath, cause: err },
    );
  }
  // writeSync may return a byte count smaller than the requested length on
  // NFS / quota-exhausted / signal-interrupted writes. Loop until the full
  // payload is written; treat `written === 0` as a hard I/O error rather than
  // an infinite-loop trigger.
  const buf = Buffer.from(payload, 'utf8');
  let primaryError: unknown;
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset, null);
      if (written === 0) {
        throw new QuestionChannelError(
          'IO_ERROR',
          `writeSync returned 0 at offset ${offset} for ${tmpPath}`,
          { path: tmpPath, offset },
        );
      }
      offset += written;
    }
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      throw new QuestionChannelError(
        'IO_ERROR',
        `Failed to fsync temp file ${tmpPath}`,
        { path: tmpPath, cause: err },
      );
    }
  } catch (err) {
    if (err instanceof QuestionChannelError) {
      primaryError = err;
    } else {
      primaryError = new QuestionChannelError(
        'IO_ERROR',
        `Failed to write temp file ${tmpPath}`,
        { path: tmpPath, cause: err },
      );
    }
  } finally {
    // Per close(2), a closeSync failure on a normally-completed write is a
    // real I/O error (delayed write-back on NFS/quota paths). Surface it as
    // IO_ERROR when it is the ONLY failure. If a prior write/fsync error
    // already exists, that error wins — the close error is swallowed
    // deliberately because (a) the fd is gone either way (never retry close)
    // and (b) the prior error is the actionable one for the caller.
    try {
      fs.closeSync(fd);
    } catch (closeErr) {
      if (primaryError === undefined) {
        primaryError = new QuestionChannelError(
          'IO_ERROR',
          `Failed to close temp file ${tmpPath}`,
          { path: tmpPath, cause: closeErr },
        );
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

function bestEffortUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // best-effort cleanup; do not throw from a cleanup path
  }
}

function placeAtomic(tmpPath: string, targetPath: string): void {
  // Temp-file cleanup is owned by the caller's `finally` block — `placeAtomic`
  // never unlinks. This keeps a single, unconditional cleanup point regardless
  // of whether `linkSync` succeeds, throws DUPLICATE_ID, or throws any other
  // fs error, closing the leak surfaced by Codex review.
  try {
    fs.linkSync(tmpPath, targetPath);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'EEXIST') {
      throw new QuestionChannelError(
        'DUPLICATE_ID',
        `Target already exists: ${targetPath}`,
        { path: targetPath, cause: err },
      );
    }
    if (isNodeFsError(err) && (err.code === 'EPERM' || err.code === 'ENOTSUP')) {
      throw new QuestionChannelError(
        'IO_ERROR',
        `Filesystem does not support hard links at ${targetPath} (require local POSIX filesystem)`,
        { path: targetPath, cause: err },
      );
    }
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to place ${targetPath}`,
      { path: targetPath, cause: err },
    );
  }
}

export interface WriteOptions {
  forgeDir: string;
  // task_id and attempt_id together select the directory under
  // .forge/orchestrator/tasks/<taskId>/attempts/<attemptId>/. They are
  // path-validated by `validateIdSegment` inside the path helpers.
  taskId: string;
  attemptId: string;
}

function assertPayloadSize(payload: string, targetPath: string): void {
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > QUESTION_FILE_MAX_BYTES) {
    throw new QuestionChannelError(
      'PAYLOAD_TOO_LARGE',
      `Payload exceeds QUESTION_FILE_MAX_BYTES (${QUESTION_FILE_MAX_BYTES}): ${bytes} bytes`,
      { path: targetPath, bytes },
    );
  }
}

export function writeQuestionAtomic(
  question: Question,
  opts: WriteOptions,
): void {
  const parsed = QuestionSchemaWithRecommendationCheck.safeParse(question);
  if (!parsed.success) {
    throw new QuestionChannelError(
      'SCHEMA_INVALID',
      'Question failed schema validation',
      { zodError: parsed.error.message },
    );
  }
  const validated = parsed.data;
  // Defense-in-depth: writer validates ids even though path helpers do too.
  // A pre-flight INVALID_ID error is more actionable than a downstream link
  // failure when callers pass crafted ids.
  validateIdSegment(opts.taskId, 'taskId');
  validateIdSegment(opts.attemptId, 'attemptId');
  // Path/payload task_id must agree, otherwise the file lands under one task
  // while its JSON content claims another — breaking cross-attempt
  // decision_key lookup, which scans by path but reads payloads. Codex flagged
  // this in review: silent acceptance lets a caller pollute a sibling task's
  // mailbox.
  if (opts.taskId !== validated.task_id) {
    throw new QuestionChannelError(
      'INVALID_ID',
      `Path taskId (${opts.taskId}) does not match question payload task_id (${validated.task_id})`,
      { pathTaskId: opts.taskId, payloadTaskId: validated.task_id },
    );
  }
  const targetPath = questionFilePath(
    opts.forgeDir,
    opts.taskId,
    opts.attemptId,
    validated.question_id,
  );
  const dir = dirname(targetPath);
  const payload = JSON.stringify(validated);
  // Enforce the size cap BEFORE any disk I/O so producers fail fast and we
  // never even attempt to land an oversized file in the mailbox. Reader-side
  // OVERSIZED protection remains as a second line of defense.
  assertPayloadSize(payload, targetPath);
  ensureDirectory(dir);
  const tmpPath = tempName(targetPath);
  try {
    writeTempFile(tmpPath, payload);
    placeAtomic(tmpPath, targetPath);
  } finally {
    // Unconditional cleanup: on the happy path the temp file is the second
    // name of the now-linked inode (safe to unlink); on any failure path the
    // temp may exist and must be removed to prevent .tmp accumulation.
    // bestEffortUnlink swallows ENOENT, so this is idempotent.
    bestEffortUnlink(tmpPath);
  }
}

export function writeAnswerAtomic(
  answer: Answer,
  opts: WriteOptions,
): void {
  const parsed = AnswerSchema.safeParse(answer);
  if (!parsed.success) {
    throw new QuestionChannelError(
      'SCHEMA_INVALID',
      'Answer failed schema validation',
      { zodError: parsed.error.message },
    );
  }
  const validated = parsed.data;
  validateIdSegment(opts.taskId, 'taskId');
  validateIdSegment(opts.attemptId, 'attemptId');
  // Note: AnswerSchema does not carry task_id (the answer is keyed by
  // question_id alone). Path/payload consistency is enforced indirectly by
  // the answer CLI: it locates the question via findQuestionFile and reuses
  // the resulting (taskId, attemptId) for the answer write.
  const targetPath = answerFilePath(
    opts.forgeDir,
    opts.taskId,
    opts.attemptId,
    validated.question_id,
  );
  const dir = dirname(targetPath);
  const payload = JSON.stringify(validated);
  assertPayloadSize(payload, targetPath);
  ensureDirectory(dir);
  const tmpPath = tempName(targetPath);
  try {
    writeTempFile(tmpPath, payload);
    placeAtomic(tmpPath, targetPath);
  } finally {
    bestEffortUnlink(tmpPath);
  }
}
