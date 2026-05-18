import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerdictSchema, ReviewVerdictSchema } from '../../src/schemas/verdict.ts';

function baseVerdict(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version: 1,
    verdict: 'ready_for_review',
    summary: 'All tests pass, lint clean.',
    tests: {
      ran: true,
      passed: 10,
      failed: 0,
      skipped: 0,
      duration_ms: 1200,
      output_excerpt: 'ok',
    },
    lint: {
      ran: true,
      clean: true,
      violations: 0,
      output_excerpt: '',
    },
    branch: 'feat/FORGE-20-dispatcher',
    save_point: 'a1b2c3d',
    ...overrides,
  };
}

function baseReviewVerdict(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  // FORGE-88: ReviewVerdictSchema.host narrowed to {codex, gemini}.
  // Claude is excluded as a reviewer per the different-lineage rule.
  return {
    version: 1,
    verdict: 'pass',
    findings: [],
    host: 'codex',
    ...overrides,
  };
}

// VerdictSchema tests

test('schemas/verdict: VerdictSchema accepts ready_for_review', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ verdict: 'ready_for_review' }));
  assert.equal(result.success, true);
});

test('schemas/verdict: VerdictSchema accepts changes_needed', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ verdict: 'changes_needed' }));
  assert.equal(result.success, true);
});

test('schemas/verdict: VerdictSchema accepts blocked', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ verdict: 'blocked' }));
  assert.equal(result.success, true);
});

test('schemas/verdict: VerdictSchema rejects unknown verdict', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ verdict: 'approved' }));
  assert.equal(result.success, false);
});

test('schemas/verdict: VerdictSchema rejects empty summary', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ summary: '' }));
  assert.equal(result.success, false);
});

test('schemas/verdict: VerdictSchema rejects summary over 4000 chars', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ summary: 'x'.repeat(4001) }));
  assert.equal(result.success, false);
});

test('schemas/verdict: VerdictSchema rejects empty branch', () => {
  const result = VerdictSchema.safeParse(baseVerdict({ branch: '' }));
  assert.equal(result.success, false);
});

test('schemas/verdict: VerdictSchema rejects tests.failed < 0', () => {
  const result = VerdictSchema.safeParse(
    baseVerdict({ tests: { ran: true, passed: 0, failed: -1, skipped: 0, duration_ms: 0, output_excerpt: '' } }),
  );
  assert.equal(result.success, false);
});

// ReviewVerdictSchema tests

test('schemas/verdict: ReviewVerdictSchema accepts pass', () => {
  const result = ReviewVerdictSchema.safeParse(baseReviewVerdict({ verdict: 'pass' }));
  assert.equal(result.success, true);
});

test('schemas/verdict: ReviewVerdictSchema accepts changes_requested', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({ verdict: 'changes_requested' }),
  );
  assert.equal(result.success, true);
});

test('schemas/verdict: ReviewVerdictSchema rejects unknown verdict', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({ verdict: 'approved' }),
  );
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema accepts block severity finding', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({
      findings: [
        {
          severity: 'block',
          path: 'src/foo.ts',
          line: 10,
          message: 'Null pointer dereference.',
        },
      ],
    }),
  );
  assert.equal(result.success, true);
});

test('schemas/verdict: ReviewVerdictSchema accepts improvement severity finding', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({
      findings: [
        {
          severity: 'improvement',
          path: 'src/bar.ts',
          message: 'Consider extracting helper.',
        },
      ],
    }),
  );
  assert.equal(result.success, true);
});

test('schemas/verdict: ReviewVerdictSchema rejects unknown severity', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({
      findings: [
        { severity: 'warning', path: 'src/baz.ts', message: 'Unused var.' },
      ],
    }),
  );
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema rejects unknown host', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({ host: 'gpt4' }),
  );
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema accepts all valid host values', () => {
  // FORGE-88: review-only hosts are codex and gemini.
  for (const host of ['codex', 'gemini'] as const) {
    const result = ReviewVerdictSchema.safeParse(baseReviewVerdict({ host }));
    assert.equal(result.success, true, `host=${host} should be valid`);
  }
});

test('schemas/verdict: ReviewVerdictSchema rejects claude as a review host (FORGE-88)', () => {
  const result = ReviewVerdictSchema.safeParse(baseReviewVerdict({ host: 'claude' }));
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema rejects cursor as a review host (FORGE-88)', () => {
  const result = ReviewVerdictSchema.safeParse(baseReviewVerdict({ host: 'cursor' }));
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema rejects finding with empty path', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({
      findings: [{ severity: 'block', path: '', message: 'Something.' }],
    }),
  );
  assert.equal(result.success, false);
});

test('schemas/verdict: ReviewVerdictSchema rejects finding with empty message', () => {
  const result = ReviewVerdictSchema.safeParse(
    baseReviewVerdict({
      findings: [{ severity: 'block', path: 'src/x.ts', message: '' }],
    }),
  );
  assert.equal(result.success, false);
});
