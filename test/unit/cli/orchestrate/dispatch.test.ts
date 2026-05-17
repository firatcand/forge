import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
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
  async claim(_issueId: string, _runId: string): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(): Promise<void> {}
}

async function setupClaimed(stdout: string[]): Promise<{
  forgeDir: string;
  repoRoot: string;
  runId: string;
  claimId: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  const forgeDir = join(repoRoot, '.forge');
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  stdout.length = 0;
  return { forgeDir, repoRoot, runId, claimId: env.data.claim_id };
}

test('dispatch happy path: writes manifest, transitions to dispatched', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.ok(env.data.attempt_id);
  assert.ok(existsSync(env.data.manifest_path));
  const manifest = JSON.parse(readFileSync(env.data.manifest_path, 'utf8'));
  assert.equal(manifest.task_id, 'FORGE-1');
  assert.equal(manifest.phase, 'implement');
  // State is now 'dispatched'.
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'dispatched');
  assert.equal(state.attempt_count, 1);
});

test('dispatch refuses with wrong claim_id', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  const fakeClaim = uuidv7();
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: fakeClaim,
    runId: ctx.runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'LEASE_STOLEN');
});

test('dispatch refuses if state is not claimed/awaiting_respawn', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  // First dispatch → dispatched.
  await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  stdout.length = 0;
  // Second dispatch from same claim should refuse (state = 'dispatched').
  const second = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(second.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_STATE');
});

test('dispatch with invalid args returns INVALID_ARGS', async (t) => {
  const stdout = captureStdout(t);
  const result = await runOrchestrateDispatch({
    taskId: 'not-valid',
    claimId: 'not-a-uuid',
    runId: 'nope',
    worktreePath: '',
    phase: 'implement',
    forgeDir: '/tmp/.forge',
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_ARGS');
});
