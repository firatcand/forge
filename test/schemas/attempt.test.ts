import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttemptEventSchema } from '../../src/schemas/attempt.ts';

const TS = '2026-05-15T10:00:00.000Z';
const ID = 'abc-123';
const SHA = 'a1b2c3d';

// schemas/attempt: each variant parses correctly

test('schemas/attempt: attempt_started parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_started',
    ts: TS,
    attempt_id: ID,
    run_id: 'run-001',
    claim_id: 'claim-001',
    generation: 0,
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: worktree_inspected parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'worktree_inspected',
    ts: TS,
    head_sha: SHA,
    dirty: false,
    conflicts: false,
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: heartbeat parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'heartbeat',
    ts: TS,
    lease_expires_at: '2026-05-15T10:30:00.000Z',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: files_modified parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'files_modified',
    ts: TS,
    files: ['src/foo.ts', 'src/bar.ts'],
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: tests_run parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'tests_run',
    ts: TS,
    passed: 10,
    failed: 0,
    skipped: 2,
    duration_ms: 500,
    output_excerpt: 'all good',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: lint_run parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'lint_run',
    ts: TS,
    clean: true,
    violations: 0,
    output_excerpt: '',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: commit parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'commit',
    ts: TS,
    sha: SHA,
    message_excerpt: 'feat: add thing',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: question_written parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'question_written',
    ts: TS,
    question_id: ID,
    decision_key: 'public-api:shape:v1',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: answer_observed parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'answer_observed',
    ts: TS,
    question_id: ID,
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: attempt_completed parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_completed',
    ts: TS,
    verdict: 'ready_for_review',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: attempt_cancelled parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_cancelled',
    ts: TS,
    reason: 'User requested cancellation.',
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: attempt_abandoned_by_steal parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_abandoned_by_steal',
    ts: TS,
    new_generation: 1,
  });
  assert.equal(result.success, true);
});

test('schemas/attempt: lease_stolen parses correctly', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'lease_stolen',
    ts: TS,
    from_generation: 0,
    to_generation: 1,
  });
  assert.equal(result.success, true);
});

// Rejection tests

test('schemas/attempt: discriminated union rejects unknown type', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'unknown_event',
    ts: TS,
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: tests_run rejects output_excerpt exceeding 2048 chars', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'tests_run',
    ts: TS,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration_ms: 0,
    output_excerpt: 'x'.repeat(2049),
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: files_modified rejects empty files array', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'files_modified',
    ts: TS,
    files: [],
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: attempt_completed rejects unknown verdict', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_completed',
    ts: TS,
    verdict: 'passed',
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: attempt_abandoned_by_steal rejects new_generation < 1', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_abandoned_by_steal',
    ts: TS,
    new_generation: 0,
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: lease_stolen rejects to_generation < 1', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'lease_stolen',
    ts: TS,
    from_generation: 0,
    to_generation: 0,
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: heartbeat rejects non-ISO lease_expires_at', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'heartbeat',
    ts: TS,
    lease_expires_at: 'not-a-date',
  });
  assert.equal(result.success, false);
});

test('schemas/attempt: worktree_inspected rejects sha shorter than 7 chars', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'worktree_inspected',
    ts: TS,
    head_sha: 'a1b2c',
    dirty: false,
    conflicts: false,
  });
  assert.equal(result.success, false);
});

// --- FORGE-83: UTF-8 byte caps -----------------------------------------------

test('FORGE-83: attempt_cancelled rejects reason over the 1000-byte cap (multibyte)', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_cancelled',
    ts: TS,
    reason: '中'.repeat(400), // 400 units (<= 1000 pre-filter) but 1200 bytes > 1000
  });
  assert.equal(result.success, false);
});

test('FORGE-83: attempt_cancelled still rejects an empty reason (min:1 preserved)', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'attempt_cancelled',
    ts: TS,
    reason: '',
  });
  assert.equal(result.success, false);
});

test('FORGE-83: autonomous_decision rejects reason over the 2000-byte cap (multibyte)', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'autonomous_decision',
    ts: TS,
    decision_key: 'k',
    chosen_option_id: 'opt',
    reason: '😀'.repeat(600), // 1200 units, 2400 bytes > 2000
  });
  assert.equal(result.success, false);
});

test('FORGE-83: tests_run rejects output_excerpt over the 2048-byte cap (multibyte)', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'tests_run',
    ts: TS,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration_ms: 1,
    output_excerpt: '中'.repeat(800), // 2400 bytes > 2048
  });
  assert.equal(result.success, false);
});

test('FORGE-83: tests_run accepts ASCII output_excerpt at exactly 2048 bytes', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'tests_run',
    ts: TS,
    passed: 1,
    failed: 0,
    skipped: 0,
    duration_ms: 1,
    output_excerpt: 'a'.repeat(2048),
  });
  assert.equal(result.success, true);
});

// Model routing removed: `model_routed` is no longer a valid attempt-event type.
test('schemas/attempt: model_routed is no longer a valid event type', () => {
  const result = AttemptEventSchema.safeParse({
    type: 'model_routed',
    ts: TS,
    host: 'codex',
    model: 'gpt-5.1',
    tier_effective: 'standard',
    downgraded: false,
  });
  assert.equal(result.success, false);
});
