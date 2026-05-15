import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../../../src/schemas/questions.ts';
import {
  readAnswer,
  readQuestion,
} from '../../../../src/orchestrator/questions/reader.ts';
import { listOpenQuestionsAcrossTree } from '../../../../src/orchestrator/questions/lookup.ts';
import {
  QuestionChannelError,
  isQuestionChannelError,
} from '../../../../src/orchestrator/questions/errors.ts';

const TASK_ID = 'FORGE-20';
const ATTEMPT_ID = '0190000000000000a1';

function readOpts(forgeDir: string): { forgeDir: string; taskId: string; attemptId: string } {
  return { forgeDir, taskId: TASK_ID, attemptId: ATTEMPT_ID };
}

function attemptDirOf(forgeDir: string, taskId = TASK_ID, attemptId = ATTEMPT_ID): string {
  return join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId);
}

function baseClassification(): Record<string, unknown> {
  return {
    decision_type: 'architectural',
    category: 'public_api',
    reversibility: 'medium',
    blast_radius: 'module',
    default_action: 'ask',
    reason: 'r',
  };
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: '0190000000000000q1',
    run_id: '0190000000000000r1',
    task_id: TASK_ID,
    agent_id: 'agent-a',
    decision_key: 'k:v:1',
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-05-13T12:00:00.000Z',
    expires_at: '2026-05-13T12:30:00.000Z',
    status: 'open',
    question: 'Q?',
    context: '',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    classification: baseClassification(),
    ...overrides,
  });
}

function makeAnswer(): Answer {
  return {
    version: 1,
    question_id: '0190000000000000q1',
    answered_at: '2026-05-13T12:05:00.000Z',
    answered_by: 'supervisor',
    option_id: 'a',
  };
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-reader-'));
}

// Write a raw payload directly to the v2 task-keyed layout, bypassing the
// atomic-write helpers. Used by tests that need to inject malformed JSON,
// oversized payloads, or pre-corrupted state that the writer would reject.
function writeRaw(
  forgeDir: string,
  kind: 'questions' | 'answers',
  id: string,
  body: string,
  taskId = TASK_ID,
  attemptId = ATTEMPT_ID,
): void {
  const dir = join(attemptDirOf(forgeDir, taskId, attemptId), kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), body);
}

