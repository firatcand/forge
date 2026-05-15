import { readFileSync, statSync } from 'node:fs';
import {
  AnswerSchema,
  QUESTION_FILE_MAX_BYTES,
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../schemas/questions.ts';
import { QuestionChannelError, isNodeFsError } from './errors.ts';
import { answerFilePath, questionFilePath } from './paths.ts';

// Every fs call below is wrapped in its own try/catch — even though
// statSync and readFileSync look adjacent, the TOCTOU window between them
// is real (concurrent unlink, symlink swap, perm change). A success on
// statSync gives us zero information about readFileSync.
// See docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md.

function mapStatError(err: unknown, path: string): QuestionChannelError {
  if (isNodeFsError(err)) {
    if (err.code === 'ENOENT') {
      return new QuestionChannelError('NOT_FOUND', `File not found: ${path}`, {
        path,
        cause: err,
      });
    }
    if (err.code === 'EACCES') {
      return new QuestionChannelError('IO_ERROR', `Permission denied: ${path}`, {
        path,
        cause: err,
      });
    }
  }
  return new QuestionChannelError('IO_ERROR', `stat failed for ${path}`, {
    path,
    cause: err,
  });
}

function mapReadError(err: unknown, path: string): QuestionChannelError {
  if (isNodeFsError(err)) {
    if (err.code === 'EISDIR') {
      return new QuestionChannelError(
        'IS_DIRECTORY',
        `Path is a directory: ${path}`,
        { path, cause: err },
      );
    }
    if (err.code === 'ENOENT') {
      return new QuestionChannelError(
        'NOT_FOUND',
        `File not found (deleted between stat and read): ${path}`,
        { path, cause: err },
      );
    }
    if (err.code === 'EACCES') {
      return new QuestionChannelError('IO_ERROR', `Permission denied: ${path}`, {
        path,
        cause: err,
      });
    }
  }
  return new QuestionChannelError('IO_ERROR', `read failed for ${path}`, {
    path,
    cause: err,
  });
}

function readFileChecked(path: string): string {
  // Wrap statSync independently — EISDIR can surface here even before we
  // attempt readFileSync (statSync on a directory does NOT throw EISDIR
  // by itself, but isDirectory() lets us catch the class explicitly).
  let isDir = false;
  try {
    const s = statSync(path);
    isDir = s.isDirectory();
  } catch (err) {
    throw mapStatError(err, path);
  }
  if (isDir) {
    throw new QuestionChannelError(
      'IS_DIRECTORY',
      `Path is a directory: ${path}`,
      { path },
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw mapReadError(err, path);
  }
  if (Buffer.byteLength(raw, 'utf8') > QUESTION_FILE_MAX_BYTES) {
    throw new QuestionChannelError(
      'OVERSIZED',
      `File exceeds QUESTION_FILE_MAX_BYTES (${QUESTION_FILE_MAX_BYTES}): ${path}`,
      { path, bytes: Buffer.byteLength(raw, 'utf8') },
    );
  }
  return raw;
}

export interface ReadOptions {
  forgeDir: string;
  // task_id and attempt_id locate the file under the v2 task-keyed layout.
  // Path-validated by the path helpers; an invalid value throws INVALID_ID.
  taskId: string;
  attemptId: string;
}

export function readQuestion(questionId: string, opts: ReadOptions): Question {
  const path = questionFilePath(
    opts.forgeDir,
    opts.taskId,
    opts.attemptId,
    questionId,
  );
  const raw = readFileChecked(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QuestionChannelError('SCHEMA_INVALID', `Invalid JSON at ${path}`, {
      path,
      cause: err,
    });
  }
  const result = QuestionSchemaWithRecommendationCheck.safeParse(parsed);
  if (!result.success) {
    throw new QuestionChannelError(
      'SCHEMA_INVALID',
      `Schema validation failed for ${path}`,
      { path, zodError: result.error.message },
    );
  }
  return result.data;
}

export function readAnswer(questionId: string, opts: ReadOptions): Answer {
  const path = answerFilePath(
    opts.forgeDir,
    opts.taskId,
    opts.attemptId,
    questionId,
  );
  const raw = readFileChecked(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QuestionChannelError('SCHEMA_INVALID', `Invalid JSON at ${path}`, {
      path,
      cause: err,
    });
  }
  const result = AnswerSchema.safeParse(parsed);
  if (!result.success) {
    throw new QuestionChannelError(
      'SCHEMA_INVALID',
      `Schema validation failed for ${path}`,
      { path, zodError: result.error.message },
    );
  }
  return result.data;
}
