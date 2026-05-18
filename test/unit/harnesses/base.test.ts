import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  isHarnessError,
  notSupported,
} from '../../../src/harnesses/base.ts';

test('HarnessError captures code, host, and details', () => {
  const err = new HarnessError('SPAWN_FAILED', 'codex', 'boom', {
    command: 'codex',
  });
  assert.equal(err.name, 'HarnessError');
  assert.equal(err.code, 'SPAWN_FAILED');
  assert.equal(err.host, 'codex');
  assert.deepEqual(err.details, { command: 'codex' });
});

test('HarnessError preserves cause via options', () => {
  const inner = new Error('root');
  const err = new HarnessError('TIMEOUT', 'gemini', 'wrap', {}, { cause: inner });
  assert.equal((err as { cause?: unknown }).cause, inner);
});

test('isHarnessError narrows unknown to HarnessError', () => {
  const err: unknown = new HarnessError('NOT_SUPPORTED', 'claude', 'no');
  assert.equal(isHarnessError(err), true);
  assert.equal(isHarnessError(new Error('plain')), false);
  assert.equal(isHarnessError(null), false);
  assert.equal(isHarnessError('string'), false);
});

test('notSupported produces actionable claude error', () => {
  const err = notSupported('claude', 'runReview');
  assert.equal(err.code, 'NOT_SUPPORTED');
  assert.equal(err.host, 'claude');
  assert.match(err.message, /claude harness does not support runReview/);
  assert.match(err.message, /review_host_cli/);
  assert.deepEqual(err.details, { capability: 'runReview' });
});
