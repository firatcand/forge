import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { runOrchestrateReviewCompose } from '../../../../src/cli/orchestrate/review-compose.ts';
import type { ReviewVerdict } from '../../../../src/schemas/verdict.ts';

// FORGE-187 (R3): the review-compose verb wraps the pure composeReviewVerdict
// policy (exhaustively unit-tested in the module). These tests exercise the
// verb's IO surface: file read, schema parse, both input shapes (raw verdict +
// second-opinion envelope), ctx validation, and the kind-tagged envelope.

function capture(): { stream: PassThrough; lines: () => string[] } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (c) => chunks.push(String(c)));
  return {
    stream,
    lines: () => chunks.join('').split('\n').filter(Boolean),
  };
}

function lastEnvelope(lines: string[]): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
} {
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-rc-verb-'));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value), 'utf8');
  return p;
}

function reviewVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    version: 1,
    verdict: 'pass',
    findings: [],
    host: 'claude',
    ...overrides,
  } as ReviewVerdict;
}

const BASE = {
  branch: 'feat/FORGE-187-auto-review',
  summary: 'All reviews passed.',
  forgeDir: '/tmp/forge',
  json: true,
};

test('review-compose: both pass → kind=verdict ready_for_review', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: false,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.ok, true);
  assert.equal(env.data!.kind, 'verdict');
  assert.equal((env.data!.verdict as { verdict: string }).verdict, 'ready_for_review');
});

test('review-compose: changes_requested → kind=verdict changes_needed', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'changes_requested' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.data!.kind, 'verdict');
  assert.equal((env.data!.verdict as { verdict: string }).verdict, 'changes_needed');
});

test('review-compose: critical path + block finding → kind=escalate', () => {
  const dir = tmpDir();
  const primary = writeJson(
    dir,
    'primary.json',
    reviewVerdict({
      verdict: 'changes_requested',
      findings: [{ severity: 'block', path: 'src/core/state-machine.ts', message: 'Breaks the transition table.' }],
    }),
  );
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.data!.kind, 'escalate');
  assert.equal(typeof env.data!.reason, 'string');
});

test('review-compose: critical path + no second opinion → kind=park', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    criticalPath: true,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.data!.kind, 'park');
});

test('review-compose: accepts the second-opinion envelope shape for --primary (R3)', () => {
  const dir = tmpDir();
  // The second-opinion verb emits { ok:true, data:{ host, task_id, attempt_id, verdict } }.
  const envelope = {
    ok: true,
    data: {
      host: 'codex',
      task_id: 'FORGE-1',
      attempt_id: 'a1',
      verdict: reviewVerdict({ verdict: 'pass', host: 'codex' }),
    },
  };
  const primary = writeJson(dir, 'primary-envelope.json', envelope);
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.data!.kind, 'verdict');
  assert.equal((env.data!.verdict as { verdict: string }).verdict, 'ready_for_review');
});

test('review-compose: accepts the second-opinion envelope shape for --second-opinion (R3)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const secondEnvelope = {
    ok: true,
    data: { host: 'codex', verdict: reviewVerdict({ verdict: 'pass', host: 'codex' }) },
  };
  const second = writeJson(dir, 'second-envelope.json', secondEnvelope);
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true, // critical path with a real (envelope-unwrapped) second opinion → verdict, not park
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.data!.kind, 'verdict');
  assert.equal((env.data!.verdict as { verdict: string }).verdict, 'ready_for_review');
});

test('review-compose: missing --primary → MISSING_INPUT', () => {
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: '',
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.ok, false);
  assert.equal(env.error!.code, 'MISSING_INPUT');
});

test('review-compose: nonexistent --primary file → MISSING_INPUT', () => {
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: join(tmpDir(), 'does-not-exist.json'),
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'MISSING_INPUT');
});

test('review-compose: malformed primary JSON → INVALID_VERDICT', () => {
  const dir = tmpDir();
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not valid json', 'utf8');
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: p,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_VERDICT');
});

test('review-compose: primary not matching ReviewVerdictSchema → INVALID_VERDICT', () => {
  const dir = tmpDir();
  const p = writeJson(dir, 'wrong.json', { version: 1, verdict: 'approved', findings: [], host: 'codex' });
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: p,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_VERDICT');
});

test('review-compose: malformed second-opinion file → INVALID_VERDICT', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const bad = join(dir, 'second-bad.json');
  writeFileSync(bad, 'nope', 'utf8');
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: bad,
    criticalPath: false,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_VERDICT');
});

test('review-compose: invalid ctx (empty branch) → INVALID_ARGS', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    branch: '', // empty branch makes composeReviewVerdict throw (non-schema Verdict)
    primaryPath: primary,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_ARGS');
});

// FORGE-224 dual-lineage gate (generalized): a second opinion must come from a
// DIFFERENT host than the primary review. The gate is now a SAME-HOST check, so
// claude+claude (and codex+codex, gemini+gemini) are rejected — a critical-path
// change must not pass with two reviews from the same lineage.
test('review-compose: claude(primary)+claude(second) → INVALID_VERDICT (same host)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.ok, false);
  assert.equal(env.error!.code, 'INVALID_VERDICT');
  assert.match(env.error!.message, /matches the primary review host/);
  assert.match(env.error!.message, /claude\+claude/);
});

test('review-compose: codex(primary)+codex(second) → INVALID_VERDICT (same host)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.error!.code, 'INVALID_VERDICT');
  assert.match(env.error!.message, /matches the primary review host/);
});

test('review-compose: gemini(primary)+gemini(second) → INVALID_VERDICT (same host)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'gemini' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'gemini' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.error!.code, 'INVALID_VERDICT');
  assert.match(env.error!.message, /matches the primary review host/);
});

test('review-compose: codex(primary)+claude(second) → accepted (different hosts)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(lastEnvelope(cap.lines()).data!.kind, 'verdict');
});

test('review-compose: claude(primary)+codex(second) is accepted (different hosts)', () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(lastEnvelope(cap.lines()).data!.kind, 'verdict');
});

// Review-fix #2: the size cap must require a regular file. A directory (lstat
// isFile() === false) stands in for a non-regular path (FIFO/char device) and
// must be rejected before any read.
test('review-compose: a non-regular --primary path → INVALID_VERDICT', () => {
  const dir = tmpDir(); // the dir itself is not a regular file
  const cap = capture();
  const r = runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: dir,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.error!.code, 'INVALID_VERDICT');
  assert.match(env.error!.message, /not a regular file/);
});
