import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateHeartbeat } from '../../../../src/cli/orchestrate/heartbeat.ts';
import { steal } from '../../../../src/orchestrator/leases.ts';
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

async function setupDispatched(stdout: string[]): Promise<{
  forgeDir: string;
  repoRoot: string;
  runId: string;
  claimId: string;
  attemptId: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-hb-'));
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
  stdout.length = 0;
  return {
    forgeDir,
    repoRoot,
    runId,
    claimId: claimEnv.data.claim_id,
    attemptId: dispatchEnv.data.attempt_id,
  };
}

test('first heartbeat transitions dispatched → running', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupDispatched(stdout);
  const result = await runOrchestrateHeartbeat({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.first_heartbeat, true);
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'running');
});

test('subsequent heartbeats leave state unchanged', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupDispatched(stdout);
  await runOrchestrateHeartbeat({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  stdout.length = 0;
  const second = await runOrchestrateHeartbeat({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(second.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.first_heartbeat, false);
});

test('heartbeat fails LEASE_NOT_FOUND when called against a task with no lease', async (t) => {
  const stdout = captureStdout(t);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-hb-nolease-'));
  const forgeDir = join(repoRoot, '.forge');
  const result = await runOrchestrateHeartbeat({
    taskId: 'FORGE-99',
    attemptId: uuidv7(),
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'LEASE_NOT_FOUND');
  // steal is imported for type-side use — silence the lint warning.
  void steal;
});
