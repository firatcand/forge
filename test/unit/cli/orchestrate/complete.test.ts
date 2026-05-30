import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
