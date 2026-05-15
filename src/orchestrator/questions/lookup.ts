import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Answer, Question } from '../../schemas/questions.ts';
import { QuestionChannelError, isNodeFsError } from './errors.ts';
import {
  answerFilePath,
  attemptsDir,
  questionFilePath,
  tasksRootDir,
  validateIdSegment,
} from './paths.ts';
import { readAnswer, readQuestion } from './reader.ts';

// Lookup helpers operate over the v2 task-keyed tree:
//   .forge/orchestrator/tasks/<task>/attempts/<attempt>/{questions,answers}/<id>.json
//
// They walk the tree and return zod-validated records. Walks tolerate missing
// directories (a task may have no attempts; an attempt may have no questions
// yet) and skip non-canonical entries (`.tmp` files, non-`.json` names). They
// never throw on a single corrupt file — corrupt entries are surfaced via
// optional onSkip callbacks so callers can decide whether to log or fail.
//
// Performance: walks are O(tasks × attempts × files). The CLI verbs that use
// these helpers are human-driven (forge orchestrate answer / questions --open),
// so a directory walk is cheaper than maintaining a global index *until*
// FORGE-20 ships .forge/orchestrator/index/questions.json. At that point this
// module becomes the rebuild fallback documented in spec/ORCHESTRATOR.md
// §"Answer lookup — global index".

function listJsonIds(dir: string): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return [];
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to read directory ${dir}`,
      { path: dir, cause: err },
    );
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.includes('.tmp')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (id.length === 0) continue;
    out.push(id);
  }
  return out;
}

function listSubdirs(dir: string): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [e.name] : [],
    );
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return [];
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to read directory ${dir}`,
      { path: dir, cause: err },
    );
  }
  return entries;
}

export interface FindOptions {
  readonly forgeDir: string;
  readonly onSkip?: (path: string, err: QuestionChannelError) => void;
}

export interface QuestionLocation {
  readonly taskId: string;
  readonly attemptId: string;
  readonly path: string;
}

// Locate a question by global id. Returns the first matching question
// across all (task, attempt) pairs, or null if not found.
export function findQuestionFile(
  questionId: string,
  opts: FindOptions,
): QuestionLocation | null {
  validateIdSegment(questionId, 'questionId');
  const root = tasksRootDir(opts.forgeDir);
  const taskIds = listSubdirs(root);
  for (const taskId of taskIds) {
    // listSubdirs returned this name from readdir, so it is a real dirent.
    // Still validate before path-joining: a hostile file injected by another
    // tool into .forge/orchestrator/tasks/ should not be silently trusted.
    let attempts: readonly string[];
    try {
      attempts = listSubdirs(attemptsDir(opts.forgeDir, taskId));
    } catch (err) {
      if (err instanceof QuestionChannelError && err.code === 'INVALID_ID') {
        opts.onSkip?.(join(root, taskId), err);
        continue;
      }
      throw err;
    }
    for (const attemptId of attempts) {
      let path: string;
      try {
        path = questionFilePath(opts.forgeDir, taskId, attemptId, questionId);
      } catch (err) {
        if (err instanceof QuestionChannelError && err.code === 'INVALID_ID') {
          opts.onSkip?.(join(root, taskId, 'attempts', attemptId), err);
          continue;
        }
        throw err;
      }
      const ids = listJsonIds(
        join(root, taskId, 'attempts', attemptId, 'questions'),
      );
      if (ids.includes(questionId)) {
        return { taskId, attemptId, path };
      }
    }
  }
  return null;
}

// Walk every question across the task tree. Open questions only — those with
// no answer file at the same (task, attempt). Sorted by created_at ascending.
// Returns a fresh array so callers can mutate freely.
export function listOpenQuestionsAcrossTree(
  opts: FindOptions,
): readonly Question[] {
  const root = tasksRootDir(opts.forgeDir);
  const out: Question[] = [];
  for (const taskId of listSubdirs(root)) {
    let attempts: readonly string[];
    try {
      attempts = listSubdirs(attemptsDir(opts.forgeDir, taskId));
    } catch (err) {
      if (err instanceof QuestionChannelError && err.code === 'INVALID_ID') {
        opts.onSkip?.(join(root, taskId), err);
        continue;
      }
      throw err;
    }
    for (const attemptId of attempts) {
      const qDir = join(root, taskId, 'attempts', attemptId, 'questions');
      const aDir = join(root, taskId, 'attempts', attemptId, 'answers');
      const answeredIds = new Set(listJsonIds(aDir));
      for (const id of listJsonIds(qDir)) {
        if (answeredIds.has(id)) continue;
        try {
          const q = readQuestion(id, {
            forgeDir: opts.forgeDir,
            taskId,
            attemptId,
          });
          if (q.status === 'open') out.push(q);
        } catch (err) {
          if (err instanceof QuestionChannelError) {
            opts.onSkip?.(join(qDir, `${id}.json`), err);
            continue;
          }
          throw err;
        }
      }
    }
  }
  out.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return 0;
  });
  return out;
}

