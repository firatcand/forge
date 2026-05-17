import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../../../src/schemas/questions.ts';
import { runOrchestrateAnswer } from '../../../../src/cli/orchestrate/answer.ts';

function makeQuestion(id: string): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: id,
    run_id: 'r1',
    task_id: 'FORGE-20',
    agent_id: 'agent-a',
    decision_key: `key:${id}`,
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
    classification: {
      decision_type: 'architectural',
      category: 'public_api',
      reversibility: 'medium',
      blast_radius: 'module',
      default_action: 'ask',
      reason: 'r',
    },
  });
}

const DEFAULT_ATTEMPT = '0190000000000000a1';

function attemptDirOf(forgeDir: string, taskId: string, attemptId = DEFAULT_ATTEMPT): string {
  return join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId);
}

function writeQ(forgeDir: string, q: Question, attemptId = DEFAULT_ATTEMPT): void {
  const dir = join(attemptDirOf(forgeDir, q.task_id, attemptId), 'questions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${q.question_id}.json`), JSON.stringify(q));
}

function writeAnswerRaw(
  forgeDir: string,
  taskId: string,
  questionId: string,
  body: string,
  attemptId = DEFAULT_ATTEMPT,
): void {
  const dir = join(attemptDirOf(forgeDir, taskId, attemptId), 'answers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${questionId}.json`), body);
}

function answerPathFor(
  forgeDir: string,
  taskId: string,
  questionId: string,
  attemptId = DEFAULT_ATTEMPT,
): string {
  return join(attemptDirOf(forgeDir, taskId, attemptId), 'answers', `${questionId}.json`);
}

function captureStreams(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on('data', (c: Buffer) => outChunks.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-cli-a-'));
}

const fixedNow = (): Date => new Date('2026-05-13T13:00:00.000Z');

test('orchestrate answer happy path writes the answer atomically and exits 0', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('q1'));
    const result = runOrchestrateAnswer({
      questionId: 'q1',
      optionId: 'a',
      forgeDir,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0, `stderr was: ${err()}`);
    assert.match(out(), /Answered q1 with option a\./);
    const answer = JSON.parse(
      readFileSync(answerPathFor(forgeDir, 'FORGE-20', 'q1'), 'utf8'),
    ) as Answer;
    assert.equal(answer.question_id, 'q1');
    assert.equal(answer.option_id, 'a');
    assert.equal(answer.answered_at, '2026-05-13T13:00:00.000Z');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate answer with --note persists the note', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('q1'));
    const result = runOrchestrateAnswer({
      questionId: 'q1',
      optionId: 'a',
      note: 'because reasons',
      forgeDir,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0);
    const answer = JSON.parse(
      readFileSync(answerPathFor(forgeDir, 'FORGE-20', 'q1'), 'utf8'),
    ) as Answer;
    assert.equal(answer.note, 'because reasons');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate answer with an unknown option id exits 1 and lists valid ids', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('q1'));
    const result = runOrchestrateAnswer({
      questionId: 'q1',
      optionId: 'z',
      forgeDir,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /invalid option 'z'/);
    assert.match(err(), /Valid: a, b/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate answer on a missing question exits 1 with NOT_FOUND', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const result = runOrchestrateAnswer({
      questionId: 'never-existed',
      optionId: 'a',
      forgeDir,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /NOT_FOUND/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate answer refuses to overwrite an already-answered question', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('q1'));
    writeAnswerRaw(
      forgeDir,
      'FORGE-20',
      'q1',
      JSON.stringify({
        version: 1,
        question_id: 'q1',
        answered_at: '2026-05-13T12:05:00.000Z',
        answered_by: 'supervisor',
        option_id: 'a',
      }),
    );
    const result = runOrchestrateAnswer({
      questionId: 'q1',
      optionId: 'b',
      forgeDir,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /already been answered/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate answer with missing args prints usage and exits 1', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const result = runOrchestrateAnswer({
      questionId: '',
      optionId: '',
      forgeDir,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /Usage: forge orchestrate answer/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
