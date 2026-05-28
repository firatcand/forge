import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import {
  validateClassification,
  ClassificationError,
  resolveBudget,
  computeTaskBudget,
  buildSoftCapWarning,
  gateQuestion,
  type ResolvedBudget,
} from '../../../src/orchestrator/decision-classifier.ts';
import {
  writeQuestionAtomic,
  writeAnswerAtomic,
} from '../../../src/orchestrator/questions/index.ts';
import type { Question, DecisionClassification } from '../../../src/schemas/questions.ts';

const TASK = 'FORGE-1';
const BUDGET: ResolvedBudget = { soft: 3, hard: 6 };

const VALID_CLASSIFICATION: DecisionClassification = {
  decision_type: 'architectural',
  category: 'public_api',
  reversibility: 'medium',
  blast_radius: 'module',
  default_action: 'ask',
  reason: 'public surface change',
};

function tmpForge(): string {
  return join(mkdtempSync(join(tmpdir(), 'forge-dc-')), '.forge');
}

function mkQuestion(decisionKey: string): Question {
  const now = new Date();
  return {
    version: 1,
    question_id: uuidv7(),
    run_id: uuidv7(),
    task_id: TASK,
    agent_id: 'worker',
    decision_key: decisionKey,
    attempt: 1,
    max_attempts: 3,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    status: 'open',
    question: `Q for ${decisionKey}?`,
    context: '',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
    classification: VALID_CLASSIFICATION,
    // NOTE: deliberately omit recommended_option_id / what_happens_if_unanswered
    // — the dedupe scan must still read these (legacy-shaped) files (Q2).
  };
}

function seedQuestion(forgeDir: string, attemptId: string, q: Question): Question {
  writeQuestionAtomic(q, { forgeDir, taskId: TASK, attemptId });
  return q;
}

function seedAnswer(forgeDir: string, attemptId: string, questionId: string, optionId: string): void {
  writeAnswerAtomic(
    {
      version: 1,
      question_id: questionId,
      answered_at: new Date().toISOString(),
      answered_by: 'supervisor',
      option_id: optionId,
    },
    { forgeDir, taskId: TASK, attemptId },
  );
}

// --- AC1: classification validation -----------------------------------------

test('validateClassification: accepts a well-formed classification', () => {
  const out = validateClassification(VALID_CLASSIFICATION);
  assert.deepEqual(out, VALID_CLASSIFICATION);
});

test('validateClassification: rejects a missing field with ClassificationError', () => {
  const { decision_type, ...missing } = VALID_CLASSIFICATION;
  void decision_type;
  assert.throws(() => validateClassification(missing), ClassificationError);
});

test('validateClassification: rejects a bad enum value with ClassificationError', () => {
  assert.throws(
    () => validateClassification({ ...VALID_CLASSIFICATION, blast_radius: 'galactic' }),
    ClassificationError,
  );
});

test('validateClassification: rejects a non-object with ClassificationError', () => {
  assert.throws(() => validateClassification('nope'), ClassificationError);
});

// --- AC6 / AC7: budget math --------------------------------------------------

test('resolveBudget: per-task override wins per-member; unset falls back to global', () => {
  assert.deepEqual(resolveBudget(BUDGET, { soft: 2 }), { soft: 2, hard: 6 });
  assert.deepEqual(resolveBudget(BUDGET, { hard: 9 }), { soft: 3, hard: 9 });
  assert.deepEqual(resolveBudget(BUDGET, undefined), { soft: 3, hard: 6 });
});

test('computeTaskBudget: counts question files across all attempts', () => {
  const forgeDir = tmpForge();
  seedQuestion(forgeDir, 'attempt-1', mkQuestion('k1'));
  seedQuestion(forgeDir, 'attempt-1', mkQuestion('k2'));
  seedQuestion(forgeDir, 'attempt-2', mkQuestion('k3'));
  const state = computeTaskBudget({ forgeDir, taskId: TASK, budget: BUDGET });
  assert.equal(state.count, 3);
  assert.equal(state.softExceeded, true); // 3 >= soft 3
  assert.equal(state.hardReached, false); // 3 < hard 6
});

test('computeTaskBudget: empty task → count 0, neither cap reached', () => {
  const forgeDir = tmpForge();
  const state = computeTaskBudget({ forgeDir, taskId: TASK, budget: BUDGET });
  assert.equal(state.count, 0);
  assert.equal(state.softExceeded, false);
  assert.equal(state.hardReached, false);
});