test('readQuestion returns a typed Question on the happy path', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = makeQuestion();
    writeRaw(forgeDir, 'questions', q.question_id, JSON.stringify(q));
    const got = readQuestion(q.question_id, readOpts(forgeDir));
    assert.equal(got.question_id, q.question_id);
    assert.equal(got.options.length, 2);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readAnswer returns a typed Answer on the happy path', () => {
  const forgeDir = freshForgeDir();
  try {
    const a = makeAnswer();
    writeRaw(forgeDir, 'answers', a.question_id, JSON.stringify(a));
    const got = readAnswer(a.question_id, readOpts(forgeDir));
    assert.equal(got.option_id, 'a');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion throws NOT_FOUND on a missing file', () => {
  const forgeDir = freshForgeDir();
  try {
    let caught: unknown;
    try {
      readQuestion('does-not-exist', readOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'NOT_FOUND');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion throws IS_DIRECTORY when the question path is a directory (TOCTOU regression)', () => {
  // Explicit guard from docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md:
  // a directory at the expected file path must surface as a typed error,
  // not as a raw fs error escaping the reader.
  const forgeDir = freshForgeDir();
  try {
    const dir = join(attemptDirOf(forgeDir), 'questions', 'qid.json');
    mkdirSync(dir, { recursive: true });
    let caught: unknown;
    try {
      readQuestion('qid', readOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'IS_DIRECTORY');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion throws OVERSIZED when the file exceeds 64KB', () => {
  const forgeDir = freshForgeDir();
  try {
    // Build raw bytes >64KB without going through the schema (schema would
    // reject a giant context first). The reader's size guard runs BEFORE
    // JSON.parse so a giant junk file is still caught.
    const big = 'x'.repeat(70 * 1024);
    writeRaw(forgeDir, 'questions', 'qid', big);
    let caught: unknown;
    try {
      readQuestion('qid', readOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'OVERSIZED');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion throws SCHEMA_INVALID on malformed JSON', () => {
  const forgeDir = freshForgeDir();
  try {
    writeRaw(forgeDir, 'questions', 'qid', 'not-json');
    let caught: unknown;
    try {
      readQuestion('qid', readOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'SCHEMA_INVALID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion throws SCHEMA_INVALID when JSON does not satisfy the schema', () => {
  const forgeDir = freshForgeDir();
  try {
    writeRaw(forgeDir, 'questions', 'qid', JSON.stringify({ version: 99, hello: 'world' }));
    let caught: unknown;
    try {
      readQuestion('qid', readOpts(forgeDir));
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'SCHEMA_INVALID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('readQuestion rejects a path-traversal taskId with INVALID_ID', () => {
  // FORGE-73 D7: ids interpolated into paths must be regex-validated. A
  // crafted '../' segment must surface a typed INVALID_ID rather than escape
  // into a sibling directory or trip a downstream link failure.
  const forgeDir = freshForgeDir();
  try {
    let caught: unknown;
    try {
      readQuestion('qid', { forgeDir, taskId: '../escape', attemptId: ATTEMPT_ID });
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'INVALID_ID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestionsAcrossTree returns [] when no orchestrator dir exists', () => {
  const forgeDir = freshForgeDir();
  try {
    const list = listOpenQuestionsAcrossTree({ forgeDir });
    assert.deepEqual([...list], []);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestionsAcrossTree filters out questions with a corresponding answer file', () => {
  const forgeDir = freshForgeDir();
  try {
    const q1 = makeQuestion({ question_id: 'q1', created_at: '2026-05-13T12:00:00.000Z' });
    const q2 = makeQuestion({ question_id: 'q2', created_at: '2026-05-13T12:10:00.000Z' });
    const q3 = makeQuestion({ question_id: 'q3', created_at: '2026-05-13T12:20:00.000Z' });
    writeRaw(forgeDir, 'questions', q1.question_id, JSON.stringify(q1));
    writeRaw(forgeDir, 'questions', q2.question_id, JSON.stringify(q2));
    writeRaw(forgeDir, 'questions', q3.question_id, JSON.stringify(q3));
    writeRaw(forgeDir, 'answers', q2.question_id, JSON.stringify({ ...makeAnswer(), question_id: 'q2' }));
    const list = listOpenQuestionsAcrossTree({ forgeDir });
    assert.deepEqual(list.map((q) => q.question_id), ['q1', 'q3']);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestionsAcrossTree sorts results by created_at ascending across multiple tasks/attempts', () => {
  const forgeDir = freshForgeDir();
  try {
    // Spread three questions across two tasks and three attempts to prove
    // the walker descends the full tree, not just one task/attempt.
    const a = makeQuestion({
      question_id: 'late',
      task_id: 'FORGE-21',
      created_at: '2026-05-13T15:00:00.000Z',
      expires_at: '2026-05-13T15:30:00.000Z',
    });
    const b = makeQuestion({
      question_id: 'mid',
      task_id: 'FORGE-20',
      created_at: '2026-05-13T13:00:00.000Z',
      expires_at: '2026-05-13T13:30:00.000Z',
    });
    const c = makeQuestion({
      question_id: 'early',
      task_id: 'FORGE-20',
      created_at: '2026-05-13T11:00:00.000Z',
      expires_at: '2026-05-13T11:30:00.000Z',
    });
    writeRaw(forgeDir, 'questions', a.question_id, JSON.stringify(a), 'FORGE-21', '0190000000000000a2');
    writeRaw(forgeDir, 'questions', b.question_id, JSON.stringify(b), 'FORGE-20', '0190000000000000a3');
    writeRaw(forgeDir, 'questions', c.question_id, JSON.stringify(c), 'FORGE-20', '0190000000000000a1');
    const list = listOpenQuestionsAcrossTree({ forgeDir });
    assert.deepEqual(list.map((q) => q.question_id), ['early', 'mid', 'late']);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestionsAcrossTree skips corrupt files and reports via onSkip', () => {
  const forgeDir = freshForgeDir();
  try {
    const good = makeQuestion({ question_id: 'good' });
    writeRaw(forgeDir, 'questions', good.question_id, JSON.stringify(good));
    writeRaw(forgeDir, 'questions', 'bad', 'not-json');
    const skipped: Array<{ path: string; code: string }> = [];
    const list = listOpenQuestionsAcrossTree({
      forgeDir,
      onSkip: (path, err) => skipped.push({ path, code: err.code }),
    });
    assert.deepEqual(list.map((q) => q.question_id), ['good']);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.code, 'SCHEMA_INVALID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestionsAcrossTree ignores .tmp leftover files', () => {
  const forgeDir = freshForgeDir();
  try {
    const good = makeQuestion({ question_id: 'good' });
    writeRaw(forgeDir, 'questions', good.question_id, JSON.stringify(good));
    // Simulate a temp leftover that link() never cleaned (worst case)
    const dir = join(attemptDirOf(forgeDir), 'questions');
    writeFileSync(join(dir, `good.json.123.4.abc.tmp`), 'junk');
    const list = listOpenQuestionsAcrossTree({ forgeDir });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.question_id, 'good');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
