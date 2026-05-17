import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOverlap,
  DEFAULT_HARD_LOCK_GLOBS,
  __overlapInternals,
} from '../../../src/orchestrator/overlap.ts';

// ── compileGlob ──────────────────────────────────────────────────────────────

test('compileGlob: literal path matches exactly', () => {
  const re = __overlapInternals.compileGlob('src/index.ts');
  assert.ok(re.test('src/index.ts'));
  assert.ok(!re.test('src/index.tsx'));
  assert.ok(!re.test('src/sub/index.ts'));
});

test('compileGlob: * matches single segment only', () => {
  const re = __overlapInternals.compileGlob('src/*.ts');
  assert.ok(re.test('src/foo.ts'));
  assert.ok(!re.test('src/sub/foo.ts'));
});

test('compileGlob: ** matches across segments', () => {
  const re = __overlapInternals.compileGlob('migrations/**');
  assert.ok(re.test('migrations/0001.sql'));
  assert.ok(re.test('migrations/sub/0002.sql'));
});

test('compileGlob: escapes regex specials in path literals', () => {
  const re = __overlapInternals.compileGlob('plans/phases.yaml');
  assert.ok(re.test('plans/phases.yaml'));
  assert.ok(!re.test('plans/phasesXyaml'));
});

// ── classifyOverlap: pair matrix ─────────────────────────────────────────────

test('no-overlap: disjoint write_globs', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['src/server/**'] }],
    candidate: { taskId: 'B', writeGlobs: ['src/client/**'] },
  });
  assert.equal(result.classification, 'no-overlap');
  assert.deepEqual(result.offendingGlobs, []);
  assert.deepEqual(result.conflictingTaskIds, []);
});

test('soft-overlap: same directory subtree, no hard-lock involved', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['src/foo/**'] }],
    candidate: { taskId: 'B', writeGlobs: ['src/foo/bar.ts'] },
  });
  assert.equal(result.classification, 'soft-overlap');
  assert.deepEqual(result.conflictingTaskIds, ['A']);
});

test('hard-overlap: both attempts touch package.json', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['package.json', 'src/a/**'] }],
    candidate: { taskId: 'B', writeGlobs: ['package.json'] },
  });
  assert.equal(result.classification, 'hard-overlap');
  assert.ok(result.offendingGlobs.includes('package.json'));
  assert.deepEqual(result.conflictingTaskIds, ['A']);
});

test('hard-overlap via migrations/** recursive match', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['migrations/0001.sql'] }],
    candidate: { taskId: 'B', writeGlobs: ['migrations/0002.sql'] },
  });
  assert.equal(result.classification, 'hard-overlap');
});

// ── Undeclared write_globs: worst-case-assume-overlap-on-hard-lock-only ──────

test('candidate without write_globs vs active touching hard-lock: hard-overlap', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['package.json'] }],
    candidate: { taskId: 'B', writeGlobs: [] },
  });
  assert.equal(result.classification, 'hard-overlap');
  assert.deepEqual(result.conflictingTaskIds, ['A']);
});

test('active without write_globs vs candidate touching hard-lock: hard-overlap', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: [] }],
    candidate: { taskId: 'B', writeGlobs: ['tsconfig.json'] },
  });
  assert.equal(result.classification, 'hard-overlap');
  assert.deepEqual(result.conflictingTaskIds, ['A']);
});

test('two attempts neither declaring write_globs: no-overlap (documented limitation)', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: [] }],
    candidate: { taskId: 'B', writeGlobs: [] },
  });
  assert.equal(result.classification, 'no-overlap');
});

// ── Empty actives + multi-active ─────────────────────────────────────────────

test('no actives: no-overlap regardless of candidate declaration', () => {
  const result = classifyOverlap({
    activeAttempts: [],
    candidate: { taskId: 'B', writeGlobs: ['package.json'] },
  });
  assert.equal(result.classification, 'no-overlap');
});

test('multiple actives: hard-overlap with all that share a hard-lock', () => {
  const result = classifyOverlap({
    activeAttempts: [
      { taskId: 'A', writeGlobs: ['package.json'] },
      { taskId: 'B', writeGlobs: ['package.json'] },
      { taskId: 'C', writeGlobs: ['src/unrelated.ts'] },
    ],
    candidate: { taskId: 'D', writeGlobs: ['package.json'] },
  });
  assert.equal(result.classification, 'hard-overlap');
  assert.ok(result.conflictingTaskIds.includes('A'));
  assert.ok(result.conflictingTaskIds.includes('B'));
  assert.ok(!result.conflictingTaskIds.includes('C'));
});

test('multiple actives: hard-overlap takes precedence over soft', () => {
  const result = classifyOverlap({
    activeAttempts: [
      { taskId: 'A', writeGlobs: ['src/foo/**'] }, // would be soft
      { taskId: 'B', writeGlobs: ['package.json'] }, // hard
    ],
    candidate: { taskId: 'C', writeGlobs: ['src/foo/bar.ts', 'package.json'] },
  });
  assert.equal(result.classification, 'hard-overlap');
});

// ── hardLockGlobs override ───────────────────────────────────────────────────

test('hardLockGlobs override: empty list means no hard-overlap ever', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['package.json'] }],
    candidate: { taskId: 'B', writeGlobs: ['package.json'] },
    hardLockGlobs: [],
  });
  // Both name package.json (not a hard-lock now) → soft-overlap.
  assert.equal(result.classification, 'soft-overlap');
});

test('hardLockGlobs override: custom hard-lock glob applied', () => {
  const result = classifyOverlap({
    activeAttempts: [{ taskId: 'A', writeGlobs: ['db/seed.sql'] }],
    candidate: { taskId: 'B', writeGlobs: ['db/seed.sql'] },
    hardLockGlobs: ['db/**'],
  });
  assert.equal(result.classification, 'hard-overlap');
});

// ── Deduplication ────────────────────────────────────────────────────────────

test('offendingGlobs deduplicates repeats across multiple actives', () => {
  const result = classifyOverlap({
    activeAttempts: [
      { taskId: 'A', writeGlobs: ['package.json'] },
      { taskId: 'B', writeGlobs: ['package.json'] },
    ],
    candidate: { taskId: 'C', writeGlobs: ['package.json'] },
  });
  assert.equal(result.classification, 'hard-overlap');
  // Each glob should appear at most once.
  const counts = new Map<string, number>();
  for (const g of result.offendingGlobs) counts.set(g, (counts.get(g) ?? 0) + 1);
  for (const [, count] of counts) assert.equal(count, 1);
});

// ── Spec-default hard-lock list ──────────────────────────────────────────────

test('DEFAULT_HARD_LOCK_GLOBS includes the spec-required entries', () => {
  for (const required of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'plans/phases.yaml',
    'src/index.ts',
    'migrations/**',
    'prisma/schema.prisma',
  ]) {
    assert.ok(
      DEFAULT_HARD_LOCK_GLOBS.includes(required),
      `expected DEFAULT_HARD_LOCK_GLOBS to include ${required}`,
    );
  }
});
