import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateHeartbeat } from '../../../../src/cli/orchestrate/heartbeat.ts';
import { runOrchestrateComplete } from '../../../../src/cli/orchestrate/complete.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return buf;
}

class StubTracker implements ClaimableTracker {
  readonly type = 'stub';
  async claim(): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(): Promise<void> {}
  async setClaimFence(): Promise<void> {}
}

async function setupRunning(stdout: string[]): Promise<{
  forgeDir: string;
  repoRoot: string;
  attemptId: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-complete-'));
  const forgeDir = join(repoRoot, '.forge');
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  const claimEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: claimEnv.data.claim_id,
    runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir,
    json: true,
  });
  const dispatchEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  await runOrchestrateHeartbeat({
    taskId: 'FORGE-1',
    attemptId: dispatchEnv.data.attempt_id,
    forgeDir,
    json: true,
  });
  stdout.length = 0;
  return { forgeDir, repoRoot, attemptId: dispatchEnv.data.attempt_id };
}

function writeVerdict(repoRoot: string, verdict: string): string {
  const path = join(repoRoot, 'verdict.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      verdict,
      summary: 'Task done',
      tests: { ran: true, passed: 5, failed: 0, skipped: 0, duration_ms: 1000, output_excerpt: 'ok' },
      lint: { ran: true, clean: true, violations: 0, output_excerpt: 'ok' },
      branch: 'feat/foo',
      save_point: 'completed step X',
    }),
    'utf8',
  );
  return path;
}

test('complete with verdict=ready_for_review + phase=implement → state ready_for_review', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.verdict, 'ready_for_review');
  assert.equal(env.data.next_state, 'ready_for_review');
  // Both verdict files present.
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  const vv = JSON.parse(readFileSync(join(dir, 'verdict.verified.json'), 'utf8'));
  assert.equal(v.verdict, 'ready_for_review');
  assert.ok(vv.verified_by);
});

test('FORGE-187 R1: complete --phase review on the SAME attempt → reviewed, writes verdict.review.json', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);

  // 1. implement → ready_for_review (writes verdict.json on this attempt).
  const implVerdict = writeVerdict(ctx.repoRoot, 'ready_for_review');
  let result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: implVerdict,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0, 'implement complete should succeed');
  assert.ok(existsSync(join(dir, 'verdict.json')), 'implement verdict.json present');

  // 2. review → reviewed on the SAME attempt. Before R1 this collided on the
  //    `flag:'wx'` write to verdict.json and the ready_for_review→reviewed path
  //    never actually worked. The phase-scoped filename fixes it.
  const reviewVerdict = writeVerdict(ctx.repoRoot, 'ready_for_review');
  result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: reviewVerdict,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0, 'review complete should succeed on the same attempt');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'reviewed');
  assert.match(env.data.verdict_path, /verdict\.review\.json$/);

  // Phase-scoped files written; the implement verdict.json is untouched.
  assert.ok(existsSync(join(dir, 'verdict.review.json')), 'verdict.review.json present');
  assert.ok(existsSync(join(dir, 'verdict.review.verified.json')), 'verdict.review.verified.json present');
  assert.ok(existsSync(join(dir, 'verdict.json')), 'implement verdict.json still present');

  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'reviewed');
});

test('FORGE-187 R1: complete --phase ship on the SAME attempt → shipped, writes verdict.ship.json', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);

  for (const phase of ['implement', 'review', 'ship'] as const) {
    const vf = writeVerdict(ctx.repoRoot, 'ready_for_review');
    const result = await runOrchestrateComplete({
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      verdictFile: vf,
      phase,
      forgeDir: ctx.forgeDir,
      json: true,
    });
    assert.equal(result.exitCode, 0, `${phase} complete should succeed`);
  }
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'shipped');
  assert.match(env.data.verdict_path, /verdict\.ship\.json$/);

  assert.ok(existsSync(join(dir, 'verdict.json')), 'implement verdict.json present');
  assert.ok(existsSync(join(dir, 'verdict.review.json')), 'verdict.review.json present');
  assert.ok(existsSync(join(dir, 'verdict.ship.json')), 'verdict.ship.json present');

  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'shipped');
});

test('complete with verdict=changes_needed records last_failed_at and loops to running', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const verdictFile = writeVerdict(ctx.repoRoot, 'changes_needed');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'running');
  assert.equal(typeof state.last_failed_at, 'string');
  assert.equal(state.failure_reason, undefined);
});

test('complete --phase ship from running refuses with INVALID_STATE_FOR_PHASE', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  // Codex 2nd-pass: ship from 'running' is illegal per state machine; the
  // verb now refuses upfront rather than letting writeTaskState throw a
  // cryptic ILLEGAL_TRANSITION.
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_STATE_FOR_PHASE');
  assert.equal(env.error.details.current_state, 'running');
  assert.equal(env.error.details.required_state, 'reviewed');
});

test('complete with malformed verdict file fails INVALID_VERDICT', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const bad = join(ctx.repoRoot, 'bad.json');
  writeFileSync(bad, JSON.stringify({ verdict: 'unknown' }), 'utf8');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: bad,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_VERDICT');
});

// Review-fix #3: if the verified-file write fails after the verdict file was
// created (wx), the orphan verdict file must be rolled back so the phase can be
// retried without an EEXIST collision.
test('complete: verified-write failure rolls back the verdict file', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const { attemptDir } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Pre-create verdict.verified.json so its `wx` write fails (EEXIST) while
  // verdict.json (fresh) succeeds first.
  const dir = attemptDir(ctx.forgeDir, 'FORGE-1', ctx.attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict.verified.json'), '{"pre":"existing"}', 'utf8');
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'IO_ERROR');
  // The just-written verdict.json must have been rolled back.
  assert.equal(existsSync(join(dir, 'verdict.json')), false, 'orphan verdict.json should be cleaned up');
});
