import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskStateSchema,
  AttemptStateSchema,
  TASK_STATES,
} from '../../src/schemas/task-state.ts';

function baseTaskState(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    task_id: 'FORGE-20',
    state: 'unclaimed',
    state_version: 0,
    attempt_count: 0,
    current_attempt_id: null,
    updated_at: '2026-05-15T10:00:00.000Z',
    updated_by: {
      run_id: 'run-abc123',
      claim_id: 'claim-abc123',
      generation: 0,
    },
    ...overrides,
  };
}

function baseAttemptState(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    attempt_id: 'attempt-001',
    task_id: 'FORGE-20',
    run_id: 'run-abc123',
    claim_id: 'claim-abc123',
    generation: 0,
    state: 'dispatched',
    dispatched_at: '2026-05-15T10:00:00.000Z',
    updated_at: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

// schemas/task-state: TaskStateSchema accepts each state value.
// failure_reason is OPTIONAL on state='failed' (migration-safe — Codex 3rd-pass CONSIDER 3).
for (const state of TASK_STATES) {
  test(`schemas/task-state: TaskStateSchema accepts state="${state}"`, () => {
    const result = TaskStateSchema.safeParse(baseTaskState({ state }));
    assert.equal(result.success, true, `state=${state} should parse`);
  });
}

test('schemas/task-state: state=failed WITHOUT failure_reason is accepted (migration-safe)', () => {
  const result = TaskStateSchema.safeParse(baseTaskState({ state: 'failed' }));
  assert.equal(result.success, true);
});

test('schemas/task-state: state=failed WITH failure_reason is accepted', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ state: 'failed', failure_reason: 'retries_exhausted' }),
  );
  assert.equal(result.success, true);
});

test('schemas/task-state: failure_reason invariant — failure_reason without state=failed → rejected', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ state: 'running', failure_reason: 'fatal' }),
  );
  assert.equal(result.success, false);
});

test('schemas/task-state: failure_reason accepts decision_key_budget / retries_exhausted / fatal', () => {
  for (const reason of ['decision_key_budget', 'retries_exhausted', 'fatal'] as const) {
    const result = TaskStateSchema.safeParse(
      baseTaskState({ state: 'failed', failure_reason: reason }),
    );
    assert.equal(result.success, true, `failure_reason=${reason} should parse`);
  }
});

test('schemas/task-state: failure_reason rejects unknown value', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ state: 'failed', failure_reason: 'something_else' }),
  );
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema accepts current_attempt_id as non-null string', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ current_attempt_id: 'attempt-001', state: 'claimed' }),
  );
  assert.equal(result.success, true);
});

test('schemas/task-state: TaskStateSchema rejects unknown state value', () => {
  const result = TaskStateSchema.safeParse(baseTaskState({ state: 'pending' }));
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects missing task_id', () => {
  const s = baseTaskState();
  delete (s as Record<string, unknown>).task_id;
  const result = TaskStateSchema.safeParse(s);
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects attempt_count < 0', () => {
  const result = TaskStateSchema.safeParse(baseTaskState({ attempt_count: -1 }));
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects state_version < 0', () => {
  const result = TaskStateSchema.safeParse(baseTaskState({ state_version: -1 }));
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects missing updated_by', () => {
  const s = baseTaskState();
  delete (s as Record<string, unknown>).updated_by;
  const result = TaskStateSchema.safeParse(s);
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects updated_by.generation < 0', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ updated_by: { run_id: 'r', claim_id: 'c', generation: -1 } }),
  );
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects non-datetime updated_at', () => {
  const result = TaskStateSchema.safeParse(
    baseTaskState({ updated_at: 'not-a-date' }),
  );
  assert.equal(result.success, false);
});

test('schemas/task-state: TaskStateSchema rejects wrong version', () => {
  const result = TaskStateSchema.safeParse(baseTaskState({ version: 2 }));
  assert.equal(result.success, false);
});

// AttemptStateSchema tests
test('schemas/task-state: AttemptStateSchema accepts valid attempt state', () => {
  const result = AttemptStateSchema.safeParse(baseAttemptState());
  assert.equal(result.success, true);
});

test('schemas/task-state: AttemptStateSchema rejects unknown state', () => {
  const result = AttemptStateSchema.safeParse(
    baseAttemptState({ state: 'unknown' }),
  );
  assert.equal(result.success, false);
});

test('schemas/task-state: AttemptStateSchema rejects generation < 0', () => {
  const result = AttemptStateSchema.safeParse(
    baseAttemptState({ generation: -1 }),
  );
  assert.equal(result.success, false);
});
