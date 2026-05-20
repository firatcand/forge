import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  classifyError,
  DEFAULT_RETRY_POLICY,
  nextEligibleAt,
  nextRetryState,
  type RetryPolicy,
} from '../../src/orchestrator/retry.ts';
import { OrchestratorError } from '../../src/core/errors.ts';

const POLICY: RetryPolicy = { retry_attempts: 10, retry_backoff_ms_max: 300_000 };

test('default policy matches existing settings.yaml: retry_attempts=10, retry_backoff_ms_max=300_000', () => {
  assert.equal(DEFAULT_RETRY_POLICY.retry_attempts, 10);
  assert.equal(DEFAULT_RETRY_POLICY.retry_backoff_ms_max, 300_000);
});

test('backoff curve: attempts 1..10 with cap=300_000 — Symphony formula min(1000 * 2^(n-1), cap)', () => {
  const expected = [
    1000,       // attempt 1: 1000 * 2^0 = 1000
    2000,       // attempt 2: 1000 * 2^1 = 2000
    4000,
    8000,
    16_000,
    32_000,
    64_000,
    128_000,
    256_000,
    300_000,    // attempt 10: 1000 * 2^9 = 512_000 → capped at 300_000
  ];
  const actual = expected.map((_, i) => backoffMs(i + 1, POLICY));
  assert.deepEqual(actual, expected);
});

test('backoff cap respected at attempt 20: returns retry_backoff_ms_max, not 2^19 ms', () => {
  assert.equal(backoffMs(20, POLICY), 300_000);
});

test('backoff for attempt < 1 returns 0', () => {
  assert.equal(backoffMs(0, POLICY), 0);
  assert.equal(backoffMs(-1, POLICY), 0);
});

test('nextEligibleAt computes lastFailedAt + backoff', () => {
  const lastFailedAt = new Date('2026-01-01T00:00:00.000Z');
  const eligible = nextEligibleAt(3, lastFailedAt, POLICY);
  // attempt 3 → 4000ms backoff
  assert.equal(eligible.toISOString(), '2026-01-01T00:00:04.000Z');
});

test('nextEligibleAt accepts ISO string for lastFailedAt', () => {
  const eligible = nextEligibleAt(1, '2026-01-01T00:00:00.000Z', POLICY);
  assert.equal(eligible.toISOString(), '2026-01-01T00:00:01.000Z');
});

test('nextRetryState transient + attempt < cap → retry', () => {
  const decision = nextRetryState(5, 'transient', POLICY);
  assert.equal(decision.state, 'retry');
  assert.equal(decision.failure_reason, undefined);
});

test('nextRetryState transient + attempt === retry_attempts → failed:retries_exhausted', () => {
  const decision = nextRetryState(10, 'transient', POLICY);
  assert.equal(decision.state, 'failed');
  assert.equal(decision.failure_reason, 'retries_exhausted');
});

test('nextRetryState transient + attempt > cap → failed:retries_exhausted (boundary)', () => {
  const decision = nextRetryState(11, 'transient', POLICY);
  assert.equal(decision.state, 'failed');
  assert.equal(decision.failure_reason, 'retries_exhausted');
});

test('nextRetryState fatal → failed:fatal (regardless of attempt count)', () => {
  for (const attempt of [1, 5, 10, 99]) {
    const decision = nextRetryState(attempt, 'fatal', POLICY);
    assert.equal(decision.state, 'failed');
    assert.equal(decision.failure_reason, 'fatal');
  }
});

test('nextRetryState decision_key_budget → failed:decision_key_budget (regardless of attempt count, never retries)', () => {
  for (const attempt of [1, 5, 10, 99]) {
    const decision = nextRetryState(attempt, 'decision_key_budget', POLICY);
    assert.equal(decision.state, 'failed');
    assert.equal(decision.failure_reason, 'decision_key_budget');
  }
});

test('classifyError: OrchestratorError DECISION_KEY_EXHAUSTED → decision_key_budget', () => {
  const err = new OrchestratorError('DECISION_KEY_EXHAUSTED', 'budget exhausted');
  assert.equal(classifyError(err), 'decision_key_budget');
});

test('classifyError: OrchestratorError SCHEMA_INVALID / INVALID_ID / ILLEGAL_TRANSITION → fatal', () => {
  for (const code of ['SCHEMA_INVALID', 'INVALID_ID', 'ILLEGAL_TRANSITION'] as const) {
    const err = new OrchestratorError(code, 'fatal-ish');
    assert.equal(classifyError(err), 'fatal');
  }
});

test('classifyError: OrchestratorError IO_ERROR / LEASE_STOLEN / others → transient', () => {
  for (const code of ['IO_ERROR', 'LEASE_STOLEN', 'LEASE_NOT_FOUND', 'STATE_NOT_FOUND'] as const) {
    const err = new OrchestratorError(code, 'maybe transient');
    assert.equal(classifyError(err), 'transient');
  }
});

test('classifyError: plain Error → transient', () => {
  assert.equal(classifyError(new Error('boom')), 'transient');
});

test('classifyError: non-error values → transient', () => {
  assert.equal(classifyError(undefined), 'transient');
  assert.equal(classifyError(null), 'transient');
  assert.equal(classifyError('string-error'), 'transient');
  assert.equal(classifyError({ code: 'DECISION_KEY_EXHAUSTED' }), 'transient'); // not a real OrchestratorError instance
});
