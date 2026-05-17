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
  const result = await runOrchestrateCancel({
    taskId: 'FORGE-1',
    reason: 'unit test cancel',
    forgeDir,
    json: true,
  });
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
  assert.ok(!existsSync(leasePath), 'lease.json should be unlinked');
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
  await runOrchestrateCancel({ taskId: 'FORGE-1', forgeDir, json: true });
  stdout.length = 0;
  const result = await runOrchestrateCancel({ taskId: 'FORGE-1', forgeDir, json: true });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_STATE');
});