test('buildSoftCapWarning: mentions the counts', () => {
  const w = buildSoftCapWarning({ count: 4, soft: 3, hard: 6, softExceeded: true, hardReached: false });
  assert.match(w, /4/);
  assert.match(w, /hard cap 6/);
});

// --- AC4 / AC5 / AC7: the gate -----------------------------------------------

test('gateQuestion: clean slate → write, no soft-cap warning', () => {
  const forgeDir = tmpForge();
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'fresh:key',
    budget: BUDGET,
    recommendedOptionId: 'yes',
    defaultAction: 'ask',
  });
  assert.equal(outcome.kind, 'write');
  if (outcome.kind === 'write') assert.equal(outcome.softCapWarning, undefined);
});

test('gateQuestion: prior answer for the decision_key → reuse (AC4)', () => {
  const forgeDir = tmpForge();
  const q = seedQuestion(forgeDir, 'attempt-1', mkQuestion('arch:reuse-me'));
  seedAnswer(forgeDir, 'attempt-1', q.question_id, 'yes');
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'arch:reuse-me',
    budget: BUDGET,
    recommendedOptionId: 'yes',
  });
  assert.equal(outcome.kind, 'reuse');
  if (outcome.kind === 'reuse') {
    assert.equal(outcome.answer.option_id, 'yes');
    assert.equal(outcome.question.question_id, q.question_id);
  }
});

test('gateQuestion: open question for the decision_key → block_on_existing (AC5)', () => {
  const forgeDir = tmpForge();
  const q = seedQuestion(forgeDir, 'attempt-1', mkQuestion('arch:pending')); // no answer
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'arch:pending',
    budget: BUDGET,
    recommendedOptionId: 'yes',
  });
  assert.equal(outcome.kind, 'block_on_existing');
  if (outcome.kind === 'block_on_existing') {
    assert.equal(outcome.question.question_id, q.question_id);
  }
});

test('gateQuestion: reuse beats block when both exist for the same key', () => {
  const forgeDir = tmpForge();
  // attempt-1: answered; attempt-2: a fresh open question, same key.
  const answered = seedQuestion(forgeDir, 'attempt-1', mkQuestion('arch:both'));
  seedAnswer(forgeDir, 'attempt-1', answered.question_id, 'no');
  seedQuestion(forgeDir, 'attempt-2', mkQuestion('arch:both'));
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'arch:both',
    budget: BUDGET,
    recommendedOptionId: 'yes',
  });
  assert.equal(outcome.kind, 'reuse');
});

test('gateQuestion: soft cap crossed (new key) → write WITH soft-cap warning (AC6)', () => {
  const forgeDir = tmpForge();
  // 3 distinct prior questions → count 3 == soft.
  seedQuestion(forgeDir, 'attempt-1', mkQuestion('k1'));
  seedQuestion(forgeDir, 'attempt-1', mkQuestion('k2'));
  seedQuestion(forgeDir, 'attempt-1', mkQuestion('k3'));
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'k4-new',
    budget: BUDGET,
    recommendedOptionId: 'yes',
  });
  assert.equal(outcome.kind, 'write');
  if (outcome.kind === 'write') {
    assert.ok(outcome.softCapWarning, 'expected a soft-cap warning');
  }
});

test('gateQuestion: hard cap reached (new key) → forced_autonomous with recommended option (AC7)', () => {
  const forgeDir = tmpForge();
  for (let i = 0; i < 6; i++) seedQuestion(forgeDir, 'attempt-1', mkQuestion(`k${i}`));
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'k-new',
    budget: BUDGET,
    recommendedOptionId: 'yes',
    defaultAction: 'ask',
  });
  assert.equal(outcome.kind, 'forced_autonomous');
  if (outcome.kind === 'forced_autonomous') {
    assert.equal(outcome.chosenOptionId, 'yes');
    assert.match(outcome.reason, /hard_cap/);
  }
});

test('gateQuestion: hard cap with no recommendation → forced_autonomous, falls back to default_action', () => {
  const forgeDir = tmpForge();
  for (let i = 0; i < 6; i++) seedQuestion(forgeDir, 'attempt-1', mkQuestion(`k${i}`));
  const outcome = gateQuestion({
    forgeDir,
    taskId: TASK,
    decisionKey: 'k-new',
    budget: BUDGET,
    defaultAction: 'decide',
  });
  assert.equal(outcome.kind, 'forced_autonomous');
  if (outcome.kind === 'forced_autonomous') {
    assert.equal(outcome.chosenOptionId, null);
    assert.match(outcome.reason, /default_action 'decide'/);
  }
});
