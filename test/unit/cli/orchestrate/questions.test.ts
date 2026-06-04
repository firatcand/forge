import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  QuestionSchemaWithRecommendationCheck,
  type Question,
} from '../../../../src/schemas/questions.ts';
import { runOrchestrateQuestions } from '../../../../src/cli/orchestrate/questions.ts';

function makeQuestion(id: string, created: string, expires: string): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: id,
    run_id: 'r1',
    task_id: 'FORGE-20',
    agent_id: 'agent-a',
    decision_key: `key:${id}`,
    attempt: 1,
    max_attempts: 3,
    created_at: created,
    expires_at: expires,
    status: 'open',
    question: `What about ${id}?`,
    context: '',
    options: [
      { id: 'a', label: 'A', description: 'first' },
      { id: 'b', label: 'B' },
    ],
    recommended_option_id: 'a',
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

// Default attempt id for tests; tests with multi-attempt fixtures override it.
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
  return mkdtempSync(join(tmpdir(), 'forge-cli-q-'));
}

test('orchestrate questions --open prints "No open questions." when none exist', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    const result = runOrchestrateQuestions({ open: true, forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 0);
    assert.match(out(), /No open questions\./);
    assert.equal(err(), '');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions --open lists open questions sorted by created_at', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('q-late', '2026-05-13T15:00:00.000Z', '2026-05-13T15:30:00.000Z'));
    writeQ(forgeDir, makeQuestion('q-early', '2026-05-13T11:00:00.000Z', '2026-05-13T11:30:00.000Z'));
    const result = runOrchestrateQuestions({ open: true, forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 0);
    const output = out();
    const earlyIdx = output.indexOf('q-early');
    const lateIdx = output.indexOf('q-late');
    assert.ok(earlyIdx >= 0 && lateIdx >= 0);
    assert.ok(earlyIdx < lateIdx, 'q-early must precede q-late');
    assert.match(output, /Options:/);
    assert.match(output, /Recommended:/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions filters out questions that already have an answer', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('open-1', '2026-05-13T12:00:00.000Z', '2026-05-13T12:30:00.000Z'));
    writeQ(forgeDir, makeQuestion('answered-1', '2026-05-13T12:00:00.000Z', '2026-05-13T12:30:00.000Z'));
    writeAnswerRaw(
      forgeDir,
      'FORGE-20',
      'answered-1',
      JSON.stringify({
        version: 1,
        question_id: 'answered-1',
        answered_at: '2026-05-13T12:10:00.000Z',
        answered_by: 'supervisor',
        option_id: 'a',
      }),
    );
    const result = runOrchestrateQuestions({ open: true, forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 0);
    const output = out();
    assert.match(output, /open-1/);
    assert.equal(output.includes('answered-1'), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions without --open prints usage and exits 1', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const result = runOrchestrateQuestions({ open: false, forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /Usage: forge orchestrate questions/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions surfaces corrupt files via stderr but still lists valid ones', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestion('good', '2026-05-13T12:00:00.000Z', '2026-05-13T12:30:00.000Z'));
    const corruptDir = join(attemptDirOf(forgeDir, 'FORGE-20'), 'questions');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'bad.json'), 'not json');
    const result = runOrchestrateQuestions({ open: true, forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 0);
    assert.match(out(), /good/);
    assert.match(err(), /\[warn\] skipping/);
    assert.match(err(), /SCHEMA_INVALID/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── --json + --run filter tests (FORGE-98) ──────────────────────────────────

// Build a question with a caller-chosen run_id. The default makeQuestion()
// hard-codes 'r1', which can't exercise the per-run filter.
function makeQuestionWithRun(id: string, runId: string, taskId = 'FORGE-20'): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: id,
    run_id: runId,
    task_id: taskId,
    agent_id: 'agent-a',
    decision_key: `key:${id}`,
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-05-18T01:00:00.000Z',
    expires_at: '2026-05-18T01:30:00.000Z',
    status: 'open',
    question: `What about ${id}?`,
    context: '',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    recommended_option_id: 'a',
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

// Synthetic UUIDv7s (version nibble = 7, variant nibble = 8/9/a/b).
const RUN_A = '01900000-0000-7000-8000-00000000000a';
const RUN_B = '01900000-0000-7000-8000-00000000000b';

test('orchestrate questions --open --json emits envelope JSON with full questions array', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestionWithRun('q1', RUN_A));
    writeQ(forgeDir, makeQuestionWithRun('q2', RUN_A));
    const result = runOrchestrateQuestions({ open: true, forgeDir, json: true, stdout, stderr });
    assert.equal(result.exitCode, 0);

    const payload = JSON.parse(out().trim());
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.data.questions));
    assert.equal(payload.data.questions.length, 2);
    // Each entry preserves the canonical Question fields the skill needs.
    for (const q of payload.data.questions) {
      assert.ok(q.question_id);
      assert.ok(q.run_id);
      assert.ok(q.task_id);
      assert.ok(q.decision_key);
      assert.ok(Array.isArray(q.options));
      assert.ok(q.classification);
    }
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions --open --json --run <id> filters to matching run_id', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeQ(forgeDir, makeQuestionWithRun('q-a-1', RUN_A));
    writeQ(forgeDir, makeQuestionWithRun('q-a-2', RUN_A));
    writeQ(forgeDir, makeQuestionWithRun('q-b-1', RUN_B));
    const result = runOrchestrateQuestions({
      open: true,
      forgeDir,
      json: true,
      runId: RUN_A,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 0);

    const payload = JSON.parse(out().trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.data.questions.length, 2);
    for (const q of payload.data.questions) {
      assert.equal(q.run_id, RUN_A);
    }
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions --json without --open returns USAGE envelope (exit 1)', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    const result = runOrchestrateQuestions({ open: false, forgeDir, json: true, stdout, stderr });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(out().trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'USAGE');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate questions --open --run <bad> rejects malformed run_id', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    const result = runOrchestrateQuestions({
      open: true,
      forgeDir,
      json: true,
      runId: 'not-a-uuid',
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(out().trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_ARGS');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
