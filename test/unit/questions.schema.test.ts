import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnswerSchema,
  DECISION_CATEGORIES,
  DecisionClassificationSchema,
  QUESTION_FILE_MAX_BYTES,
  QuestionSchema,
  QuestionSchemaWithRecommendationCheck,
} from '../../src/schemas/questions.ts';

function baseClassification(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    decision_type: 'architectural',
    category: 'public_api',
    reversibility: 'medium',
    blast_radius: 'module',
    default_action: 'ask',
    reason: 'Affects exported API surface.',
    ...overrides,
  };
}

function baseQuestion(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    question_id: '0190000000000000q1',
    run_id: '0190000000000000r1',
    task_id: 'FORGE-20',
    agent_id: 'agent-a',
    decision_key: 'public-api:dispatcher-events:v1',
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-05-13T12:00:00.000Z',
    expires_at: '2026-05-13T12:30:00.000Z',
    status: 'open',
    question: 'Should dispatcher emit `phase_transition` events on the notification stream?',
    context: 'Per ORCHESTRATOR.md the stream is filtered to question/question_resolved/fatal only.',
    options: [
      { id: 'no', label: 'No — keep stream filtered', description: 'Honor the contract.' },
      { id: 'yes', label: 'Yes — emit transitions', description: 'More observable.' },
    ],
    recommended_option_id: 'no',
    what_happens_if_unanswered: 'Default to filtered stream per spec.',
    classification: baseClassification(),
    ...overrides,
  };
}

function baseAnswer(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    question_id: '0190000000000000q1',
    answered_at: '2026-05-13T12:05:00.000Z',
    answered_by: 'supervisor',
    option_id: 'no',
    note: 'Stick with the filtered design.',
    ...overrides,
  };
}

test('QuestionSchema accepts a valid question', () => {
  const result = QuestionSchema.safeParse(baseQuestion());
  assert.equal(result.success, true);
});

test('QuestionSchema rejects unknown version', () => {
  const result = QuestionSchema.safeParse(baseQuestion({ version: 2 }));
  assert.equal(result.success, false);
});

test('QuestionSchema rejects empty options', () => {
  const result = QuestionSchema.safeParse(baseQuestion({ options: [] }));
  assert.equal(result.success, false);
});

test('QuestionSchema rejects single option', () => {
  const result = QuestionSchema.safeParse(
    baseQuestion({ options: [{ id: 'a', label: 'A' }] }),
  );
  assert.equal(result.success, false);
});

test('QuestionSchema rejects more than 10 options', () => {
  const options = Array.from({ length: 11 }, (_, i) => ({
    id: `o${i}`,
    label: `opt ${i}`,
  }));
  const result = QuestionSchema.safeParse(baseQuestion({ options }));
  assert.equal(result.success, false);
});

test('QuestionSchema enforces attempt <= max_attempts is not a schema rule (handled at runtime)', () => {
  // The schema does NOT enforce attempt <= max_attempts. That's a state-machine
  // invariant enforced by the dispatcher, not a static schema constraint. We
  // document this here so a future change to the schema is intentional.
  const result = QuestionSchema.safeParse(
    baseQuestion({ attempt: 4, max_attempts: 3 }),
  );
  assert.equal(result.success, true);
});

test('QuestionSchemaWithRecommendationCheck rejects recommended_option_id that does not exist', () => {
  const result = QuestionSchemaWithRecommendationCheck.safeParse(
    baseQuestion({ recommended_option_id: 'ghost' }),
  );
  assert.equal(result.success, false);
});

test('QuestionSchemaWithRecommendationCheck accepts a question without recommended_option_id', () => {
  const q = baseQuestion();
  delete (q as Record<string, unknown>).recommended_option_id;
  const result = QuestionSchemaWithRecommendationCheck.safeParse(q);
  assert.equal(result.success, true);
});

test('QuestionSchemaWithRecommendationCheck rejects expires_at <= created_at', () => {
  const result = QuestionSchemaWithRecommendationCheck.safeParse(
    baseQuestion({
      created_at: '2026-05-13T12:30:00.000Z',
      expires_at: '2026-05-13T12:00:00.000Z',
    }),
  );
  assert.equal(result.success, false);
});

