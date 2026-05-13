import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QuestionSchemaWithRecommendationCheck,
  type Question,
} from '../../../../src/schemas/questions.ts';
import { writeQuestionAtomic } from '../../../../src/orchestrator/questions/writer.ts';
import {
  createQuestionWatcher,
  type QuestionWatcherEvent,
} from '../../../../src/orchestrator/questions/watcher.ts';
import type { QuestionChannelError } from '../../../../src/orchestrator/questions/errors.ts';

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

function makeQuestion(id: string): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: id,
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
  });
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-watcher-'));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('watcher fires a typed event when a question is written via writeQuestionAtomic', async () => {
  const forgeDir = freshForgeDir();
  const events: QuestionWatcherEvent[] = [];
  const errors: QuestionChannelError[] = [];
  const watcher = createQuestionWatcher({
    forgeDir,
    debounceMs: 10,
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  try {
    // Give the watcher a tick to register before the write.
    await delay(20);
    const q = makeQuestion('qWatch1');
    writeQuestionAtomic(q, { forgeDir });
    // Wait long enough for fs.watch + debounce + handleSettled.
    await delay(120);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.map((e) => e.code).join(',')}`);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'new_question');
    assert.equal(events[0]?.questionId, 'qWatch1');
    assert.equal(events[0]?.question.question_id, 'qWatch1');
  } finally {
    watcher.stop();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('watcher debounces rapid events on the same filename to a single read', async () => {
  const forgeDir = freshForgeDir();
  const events: QuestionWatcherEvent[] = [];
  const errors: QuestionChannelError[] = [];
  const watcher = createQuestionWatcher({
    forgeDir,
    debounceMs: 30,
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  try {
    await delay(20);
    const q = makeQuestion('qDebounce');
    writeQuestionAtomic(q, { forgeDir });
    // Touch the file multiple times within the debounce window.
    const path = join(forgeDir, 'questions', `${q.question_id}.json`);
    writeFileSync(path, JSON.stringify(q));
    writeFileSync(path, JSON.stringify(q));
    await delay(120);
    assert.equal(errors.length, 0);
    assert.equal(events.length, 1, `expected exactly one event, got ${events.length}`);
  } finally {
    watcher.stop();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('watcher does not fire for .tmp leftover files', async () => {
  const forgeDir = freshForgeDir();
  const events: QuestionWatcherEvent[] = [];
  const errors: QuestionChannelError[] = [];
  const watcher = createQuestionWatcher({
    forgeDir,
    debounceMs: 10,
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  try {
    await delay(20);
    const dir = join(forgeDir, 'questions');
    mkdirSync(dir, { recursive: true });
    // A bare .tmp file should be ignored entirely.
    writeFileSync(join(dir, 'foo.json.123.4.abc.tmp'), 'junk');
    await delay(80);
    assert.equal(events.length, 0);
  } finally {
    watcher.stop();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('watcher.stop() prevents further event delivery', async () => {
  const forgeDir = freshForgeDir();
  const events: QuestionWatcherEvent[] = [];
  const errors: QuestionChannelError[] = [];
  const watcher = createQuestionWatcher({
    forgeDir,
    debounceMs: 10,
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  await delay(20);
  watcher.stop();
  // After stop(), writes should not deliver events.
  const q = makeQuestion('qAfterStop');
  writeQuestionAtomic(q, { forgeDir });
  await delay(80);
  try {
    assert.equal(events.length, 0);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('watcher reports an error when a written file is corrupt JSON', async () => {
  const forgeDir = freshForgeDir();
  const events: QuestionWatcherEvent[] = [];
  const errors: QuestionChannelError[] = [];
  const watcher = createQuestionWatcher({
    forgeDir,
    debounceMs: 10,
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  try {
    await delay(20);
    const dir = join(forgeDir, 'questions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'corrupt.json'), 'not json');
    await delay(120);
    assert.equal(events.length, 0);
    assert.equal(errors.length >= 1, true);
    assert.equal(errors[0]?.code, 'SCHEMA_INVALID');
  } finally {
    watcher.stop();
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
