import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  runOrchestrateReviewCompose,
  reviewComposeHandler,
} from '../../../../src/cli/orchestrate/review-compose.ts';
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

test('review-compose: both pass → kind=verdict ready_for_review', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: changes_requested → kind=verdict changes_needed', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'changes_requested' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: critical path + block finding → kind=escalate', async () => {
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
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: critical path + no second opinion → kind=park', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: accepts the second-opinion envelope shape for --primary (R3)', async () => {
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
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: accepts the second-opinion envelope shape for --second-opinion (R3)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const secondEnvelope = {
    ok: true,
    data: { host: 'codex', verdict: reviewVerdict({ verdict: 'pass', host: 'codex' }) },
  };
  const second = writeJson(dir, 'second-envelope.json', secondEnvelope);
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: missing --primary → MISSING_INPUT', async () => {
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: nonexistent --primary file → MISSING_INPUT', async () => {
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: join(tmpDir(), 'does-not-exist.json'),
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'MISSING_INPUT');
});

test('review-compose: malformed primary JSON → INVALID_VERDICT', async () => {
  const dir = tmpDir();
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not valid json', 'utf8');
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: p,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_VERDICT');
});

test('review-compose: primary not matching ReviewVerdictSchema → INVALID_VERDICT', async () => {
  const dir = tmpDir();
  const p = writeJson(dir, 'wrong.json', { version: 1, verdict: 'approved', findings: [], host: 'codex' });
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: p,
    criticalPath: false,
    secondOpinionAvailable: false,
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  assert.equal(lastEnvelope(cap.lines()).error!.code, 'INVALID_VERDICT');
});

test('review-compose: malformed second-opinion file → INVALID_VERDICT', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const bad = join(dir, 'second-bad.json');
  writeFileSync(bad, 'nope', 'utf8');
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: invalid ctx (empty branch) → INVALID_ARGS', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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
test('review-compose: claude(primary)+claude(second) → INVALID_VERDICT (same host)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: codex(primary)+codex(second) → INVALID_VERDICT (same host)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: gemini(primary)+gemini(second) → INVALID_VERDICT (same host)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'gemini' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'gemini' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: codex(primary)+claude(second) → accepted (different hosts)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

test('review-compose: claude(primary)+codex(second) is accepted (different hosts)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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
test('review-compose: a non-regular --primary path → INVALID_VERDICT', async () => {
  const dir = tmpDir(); // the dir itself is not a regular file
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
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

// ── FORGE-225: primary-review provenance check (--expected-primary-host) ──────

test('review-compose: expectedPrimaryHost matches primary → composes normally', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    expectedPrimaryHost: 'claude',
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(lastEnvelope(cap.lines()).data!.kind, 'verdict');
});

test('review-compose: FORGED primary host (expected claude, verdict codex) → INVALID_VERDICT (provenance)', async () => {
  // The ticket's spoof scenario: a forged primary verdict claims host:codex to
  // fake a different lineage from the real claude second opinion. With the
  // trusted expected host, the provenance check rejects it.
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    expectedPrimaryHost: 'claude',
    stdout: cap.stream,
  });
  assert.equal(r.exitCode, 1);
  const env = lastEnvelope(cap.lines());
  assert.equal(env.error!.code, 'INVALID_VERDICT');
  assert.match(env.error!.message, /does not match the expected primary review host/);
  assert.match(env.error!.message, /verifies provenance/);
});

test('review-compose: expectedPrimaryHost absent → warns on stderr, stdout stays one JSON envelope', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const second = writeJson(dir, 'second.json', reviewVerdict({ verdict: 'pass', host: 'codex' }));
  const cap = capture();
  const errCap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    secondOpinionPath: second,
    criticalPath: true,
    secondOpinionAvailable: true,
    // no expectedPrimaryHost
    stdout: cap.stream,
    stderr: errCap.stream,
  });
  assert.equal(r.exitCode, 0);
  // stdout is exactly one JSON envelope line (not corrupted by the warning).
  const lines = cap.lines();
  assert.equal(lines.length, 1);
  assert.equal(lastEnvelope(lines).data!.kind, 'verdict');
  // the warning went to stderr.
  const errText = errCap.lines().join('\n');
  assert.match(errText, /provenance verification inactive/);
  assert.match(errText, /--expected-primary-host/);
});

// Handler-level flag validation (process.stdout capture). A present-but-valueless
// or invalid --expected-primary-host must FAIL, never silently disable provenance.
function withCapturedStdout(fn: () => Promise<{ exitCode: number }>): Promise<{
  exitCode: number;
  out: string;
}> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = ((chunk: unknown) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then((r) => ({ exitCode: r.exitCode, out: buf }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

test('review-compose handler: --expected-primary-host with NO value → INVALID_ARGS (no silent downgrade)', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ host: 'claude' }));
  const { exitCode, out } = await withCapturedStdout(() =>
    reviewComposeHandler.run(
      ['--primary', primary, '--branch', 'b', '--summary', 's', '--expected-primary-host'],
      { cwd: dir },
    ),
  );
  assert.equal(exitCode, 1);
  const env = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(env.error.code, 'INVALID_ARGS');
  assert.match(env.error.message, /expected-primary-host/);
  assert.match(env.error.message, /no value/);
});

test('review-compose handler: --expected-primary-host with an invalid host (cursor) → INVALID_ARGS', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ host: 'claude' }));
  const { exitCode, out } = await withCapturedStdout(() =>
    reviewComposeHandler.run(
      ['--primary', primary, '--branch', 'b', '--summary', 's', '--expected-primary-host', 'cursor'],
      { cwd: dir },
    ),
  );
  assert.equal(exitCode, 1);
  const env = JSON.parse(out.trim().split('\n').pop()!);
  assert.equal(env.error.code, 'INVALID_ARGS');
  assert.match(env.error.message, /must be one of/);
});

test('review-compose handler: --expected-primary-host= (empty value) → INVALID_ARGS', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ host: 'claude' }));
  const { exitCode, out } = await withCapturedStdout(() =>
    reviewComposeHandler.run(
      ['--primary', primary, '--branch', 'b', '--summary', 's', '--expected-primary-host='],
      { cwd: dir },
    ),
  );
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(out.trim().split('\n').pop()!).error.code, 'INVALID_ARGS');
});

test('review-compose handler: --expected-primary-host immediately followed by another flag → INVALID_ARGS', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ host: 'claude' }));
  const { exitCode, out } = await withCapturedStdout(() =>
    reviewComposeHandler.run(
      ['--primary', primary, '--branch', 'b', '--summary', 's', '--expected-primary-host', '--json'],
      { cwd: dir },
    ),
  );
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(out.trim().split('\n').pop()!).error.code, 'INVALID_ARGS');
});

test('review-compose: expectedPrimaryHost set + matching → NO warning on stderr', async () => {
  const dir = tmpDir();
  const primary = writeJson(dir, 'primary.json', reviewVerdict({ verdict: 'pass', host: 'claude' }));
  const cap = capture();
  const errCap = capture();
  const r = await runOrchestrateReviewCompose({
    ...BASE,
    primaryPath: primary,
    criticalPath: false,
    secondOpinionAvailable: false,
    expectedPrimaryHost: 'claude',
    stdout: cap.stream,
    stderr: errCap.stream,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(errCap.lines().length, 0, 'no warning when provenance is verified');
});
