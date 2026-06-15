import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_CLASSIFICATIONS,
  ClassificationSchema,
  FindingSchema,
  WorkOrderSchema,
} from '../../../src/schemas/audit.ts';

const validFinding = {
  file: 'src/foo.ts',
  line: 12,
  dimension: 'dead-code',
  classification: 'delete-safe' as const,
  evidence: 'no importers across src/test/scripts',
  why_safe: 'zero consumers, not a public export',
  proposed_change: 'delete the function',
  blast_radius: 'none',
};

test('ClassificationSchema accepts every classification and rejects others', () => {
  for (const c of AUDIT_CLASSIFICATIONS) {
    assert.equal(ClassificationSchema.safeParse(c).success, true);
  }
  assert.equal(ClassificationSchema.safeParse('totally-safe').success, false);
});

test('FindingSchema accepts a well-formed finding (with optional line/tests_required)', () => {
  assert.equal(FindingSchema.safeParse(validFinding).success, true);
  const { line, ...noLine } = validFinding;
  void line;
  assert.equal(FindingSchema.safeParse(noLine).success, true);
  assert.equal(
    FindingSchema.safeParse({ ...validFinding, tests_required: 'add a unit test first' }).success,
    true,
  );
});

test('FindingSchema is .strict() — rejects extra keys', () => {
  const r = FindingSchema.safeParse({ ...validFinding, severity: 'high' });
  assert.equal(r.success, false);
});

test('FindingSchema rejects a bad classification', () => {
  const r = FindingSchema.safeParse({ ...validFinding, classification: 'nope' });
  assert.equal(r.success, false);
});

test('FindingSchema rejects empty file and non-positive line', () => {
  assert.equal(FindingSchema.safeParse({ ...validFinding, file: '' }).success, false);
  assert.equal(FindingSchema.safeParse({ ...validFinding, line: 0 }).success, false);
  assert.equal(FindingSchema.safeParse({ ...validFinding, line: -3 }).success, false);
});

test('FindingSchema bounds string lengths (defensive against runaway output)', () => {
  const huge = 'x'.repeat(9000);
  assert.equal(FindingSchema.safeParse({ ...validFinding, evidence: huge }).success, false);
  assert.equal(FindingSchema.safeParse({ ...validFinding, file: 'a'.repeat(2000) }).success, false);
});

test('WorkOrderSchema validates the assembled shape', () => {
  const wo = {
    generated_at: new Date().toISOString(),
    scope: ['src/**'],
    dimensions: ['dead-code'],
    verify_configured: false,
    warnings: ['no verify gate'],
    findings: [validFinding],
    summary: {
      'delete-safe': 1,
      'de-export-safe': 0,
      'simplify-safe': 0,
      'needs-tests-first': 0,
      risky: 0,
      'do-not-touch': 0,
    },
  };
  assert.equal(WorkOrderSchema.safeParse(wo).success, true);
});

test('WorkOrderSchema is .strict() — rejects extra keys', () => {
  const wo = {
    generated_at: new Date().toISOString(),
    scope: [],
    dimensions: [],
    verify_configured: true,
    warnings: [],
    findings: [],
    summary: {},
    extra: 1,
  };
  assert.equal(WorkOrderSchema.safeParse(wo).success, false);
});
