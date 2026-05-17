import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateEvent } from '../../../../src/cli/orchestrate/event.ts';
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

async function setupDispatched(stdout: string[]): Promise<{ forgeDir: string; attemptId: string }> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-event-'));
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
  return { forgeDir, attemptId: dispatchEnv.data.attempt_id };
}

test('event with valid heartbeat-shaped payload appends to events.jsonl', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupDispatched(stdout);
  const result = await runOrchestrateEvent({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    type: 'heartbeat',
    data: { lease_expires_at: new Date(Date.now() + 1_000_000).toISOString() },
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const events = readFileSync(
    join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'events.jsonl'),
    'utf8',
  );
  const lines = events.trim().split('\n').filter(Boolean);
  const lastLine = JSON.parse(lines[lines.length - 1] ?? '');
  assert.equal(lastLine.type, 'heartbeat');
});

test('event with unknown type fails INVALID_EVENT', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupDispatched(stdout);
  const result = await runOrchestrateEvent({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    type: 'not_a_real_event',
    data: {},
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_EVENT');
});
