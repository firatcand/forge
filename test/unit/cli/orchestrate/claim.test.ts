import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
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

function tmpRoot(): { forgeDir: string; repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-claim-'));
  return { forgeDir: join(repoRoot, '.forge'), repoRoot };
}

class StubTracker implements ClaimableTracker {
  readonly type = 'stub';
  readonly claims: Array<{ issueId: string; runId: string }> = [];
  readonly releases: Array<{ issueId: string; runId: string }> = [];
  readonly result: ClaimResult;
  readonly throwOnClaim: boolean;
  constructor(result: ClaimResult = { ok: true }, throwOnClaim = false) {
    this.result = result;
    this.throwOnClaim = throwOnClaim;
  }
  async claim(issueId: string, runId: string): Promise<ClaimResult> {
    if (this.throwOnClaim) throw new Error('boom');
    this.claims.push({ issueId, runId });
    return this.result;
  }
  async releaseClaim(issueId: string, runId: string): Promise<void> {
    this.releases.push({ issueId, runId });
  }
}

test('claim succeeds: writes lease + state, returns claim_id', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  const tracker = new StubTracker();
  const result = await runOrchestrateClaim(
    {
      taskId: 'FORGE-1',
      runId: uuidv7(),
      forgeDir,
      json: true,
    },
    {
      tracker,
      specRevision: { revision: 'git:abc1234', source: 'git' },
      repoRoot,
    },
  );
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.ok(env.data.claim_id);
  assert.equal(env.data.generation, 0);
  // lease.json + state.json present on disk.
  assert.ok(existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/lease.json')));
  assert.ok(existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/state.json')));
  const state = JSON.parse(readFileSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'claimed');
  assert.equal(state.attempt_count, 0);
  // Tracker recorded the claim, not the release.
  assert.equal(tracker.claims.length, 1);
  assert.equal(tracker.releases.length, 0);
});

test('claim fails ALREADY_CLAIMED when tracker refuses', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  const tracker = new StubTracker({ ok: false, reason: 'already_claimed' });
  const result = await runOrchestrateClaim(
    {
      taskId: 'FORGE-1',
      runId: uuidv7(),
      forgeDir,
      json: true,
    },
    {
      tracker,
      specRevision: { revision: 'git:abc1234', source: 'git' },
      repoRoot,
    },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'ALREADY_CLAIMED');
  // No lease written.
  assert.ok(!existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/lease.json')));
});

test('claim refuses if state is not unclaimed', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  const tracker = new StubTracker();
  const runId = uuidv7();
  // First claim succeeds.
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  // Second claim must refuse with INVALID_STATE.
  stdout.length = 0;
  const second = await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId: uuidv7(), forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  assert.equal(second.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_STATE');
});

test('claim rolls back tracker on lease conflict', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  // First claim succeeds via tracker A.
  const trackerA = new StubTracker();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId: uuidv7(), forgeDir, json: true },
    { tracker: trackerA, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  // Now a second claim attempt — tracker says OK but lease already exists.
  // We need to manually intervene because the state file blocks via INVALID_STATE first.
  // Simulate: delete state.json (leave lease.json) then re-claim.
  const stateFile = join(forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  await import('node:fs').then((fs) => fs.unlinkSync(stateFile));
  stdout.length = 0;
  const trackerB = new StubTracker();
  const second = await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId: uuidv7(), forgeDir, json: true },
    { tracker: trackerB, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  assert.equal(second.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'LEASE_CONFLICT');
  // Tracker B saw both claim AND release (rollback).
  assert.equal(trackerB.claims.length, 1);
  assert.equal(trackerB.releases.length, 1);
});

test('claim rolls back tracker + lease when writeTaskState fails (Codex 2nd-pass)', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  // Pre-seed state.json with state='unclaimed' but state_version=3, so the
  // claim verb's pre-flight passes (state is unclaimed) but the writeTaskState
  // CAS will fail (expected state_version=0).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(forgeDir, 'orchestrator/tasks/FORGE-1'), { recursive: true });
  const fakeRunId = uuidv7();
  writeFileSync(
    join(forgeDir, 'orchestrator/tasks/FORGE-1/state.json'),
    JSON.stringify({
      version: 1,
      task_id: 'FORGE-1',
      state: 'unclaimed',
      state_version: 3,
      attempt_count: 0,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: fakeRunId, claim_id: fakeRunId, generation: 0 },
    }),
    'utf8',
  );
  const tracker = new StubTracker();
  const result = await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId: uuidv7(), forgeDir, json: true },
    { tracker, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'STATE_VERSION_CONFLICT');
  // Rollback executed: tracker.claim followed by tracker.releaseClaim.
  assert.equal(tracker.claims.length, 1);
  assert.equal(tracker.releases.length, 1);
  // Lease file removed (rollback succeeded).
  const { existsSync } = await import('node:fs');
  assert.ok(!existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-1/lease.json')));
  assert.equal(env.error.details.rolled_back, true);
});

test('claim surfaces tracker exception as TRACKER_ERROR (retriable)', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  const tracker = new StubTracker({ ok: true }, /* throwOnClaim */ true);
  const result = await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId: uuidv7(), forgeDir, json: true },
    { tracker, specRevision: { revision: 'git:abc1234', source: 'git' }, repoRoot },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'TRACKER_ERROR');
  assert.equal(env.error.retriable, true);
});
