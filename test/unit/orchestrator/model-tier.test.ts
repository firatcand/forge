import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_TIERS } from '../../../src/schemas/phases.ts';
import { effectiveModelTier } from '../../../src/orchestrator/model-tier.ts';

// FORGE-211: effectiveModelTier — pure tier arithmetic with floor-only
// escalation. The stamp is the authoritative floor (R1); runtime overrides
// raise UPWARD from the floor, never below it.

test('absent stamp + default → default tier (unstamped falls back)', () => {
  assert.equal(
    effectiveModelTier({ taskTier: undefined, defaultTier: 'standard' }),
    'standard',
  );
});

test('R1 — small stamp stays small even when default is standard (no upward floor to default)', () => {
  assert.equal(
    effectiveModelTier({
      taskTier: 'small',
      defaultTier: 'standard',
      touchesCriticalPath: false,
      attemptCount: 0,
    }),
    'small',
  );
});

test('R1 — small stamp wins over a frontier default too (stamp is the floor, not max with default)', () => {
  assert.equal(
    effectiveModelTier({ taskTier: 'small', defaultTier: 'frontier' }),
    'small',
  );
});

test('CRITICAL path escalates to frontier', () => {
  assert.equal(
    effectiveModelTier({
      taskTier: 'small',
      defaultTier: 'standard',
      touchesCriticalPath: true,
    }),
    'frontier',
  );
});

test('CRITICAL path escalates an unstamped task to frontier', () => {
  assert.equal(
    effectiveModelTier({ defaultTier: 'standard', touchesCriticalPath: true }),
    'frontier',
  );
});

test('retry bumps the tier up by one notch', () => {
  assert.equal(
    effectiveModelTier({ taskTier: 'small', defaultTier: 'standard', attemptCount: 1 }),
    'standard',
  );
});

test('retry bump of 2 from small reaches frontier', () => {
  assert.equal(
    effectiveModelTier({ taskTier: 'small', defaultTier: 'standard', attemptCount: 2 }),
    'frontier',
  );
});

test('retry bump caps at frontier (never overflows)', () => {
  assert.equal(
    effectiveModelTier({ taskTier: 'frontier', defaultTier: 'standard', attemptCount: 5 }),
    'frontier',
  );
});

test('CRITICAL + retry combine, still capped at frontier', () => {
  assert.equal(
    effectiveModelTier({
      taskTier: 'standard',
      defaultTier: 'small',
      touchesCriticalPath: true,
      attemptCount: 3,
    }),
    'frontier',
  );
});

test('CRITICAL on an already-standard floor still yields frontier (upward)', () => {
  assert.equal(
    effectiveModelTier({ taskTier: 'standard', defaultTier: 'small', touchesCriticalPath: true }),
    'frontier',
  );
});

test('upward-only — no input combination ever returns a tier below the base floor', () => {
  for (const taskTier of MODEL_TIERS) {
    const baseIdx = MODEL_TIERS.indexOf(taskTier);
    for (const defaultTier of MODEL_TIERS) {
      for (const touchesCriticalPath of [false, true]) {
        for (const attemptCount of [0, 1, 2, 5]) {
          const result = effectiveModelTier({
            taskTier,
            defaultTier,
            touchesCriticalPath,
            attemptCount,
          });
          assert.ok(
            MODEL_TIERS.indexOf(result) >= baseIdx,
            `tier ${result} fell below stamp floor ${taskTier} ` +
              `(default=${defaultTier}, critical=${touchesCriticalPath}, attempts=${attemptCount})`,
          );
        }
      }
    }
  }
});

test('effectiveModelTier — defensive: unknown tier throws', () => {
  assert.throws(
    () => effectiveModelTier({ taskTier: 'ultra' as unknown as 'small', attemptCount: 0, touchesCriticalPath: false, defaultTier: 'standard' }),
    /unknown tier 'ultra'/,
  );
});

test('effectiveModelTier — defensive: non-integer/negative attemptCount throws', () => {
  assert.throws(
    () => effectiveModelTier({ attemptCount: -1, defaultTier: 'standard' }),
    /non-negative integer/,
  );
  assert.throws(
    () => effectiveModelTier({ attemptCount: 1.5, defaultTier: 'standard' }),
    /non-negative integer/,
  );
});
