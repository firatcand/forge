import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QuestionSchemaWithRecommendationCheck,
  type Answer,
  type Question,
} from '../../../../src/schemas/questions.ts';
import {
  findAnsweredQuestionByDecisionKey,
  findOpenQuestionByDecisionKey,
  findQuestionFile,
} from '../../../../src/orchestrator/questions/lookup.ts';
import {
  QuestionChannelError,
  isQuestionChannelError,
} from '../../../../src/orchestrator/questions/errors.ts';

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-lookup-'));
}

function attemptDirOf(forgeDir: string, taskId: string, attemptId: string): string {
  return join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId);
}

function writeRawQuestion(
  forgeDir: string,
  taskId: string,
  attemptId: string,
  q: Question,
): void {
  const dir = join(attemptDirOf(forgeDir, taskId, attemptId), 'questions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${q.question_id}.json`), JSON.stringify(q));
}

function writeRawAnswer(
  forgeDir: string,
  taskId: string,
  attemptId: string,
  a: Answer,
): void {
  const dir = join(attemptDirOf(forgeDir, taskId, attemptId), 'answers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${a.question_id}.json`), JSON.stringify(a));
}

function makeQuestion(overrides: Partial<Question> & { task_id?: string }): Question {
  return QuestionSchemaWithRecommendationCheck.parse({
    version: 1,
    question_id: 'q-default',
    run_id: 'r1',
    task_id: 'FORGE-20',
    agent_id: 'agent-a',
    decision_key: 'k:default:v1',
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-05-13T12:00:00.000Z',
    expires_at: '2026-05-13T12:30:00.000Z',
    status: 'open' as const,
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
    ...overrides,
  });
}

function makeAnswer(questionId: string, answeredAt: string, optionId = 'a'): Answer {
  return {
    version: 1,
    question_id: questionId,
    answered_at: answeredAt,
    answered_by: 'supervisor',
    option_id: optionId,
  };
}

// --- findQuestionFile ---------------------------------------------------------

test('findQuestionFile returns null when no orchestrator tree exists', () => {
  const forgeDir = freshForgeDir();
  try {
    assert.equal(findQuestionFile('q-anything', { forgeDir }), null);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findQuestionFile locates a question across multiple tasks/attempts', () => {
  const forgeDir = freshForgeDir();
  try {
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-a', makeQuestion({ question_id: 'q-other' }));
    writeRawQuestion(forgeDir, 'FORGE-21', 'att-b', makeQuestion({ question_id: 'q-target', task_id: 'FORGE-21' }));
    const loc = findQuestionFile('q-target', { forgeDir });
    assert.ok(loc !== null);
    assert.equal(loc?.taskId, 'FORGE-21');
    assert.equal(loc?.attemptId, 'att-b');
    assert.match(loc?.path ?? '', /FORGE-21\/attempts\/att-b\/questions\/q-target\.json$/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findQuestionFile rejects path-traversal questionId with INVALID_ID', () => {
  const forgeDir = freshForgeDir();
  try {
    let caught: unknown;
    try {
      findQuestionFile('../escape', { forgeDir });
    } catch (err) {
      caught = err;
    }
    assert.ok(isQuestionChannelError(caught));
    assert.equal((caught as QuestionChannelError).code, 'INVALID_ID');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// --- findOpenQuestionByDecisionKey -------------------------------------------

test('findOpenQuestionByDecisionKey finds the most recent open match across attempts', () => {
  const forgeDir = freshForgeDir();
  try {
    // Two attempts on the same task; both have an open question with the same
    // decision_key. Helper returns the most recent (latest created_at).
    const earlier = makeQuestion({
      question_id: 'q-earlier',
      decision_key: 'public-api:foo:v1',
      created_at: '2026-05-13T11:00:00.000Z',
      expires_at: '2026-05-13T11:30:00.000Z',
    });
    const later = makeQuestion({
      question_id: 'q-later',
      decision_key: 'public-api:foo:v1',
      created_at: '2026-05-13T13:00:00.000Z',
      expires_at: '2026-05-13T13:30:00.000Z',
    });
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-1-old', earlier);
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-2-new', later);
    const found = findOpenQuestionByDecisionKey('public-api:foo:v1', {
      forgeDir,
      taskId: 'FORGE-20',
    });
    assert.equal(found?.question_id, 'q-later');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findOpenQuestionByDecisionKey ignores answered questions', () => {
  const forgeDir = freshForgeDir();
  try {
    const q = makeQuestion({ question_id: 'q1', decision_key: 'k:answered:v1' });
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-1', q);
    writeRawAnswer(forgeDir, 'FORGE-20', 'att-1', makeAnswer('q1', '2026-05-13T12:05:00.000Z'));
    assert.equal(
      findOpenQuestionByDecisionKey('k:answered:v1', {
        forgeDir,
        taskId: 'FORGE-20',
      }),
      null,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findOpenQuestionByDecisionKey ignores non-matching decision keys', () => {
  const forgeDir = freshForgeDir();
  try {
    writeRawQuestion(
      forgeDir,
      'FORGE-20',
      'att-1',
      makeQuestion({ question_id: 'q1', decision_key: 'k:other:v1' }),
    );
    assert.equal(
      findOpenQuestionByDecisionKey('k:looking-for:v1', {
        forgeDir,
        taskId: 'FORGE-20',
      }),
      null,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findOpenQuestionByDecisionKey returns null on missing tree', () => {
  const forgeDir = freshForgeDir();
  try {
    assert.equal(
      findOpenQuestionByDecisionKey('k:any:v1', {
        forgeDir,
        taskId: 'FORGE-20',
      }),
      null,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// --- findAnsweredQuestionByDecisionKey ---------------------------------------

test('findAnsweredQuestionByDecisionKey finds the most recent prior answer', () => {
  const forgeDir = freshForgeDir();
  try {
    const q1 = makeQuestion({
      question_id: 'q-earlier',
      decision_key: 'k:reuse:v1',
      created_at: '2026-05-13T11:00:00.000Z',
      expires_at: '2026-05-13T11:30:00.000Z',
    });
    const q2 = makeQuestion({
      question_id: 'q-later',
      decision_key: 'k:reuse:v1',
      created_at: '2026-05-13T13:00:00.000Z',
      expires_at: '2026-05-13T13:30:00.000Z',
    });
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-1', q1);
    writeRawAnswer(forgeDir, 'FORGE-20', 'att-1', makeAnswer('q-earlier', '2026-05-13T11:05:00.000Z', 'a'));
    writeRawQuestion(forgeDir, 'FORGE-20', 'att-2', q2);
    writeRawAnswer(forgeDir, 'FORGE-20', 'att-2', makeAnswer('q-later', '2026-05-13T13:05:00.000Z', 'b'));
    const match = findAnsweredQuestionByDecisionKey('k:reuse:v1', {
      forgeDir,
      taskId: 'FORGE-20',
    });
    assert.ok(match !== null);
    assert.equal(match?.question.question_id, 'q-later');
    assert.equal(match?.answer.option_id, 'b');
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('findAnsweredQuestionByDecisionKey returns null when matching key is only open (not answered)', () => {
  const forgeDir = freshForgeDir();
  try {
    writeRawQuestion(
      forgeDir,
      'FORGE-20',
      'att-1',
      makeQuestion({ question_id: 'q1', decision_key: 'k:open:v1' }),
    );
    assert.equal(
      findAnsweredQuestionByDecisionKey('k:open:v1', {
        forgeDir,
        taskId: 'FORGE-20',
      }),
      null,
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
