import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeReviewVerdict, type ComposeCtx } from '../../../src/orchestrator/review-compose.ts';
import { VerdictSchema } from '../../../src/schemas/verdict.ts';
import type { ReviewVerdict as ReviewVerdictType } from '../../../src/schemas/verdict.ts';

function pass(host: 'codex' | 'gemini' = 'codex'): ReviewVerdictType {
  return { version: 1, verdict: 'pass', findings: [], host };
}

function changes(blockFinding: boolean, host: 'codex' | 'gemini' = 'codex'): ReviewVerdictType {
  return {
    version: 1,
    verdict: 'changes_requested',
    findings: blockFinding
      ? [{ severity: 'block', path: 'src/x.ts', message: 'must change' }]
      : [{ severity: 'improvement', path: 'src/x.ts', message: 'nit' }],
    host,
  };
}

// A schema-valid `pass` verdict that nonetheless carries a `block` finding —
// ReviewVerdictSchema does not forbid this combination.
function passWithBlock(host: 'codex' | 'gemini' = 'codex'): ReviewVerdictType {
  return {
    version: 1,
    verdict: 'pass',
    findings: [{ severity: 'block', path: 'src/x.ts', message: 'blocking but marked pass' }],
    host,
  };
}

const BASE: ComposeCtx = {
  branch: 'feat/x',
  summary: 'review complete',
  hasCriticalPath: false,
  secondOpinionAvailable: true,
};

test('both pass (no second opinion) → verdict ready_for_review', () => {
  const res = composeReviewVerdict(pass(), null, BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'ready_for_review');
  assert.equal(VerdictSchema.safeParse(res.verdict).success, true);
});

test('both pass (primary + second opinion) → verdict ready_for_review', () => {
  const res = composeReviewVerdict(pass(), pass('gemini'), BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'ready_for_review');
  assert.equal(VerdictSchema.safeParse(res.verdict).success, true);
});

test('primary changes_requested, mechanical (non-critical) → verdict changes_needed', () => {
  const res = composeReviewVerdict(changes(false), null, BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'changes_needed');
  assert.equal(VerdictSchema.safeParse(res.verdict).success, true);
});

test('block finding ON a critical path → escalate (no Verdict)', () => {
  const res = composeReviewVerdict(changes(true), null, { ...BASE, hasCriticalPath: true });
  assert.equal(res.kind, 'escalate');
  if (res.kind !== 'escalate') return;
  assert.ok(res.reason.length > 0);
});

test('block finding WITHOUT a critical path → changes_needed (mechanical, not escalate)', () => {
  const res = composeReviewVerdict(changes(true), null, BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'changes_needed');
});

test('critical path + second opinion required but unavailable → park', () => {
  const res = composeReviewVerdict(pass(), null, {
    ...BASE,
    hasCriticalPath: true,
    secondOpinionAvailable: false,
  });
  assert.equal(res.kind, 'park');
  if (res.kind !== 'park') return;
  assert.ok(res.reason.length > 0);
});

test('R2: primary pass + critical + second opinion unavailable → park (not ready_for_review)', () => {
  const res = composeReviewVerdict(pass(), null, {
    ...BASE,
    hasCriticalPath: true,
    secondOpinionAvailable: false,
  });
  assert.equal(res.kind, 'park');
});

// Review-fix #4: critical path + host reportedly AVAILABLE but no second opinion
// obtained (secondOpinion === null) must still park — never auto-approve a
// critical change on the primary review alone.
test('critical + available + secondOpinion null → park (invariant: no verdict without a real 2nd opinion)', () => {
  const res = composeReviewVerdict(pass(), null, {
    ...BASE,
    hasCriticalPath: true,
    secondOpinionAvailable: true,
  });
  assert.equal(res.kind, 'park');
  if (res.kind !== 'park') return;
  assert.match(res.reason, /none was obtained/);
});

test('second-opinion pass (critical, available) → ready_for_review', () => {
  const res = composeReviewVerdict(pass(), pass('gemini'), {
    ...BASE,
    hasCriticalPath: true,
  });
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'ready_for_review');
});

test('second-opinion block finding (critical) → escalate', () => {
  const res = composeReviewVerdict(pass(), changes(true, 'gemini'), {
    ...BASE,
    hasCriticalPath: true,
  });
  assert.equal(res.kind, 'escalate');
});

test('R2: second opinion changes_requested with NO block finding (non-critical) → changes_needed', () => {
  const res = composeReviewVerdict(pass(), changes(false, 'gemini'), BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'changes_needed');
});

// Review-fix #1: a `pass` verdict that carries a block finding must NOT slip
// through to ready_for_review.
test('primary pass WITH a block finding (non-critical) → changes_needed', () => {
  const res = composeReviewVerdict(passWithBlock(), null, BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'changes_needed');
});

test('second-opinion pass WITH a block finding (non-critical) → changes_needed', () => {
  const res = composeReviewVerdict(pass(), passWithBlock('gemini'), BASE);
  assert.equal(res.kind, 'verdict');
  if (res.kind !== 'verdict') return;
  assert.equal(res.verdict.verdict, 'changes_needed');
});

test('primary pass WITH a block finding ON a critical path → escalate', () => {
  const res = composeReviewVerdict(passWithBlock(), pass('gemini'), {
    ...BASE,
    hasCriticalPath: true,
  });
  assert.equal(res.kind, 'escalate');
});

// Review-fix #2: the bridge must guarantee VerdictSchema-valid output. An
// invalid ComposeCtx (empty / overlong branch or summary) is a caller bug and
// must throw rather than emit a Verdict that `complete` would reject.
test('invalid ComposeCtx throws: empty branch', () => {
  assert.throws(() => composeReviewVerdict(pass(), null, { ...BASE, branch: '' }), /non-schema Verdict/);
});

test('invalid ComposeCtx throws: empty summary', () => {
  assert.throws(() => composeReviewVerdict(pass(), null, { ...BASE, summary: '' }), /non-schema Verdict/);
});

test('invalid ComposeCtx throws: overlong branch (>200)', () => {
  assert.throws(
    () => composeReviewVerdict(pass(), null, { ...BASE, branch: 'b'.repeat(201) }),
    /non-schema Verdict/,
  );
});

test('invalid ComposeCtx throws: overlong summary (>4000 bytes)', () => {
  assert.throws(
    () => composeReviewVerdict(pass(), null, { ...BASE, summary: 's'.repeat(4001) }),
    /non-schema Verdict/,
  );
});
