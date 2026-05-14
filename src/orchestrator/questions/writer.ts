import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnswerSchema,
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../schemas/questions.ts';
import { QuestionChannelError, isNodeFsError } from './errors.ts';

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
  // (e.g. inside a Promise.all). Math.random() is belt-and-suspenders.
  tempCounter = (tempCounter + 1) >>> 0;
  return `${targetPath}.${process.pid}.${tempCounter}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function ensureDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    fd = openSync(tmpPath, 'wx', 0o600);
  } catch (err) {
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to open temp file ${tmpPath}`,
      { path: tmpPath, cause: err },
    );
  }
  try {
    try {
      writeSync(fd, payload, null, 'utf8');
    } catch (err) {
      throw new QuestionChannelError(
        'IO_ERROR',
        `Failed to write temp file ${tmpPath}`,
        { path: tmpPath, cause: err },
      );
    }
    try {
      fsyncSync(fd);
    } catch (err) {
      throw new QuestionChannelError(
        'IO_ERROR',
        `Failed to fsync temp file ${tmpPath}`,
        { path: tmpPath, cause: err },
      );
    }
  } finally {
    // closeSync wrapped separately — a failure here does NOT necessarily
    // mean the data wasn't written, but we surface it as IO_ERROR if the
    // write/fsync path succeeded. If an earlier error already threw, we
    // still want to release the fd; the close error in that path is
    // swallowed deliberately (the outer error is the actionable one).
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup; do not throw from a cleanup path
  }
}

function placeAtomic(tmpPath: string, targetPath: string): void {
  try {
    linkSync(tmpPath, targetPath);
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
  // Temp file is unlinked AFTER link succeeds — link creates a second name
  // for the same inode, then we remove the temp name. Order matters: if we
  // unlinked before linking, a crash between unlink and link would lose data.
  bestEffortUnlink(tmpPath);
}

export interface WriteOptions {
  forgeDir: string;
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
  const dir = join(opts.forgeDir, 'questions');
  const targetPath = join(dir, `${validated.question_id}.json`);
  ensureDirectory(dir);
  const tmpPath = tempName(targetPath);
  const payload = JSON.stringify(validated);
  try {
    writeTempFile(tmpPath, payload);
    placeAtomic(tmpPath, targetPath);
  } catch (err) {
    bestEffortUnlink(tmpPath);
    throw err;
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
  const dir = join(opts.forgeDir, 'answers');
  const targetPath = join(dir, `${validated.question_id}.json`);
  ensureDirectory(dir);
  const tmpPath = tempName(targetPath);
  const payload = JSON.stringify(validated);
  try {
    writeTempFile(tmpPath, payload);
    placeAtomic(tmpPath, targetPath);
  } catch (err) {
    bestEffortUnlink(tmpPath);
    throw err;
  }
}
