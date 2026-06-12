import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateEvent } from '../../../../src/cli/orchestrate/event.ts';
import { __resetSettingsCacheForTests } from '../../../../src/core/settings.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

// Minimal valid settings.yaml with a tiny rotation threshold so a handful of
// event appends crosses it through the full `event` CLI verb path (FORGE-118
// finding 3 — proves agents.log_rotate_max_bytes is actually wired, not inert).
function writeSettingsWithRotateThreshold(forgeDir: string, maxBytes: number): void {
  const yaml = `version: 1
project:
  name: event-rotate-fixture
  description: FORGE-118 finding-3 rotation wiring test
tracker:
  type: github
  config:
    repo: firatcand/forge-fixture
secrets:
  manager: env_file
  env_file_path: ./.env.local
agents:
  max_concurrent: 2
  retry_attempts: 3
  retry_backoff_ms_max: 60000
  poll_interval_ms: 1000
  worktree_root: ./.forge/worktrees
  on_persistent_failure: notify
  primary_host_cli: claude
  review_host_cli: codex
  log_rotate_max_bytes: ${maxBytes}
`;
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(forgeDir, 'settings.yaml'), yaml, 'utf8');
  __resetSettingsCacheForTests();
}

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

test('event verb honors agents.log_rotate_max_bytes override: small threshold triggers rotation', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupDispatched(stdout);
  // Override the rotation threshold to a tiny value. With the prior bug the verb
  // omitted logRotateMaxBytes and the writer used the 10 MiB default → never
  // rotates. With the override wired, events.jsonl rotates to events.jsonl.1.
  writeSettingsWithRotateThreshold(ctx.forgeDir, 1024);
  const eventsPath = join(
    ctx.forgeDir,
    'orchestrator/tasks/FORGE-1/attempts',
    ctx.attemptId,
    'events.jsonl',
  );
  const rotatedPath = `${eventsPath}.1`;

  // Append heartbeat events until the file crosses 1024 bytes and rotates.
  for (let i = 0; i < 40; i += 1) {
    const result = await runOrchestrateEvent({
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      type: 'heartbeat',
      data: { lease_expires_at: new Date(Date.now() + 1_000_000).toISOString() },
      forgeDir: ctx.forgeDir,
      json: true,
    });
    assert.equal(result.exitCode, 0);
    if (existsSync(rotatedPath)) break;
  }

  assert.ok(
    existsSync(rotatedPath),
    'events.jsonl.1 must exist — the 1024-byte override actually drove rotation',
  );
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
