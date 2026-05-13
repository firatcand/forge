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
  listOpenQuestions,
  readAnswer,
  readQuestion,
} from '../../../../src/orchestrator/questions/reader.ts';
import {
  QuestionChannelError,
  isQuestionChannelError,
} from '../../../../src/orchestrator/questions/errors.ts';

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
    task_id: 'FORGE-20',
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

function writeRaw(forgeDir: string, kind: 'questions' | 'answers', id: string, body: string): void {
  const dir = join(forgeDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), body);
}

test('readQuestion returns a typed Question on the happy path', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = makeQuestion();
    writeRaw(forgeDir, 'questions', q.question_id, JSON.stringify(q));
    const got = readQuestion(q.question_id, { forgeDir });
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
    const got = readAnswer(a.question_id, { forgeDir });
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
      readQuestion('does-not-exist', { forgeDir });
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
    const dir = join(forgeDir, 'questions', 'qid.json');
    mkdirSync(dir, { recursive: true });
    let caught: unknown;
    try {
      readQuestion('qid', { forgeDir });
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
      readQuestion('qid', { forgeDir });
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
      readQuestion('qid', { forgeDir });
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
      readQuestion('qid', { forgeDir });
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'SCHEMA_INVALID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestions returns [] when the questions directory does not exist', () => {
  const forgeDir = freshForgeDir();
  try {
    const list = listOpenQuestions({ forgeDir });
    assert.deepEqual([...list], []);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestions filters out questions with a corresponding answer file', () => {
  const forgeDir = freshForgeDir();
  try {
    const q1 = makeQuestion({ question_id: 'q1', created_at: '2026-05-13T12:00:00.000Z' });
    const q2 = makeQuestion({ question_id: 'q2', created_at: '2026-05-13T12:10:00.000Z' });
    const q3 = makeQuestion({ question_id: 'q3', created_at: '2026-05-13T12:20:00.000Z' });
    writeRaw(forgeDir, 'questions', q1.question_id, JSON.stringify(q1));
    writeRaw(forgeDir, 'questions', q2.question_id, JSON.stringify(q2));
    writeRaw(forgeDir, 'questions', q3.question_id, JSON.stringify(q3));
    writeRaw(forgeDir, 'answers', q2.question_id, JSON.stringify({ ...makeAnswer(), question_id: 'q2' }));
    const list = listOpenQuestions({ forgeDir });
    assert.deepEqual(list.map((q) => q.question_id), ['q1', 'q3']);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestions sorts results by created_at ascending', () => {
  const forgeDir = freshForgeDir();
  try {
    const a = makeQuestion({
      question_id: 'late',
      created_at: '2026-05-13T15:00:00.000Z',
      expires_at: '2026-05-13T15:30:00.000Z',
    });
    const b = makeQuestion({
      question_id: 'mid',
      created_at: '2026-05-13T13:00:00.000Z',
      expires_at: '2026-05-13T13:30:00.000Z',
    });
    const c = makeQuestion({
      question_id: 'early',
      created_at: '2026-05-13T11:00:00.000Z',
      expires_at: '2026-05-13T11:30:00.000Z',
    });
    for (const q of [a, b, c]) {
      writeRaw(forgeDir, 'questions', q.question_id, JSON.stringify(q));
    }
    const list = listOpenQuestions({ forgeDir });
    assert.deepEqual(list.map((q) => q.question_id), ['early', 'mid', 'late']);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('listOpenQuestions skips corrupt files and reports via onSkip', () => {
  const forgeDir = freshForgeDir();
  try {
    const good = makeQuestion({ question_id: 'good' });
    writeRaw(forgeDir, 'questions', good.question_id, JSON.stringify(good));
    writeRaw(forgeDir, 'questions', 'bad', 'not-json');
    const skipped: Array<{ path: string; code: string }> = [];
    const list = listOpenQuestions({
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

test('listOpenQuestions ignores .tmp leftover files', () => {
  const forgeDir = freshForgeDir();
  try {
    const good = makeQuestion({ question_id: 'good' });
    writeRaw(forgeDir, 'questions', good.question_id, JSON.stringify(good));
    // Simulate a temp leftover that link() never cleaned (worst case)
    const dir = join(forgeDir, 'questions');
    writeFileSync(join(dir, `good.json.123.4.abc.tmp`), 'junk');
    const list = listOpenQuestions({ forgeDir });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.question_id, 'good');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