test('QuestionSchemaWithRecommendationCheck rejects expires_at equal to created_at', () => {
  const result = QuestionSchemaWithRecommendationCheck.safeParse(
    baseQuestion({
      created_at: '2026-05-13T12:00:00.000Z',
      expires_at: '2026-05-13T12:00:00.000Z',
    }),
  );
  assert.equal(result.success, false);
});

test('DecisionClassificationSchema accepts a routine classification', () => {
  const result = DecisionClassificationSchema.safeParse(
    baseClassification({
      decision_type: 'routine',
      category: 'other',
      reversibility: 'high',
      blast_radius: 'local',
      default_action: 'decide',
      reason: 'Local variable rename.',
    }),
  );
  assert.equal(result.success, true);
});

// FORGE-216: typed taxonomy — back-compat + additive coverage.
const OLD_CATEGORIES = [
  'public_api',
  'scope',
  'naming',
  'deprecation',
  'error_semantics',
  'file_lifecycle',
  'other',
] as const;
const NEW_CATEGORIES = [
  'schema_shape',
  'compat_policy',
  'enforcement_mode',
  'scope_cut',
  'provider_choice',
  'release',
  'security_tradeoff',
] as const;

test('FORGE-216: DECISION_CATEGORIES is a superset of the original FORGE-65 values', () => {
  for (const old of OLD_CATEGORIES) {
    assert.ok(
      (DECISION_CATEGORIES as readonly string[]).includes(old),
      `expected DECISION_CATEGORIES to still include legacy value '${old}'`,
    );
  }
  // other stays the last value (fallback).
  assert.equal(DECISION_CATEGORIES[DECISION_CATEGORIES.length - 1], 'other');
});

for (const old of OLD_CATEGORIES) {
  test(`FORGE-216: DecisionClassificationSchema still parses legacy category '${old}'`, () => {
    const result = DecisionClassificationSchema.safeParse(
      baseClassification({ category: old }),
    );
    assert.equal(result.success, true);
  });
}

for (const next of NEW_CATEGORIES) {
  test(`FORGE-216: DecisionClassificationSchema parses new category '${next}'`, () => {
    const result = DecisionClassificationSchema.safeParse(
      baseClassification({ category: next }),
    );
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.category, next);
    }
  });
}

test('DecisionClassificationSchema rejects unknown category', () => {
  const result = DecisionClassificationSchema.safeParse(
    baseClassification({ category: 'feelings' }),
  );
  assert.equal(result.success, false);
});

test('DecisionClassificationSchema rejects empty reason', () => {
  const result = DecisionClassificationSchema.safeParse(
    baseClassification({ reason: '' }),
  );
  assert.equal(result.success, false);
});

test('AnswerSchema accepts a valid answer', () => {
  const result = AnswerSchema.safeParse(baseAnswer());
  assert.equal(result.success, true);
});

test('AnswerSchema applies default answered_by', () => {
  const a = baseAnswer();
  delete (a as Record<string, unknown>).answered_by;
  const result = AnswerSchema.safeParse(a);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.answered_by, 'supervisor');
  }
});

test('AnswerSchema rejects unknown version', () => {
  const result = AnswerSchema.safeParse(baseAnswer({ version: 2 }));
  assert.equal(result.success, false);
});

test('AnswerSchema rejects missing option_id', () => {
  const a = baseAnswer();
  delete (a as Record<string, unknown>).option_id;
  const result = AnswerSchema.safeParse(a);
  assert.equal(result.success, false);
});

test('QUESTION_FILE_MAX_BYTES is set to 64KB', () => {
  assert.equal(QUESTION_FILE_MAX_BYTES, 64 * 1024);
});

test('QuestionSchema rejects status outside enum', () => {
  const result = QuestionSchema.safeParse(baseQuestion({ status: 'pending' }));
  assert.equal(result.success, false);
});

test('QuestionSchema defaults status to open when omitted', () => {
  const q = baseQuestion();
  delete (q as Record<string, unknown>).status;
  const result = QuestionSchema.safeParse(q);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.status, 'open');
  }
});

test('QuestionSchema enforces question length cap', () => {
  const tooLong = 'x'.repeat(4_001);
  const result = QuestionSchema.safeParse(baseQuestion({ question: tooLong }));
  assert.equal(result.success, false);
});

test('QuestionSchema enforces context length cap', () => {
  const tooLong = 'x'.repeat(8_001);
  const result = QuestionSchema.safeParse(baseQuestion({ context: tooLong }));
  assert.equal(result.success, false);
});