export interface DecisionKeyLookupOptions extends FindOptions {
  readonly taskId: string;
}

// Find the most recent OPEN question with the given decision_key across all
// attempts of a single task. Used by respawned workers to detect that the same
// architectural question is already pending — they block on the existing
// question rather than writing a duplicate.
export function findOpenQuestionByDecisionKey(
  decisionKey: string,
  opts: DecisionKeyLookupOptions,
): Question | null {
  const taskId = validateIdSegment(opts.taskId, 'taskId');
  let attempts: readonly string[];
  try {
    attempts = listSubdirs(attemptsDir(opts.forgeDir, taskId));
  } catch (err) {
    if (err instanceof QuestionChannelError && err.code === 'INVALID_ID') {
      return null;
    }
    throw err;
  }
  // Most recent attempt first — sort lexicographically descending. Attempt IDs
  // are UUIDv7 (time-ordered), so lexicographic order matches creation order.
  const sorted = [...attempts].sort().reverse();
  let best: Question | null = null;
  for (const attemptId of sorted) {
    const qDir = join(
      tasksRootDir(opts.forgeDir),
      taskId,
      'attempts',
      attemptId,
      'questions',
    );
    const aDir = join(
      tasksRootDir(opts.forgeDir),
      taskId,
      'attempts',
      attemptId,
      'answers',
    );
    const answeredIds = new Set(listJsonIds(aDir));
    for (const id of listJsonIds(qDir)) {
      if (answeredIds.has(id)) continue;
      let q: Question;
      try {
        q = readQuestion(id, { forgeDir: opts.forgeDir, taskId, attemptId });
      } catch (err) {
        if (err instanceof QuestionChannelError) {
          opts.onSkip?.(join(qDir, `${id}.json`), err);
          continue;
        }
        throw err;
      }
      if (q.status !== 'open') continue;
      if (q.decision_key !== decisionKey) continue;
      if (best === null || q.created_at > best.created_at) {
        best = q;
      }
    }
  }
  return best;
}

export interface AnsweredQuestionMatch {
  readonly question: Question;
  readonly answer: Answer;
}

// Find the most recent ANSWERED question with the given decision_key across
// all attempts of a single task. Used by respawned workers to reuse a prior
// architectural decision without re-asking the supervisor.
export function findAnsweredQuestionByDecisionKey(
  decisionKey: string,
  opts: DecisionKeyLookupOptions,
): AnsweredQuestionMatch | null {
  const taskId = validateIdSegment(opts.taskId, 'taskId');
  let attempts: readonly string[];
  try {
    attempts = listSubdirs(attemptsDir(opts.forgeDir, taskId));
  } catch (err) {
    if (err instanceof QuestionChannelError && err.code === 'INVALID_ID') {
      return null;
    }
    throw err;
  }
  const sorted = [...attempts].sort().reverse();
  let best: AnsweredQuestionMatch | null = null;
  for (const attemptId of sorted) {
    const qDir = join(
      tasksRootDir(opts.forgeDir),
      taskId,
      'attempts',
      attemptId,
      'questions',
    );
    const aDir = join(
      tasksRootDir(opts.forgeDir),
      taskId,
      'attempts',
      attemptId,
      'answers',
    );
    const answeredIds = new Set(listJsonIds(aDir));
    for (const id of listJsonIds(qDir)) {
      if (!answeredIds.has(id)) continue;
      let q: Question;
      let a: Answer;
      try {
        q = readQuestion(id, { forgeDir: opts.forgeDir, taskId, attemptId });
        a = readAnswer(id, { forgeDir: opts.forgeDir, taskId, attemptId });
      } catch (err) {
        if (err instanceof QuestionChannelError) {
          opts.onSkip?.(answerFilePath(opts.forgeDir, taskId, attemptId, id), err);
          continue;
        }
        throw err;
      }
      if (q.decision_key !== decisionKey) continue;
      if (best === null || a.answered_at > best.answer.answered_at) {
        best = { question: q, answer: a };
      }
    }
  }
  return best;
}
