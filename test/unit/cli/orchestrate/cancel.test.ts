import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateCancel } from '../../../../src/cli/orchestrate/cancel.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';
import type { ClaimFenceData } from '../../../../src/trackers/claim-fence.ts';

const assertLeaseReleased = (p: string): void => {
  // FORGE-231: release writes a tombstone (file survives); absence only occurs
  // on legacy/admin unlink paths. Either way there must be no ACTIVE lease.
  if (existsSync(p)) {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { status?: string };
    assert.equal(parsed.status, 'released', `expected a release tombstone at ${p}`);
  }
};


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
  readonly fences: Array<{ issueId: string; data: ClaimFenceData | null }> = [];
  throwOnFence = false;
  async claim(): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(): Promise<void> {}
  async setClaimFence(
    issueId: string,
    data: ClaimFenceData | null,
  ): Promise<void> {
    if (this.throwOnFence) throw new Error('fence boom');
    this.fences.push({ issueId, data });
  }
}

test('cancel transitions state → cancelled and releases lease', async (t) => {
  const stdout = captureStdout(t);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cancel-'));
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
  stdout.length = 0;
  const cancelTracker = new StubTracker();
  const result = await runOrchestrateCancel(
    {
      taskId: 'FORGE-1',
      reason: 'unit test cancel',
      forgeDir,
      json: true,
    },
    { tracker: cancelTracker },
  );
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.state, 'cancelled');
  // State file updated.
  const state = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'cancelled');
  // Lease released.
  const leasePath = join(forgeDir, 'orchestrator/tasks/FORGE-1/lease.json');
  assertLeaseReleased(leasePath);
  // forge:claim footer stripped (data=null) exactly once on cancel.
  assert.equal(cancelTracker.fences.length, 1);
  assert.equal(cancelTracker.fences[0]?.issueId, 'FORGE-1');
  assert.equal(cancelTracker.fences[0]?.data, null);
});

test('cancel refuses when state is already terminal', async (t) => {
  const stdout = captureStdout(t);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cancel-term-'));
  const forgeDir = join(repoRoot, '.forge');
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  await runOrchestrateCancel(
    { taskId: 'FORGE-1', forgeDir, json: true },
    { tracker: new StubTracker() },
  );
  stdout.length = 0;
  const result = await runOrchestrateCancel(
    { taskId: 'FORGE-1', forgeDir, json: true },
    { tracker: new StubTracker() },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_STATE');
});

test('cancel succeeds even when setClaimFence(null) throws (best-effort strip)', async (t) => {
  const stdout = captureStdout(t);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-cancel-fence-'));
  const forgeDir = join(repoRoot, '.forge');
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  stdout.length = 0;
  const cancelTracker = new StubTracker();
  cancelTracker.throwOnFence = true;
  const result = await runOrchestrateCancel(
    { taskId: 'FORGE-1', forgeDir, json: true },
    { tracker: cancelTracker },
  );
  // Strip failure must NOT fail the cancel — state is already cancelled.
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.state, 'cancelled');
  // FORGE-231: release writes a tombstone — assert no ACTIVE lease remains.
  assertLeaseReleased(join(forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'));
});
