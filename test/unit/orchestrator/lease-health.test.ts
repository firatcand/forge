import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLeaseHealth } from '../../../src/orchestrator/leases.ts';
import { STEAL_GRACE_MS_DEFAULT } from '../../../src/schemas/lease.ts';

const EXPIRES = '2026-01-01T00:00:00.000Z';
const expMs = Date.parse(EXPIRES);

test('classifyLeaseHealth: alive while now is strictly before expiry', () => {
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs - 1000)), 'alive');
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs - 1)), 'alive');
});

test('classifyLeaseHealth: expiring_soon from expiry through end of grace (inclusive)', () => {
  // Exactly at expiry — no longer alive (alive requires now < expires_at).
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs)), 'expiring_soon');
  // Mid grace window.
  assert.equal(
    classifyLeaseHealth(EXPIRES, new Date(expMs + STEAL_GRACE_MS_DEFAULT / 2)),
    'expiring_soon',
  );
  // Exactly at the grace boundary — still not yet stealable.
  assert.equal(
    classifyLeaseHealth(EXPIRES, new Date(expMs + STEAL_GRACE_MS_DEFAULT)),
    'expiring_soon',
  );
});

test('classifyLeaseHealth: stale once past expiry + grace', () => {
  assert.equal(
    classifyLeaseHealth(EXPIRES, new Date(expMs + STEAL_GRACE_MS_DEFAULT + 1)),
    'stale',
  );
  assert.equal(
    classifyLeaseHealth(EXPIRES, new Date(expMs + 10 * STEAL_GRACE_MS_DEFAULT)),
    'stale',
  );
});

test('classifyLeaseHealth: unparseable expires_at is treated as stale', () => {
  assert.equal(classifyLeaseHealth('not-a-date', new Date(expMs)), 'stale');
  assert.equal(classifyLeaseHealth('', new Date(expMs)), 'stale');
});

test('classifyLeaseHealth: honors a custom stealGraceMs', () => {
  // grace = 0 collapses the expiring_soon window to the single expiry instant.
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs), 0), 'expiring_soon');
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs + 1), 0), 'stale');
  assert.equal(classifyLeaseHealth(EXPIRES, new Date(expMs - 1), 0), 'alive');
});
