import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseSchema } from '../../src/schemas/lease.ts';

function baseLease(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    claim_id: '01960000-0000-7000-8000-000000000001',
    task_id: 'FORGE-20',
    attempt_id: null,
    owner_run_id: 'run-abc123',
    acquired_at: '2026-05-15T10:00:00.000Z',
    expires_at: '2026-05-15T10:30:00.000Z',
    last_heartbeat_at: '2026-05-15T10:00:00.000Z',
    generation: 0,
    ...overrides,
  };
}

test('schemas/lease: LeaseSchema accepts a valid lease', () => {
  const result = LeaseSchema.safeParse(baseLease());
  assert.equal(result.success, true);
});

test('schemas/lease: LeaseSchema accepts attempt_id as a string', () => {
  const result = LeaseSchema.safeParse(baseLease({ attempt_id: 'attempt-001' }));
  assert.equal(result.success, true);
});

test('schemas/lease: LeaseSchema rejects generation < 0', () => {
  const result = LeaseSchema.safeParse(baseLease({ generation: -1 }));
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects non-ISO acquired_at', () => {
  const result = LeaseSchema.safeParse(baseLease({ acquired_at: 'May 15 2026' }));
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects non-ISO expires_at', () => {
  const result = LeaseSchema.safeParse(baseLease({ expires_at: '2026/05/15' }));
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects missing claim_id', () => {
  const l = baseLease();
  delete (l as Record<string, unknown>).claim_id;
  const result = LeaseSchema.safeParse(l);
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects empty owner_run_id', () => {
  const result = LeaseSchema.safeParse(baseLease({ owner_run_id: '' }));
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects wrong version', () => {
  const result = LeaseSchema.safeParse(baseLease({ version: 2 }));
  assert.equal(result.success, false);
});

test('schemas/lease: LeaseSchema rejects generation as float', () => {
  const result = LeaseSchema.safeParse(baseLease({ generation: 0.5 }));
  assert.equal(result.success, false);
});
