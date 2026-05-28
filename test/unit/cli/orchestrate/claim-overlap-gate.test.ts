// FORGE-170: claim-time overlap gate. Exercises runOrchestrateClaim end-to-end
// with a real plans/phases.yaml + a seeded active-attempt state file, asserting
// the gate refuses hard-overlapping claims, allows non-overlapping ones, honors
// --force and the settings.agents.hard_lock_globs override, and degrades to
// "allow" when phases.yaml is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-claim-gate-'));
  return { forgeDir: join(repoRoot, '.forge'), repoRoot };
}

class StubTracker implements ClaimableTracker {
  readonly type = 'stub';
  readonly claims: Array<{ issueId: string; runId: string }> = [];
  readonly releases: Array<{ issueId: string; runId: string }> = [];
  async claim(issueId: string, runId: string): Promise<ClaimResult> {
    this.claims.push({ issueId, runId });
    return { ok: true };
  }
  async releaseClaim(issueId: string, runId: string): Promise<void> {
    this.releases.push({ issueId, runId });
  }
}

// Minimal valid phases.yaml: two tasks (FORGE-1, FORGE-2) with the given globs.
function writePhases(repoRoot: string, globsA: string[], globsB: string[]): void {
  const block = (globs: string[]) =>
    globs.map((g) => `          - "${g}"`).join('\n');
  const yaml = `project: test
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: test
    gate_criteria:
      - x
    tasks:
      - id: P1-T01
        tracker_issue_id: FORGE-1
        title: Task A
        description: A
        type: backend
        priority: P1
        estimate: S
        owner_type: backend-dev
        acceptance:
          - a
        write_globs:
${block(globsA)}
      - id: P1-T02
        tracker_issue_id: FORGE-2
        title: Task B
        description: B
        type: backend
        priority: P1
        estimate: S
        owner_type: backend-dev
        acceptance:
          - a
        write_globs:
${block(globsB)}
`;
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans/phases.yaml'), yaml, 'utf8');
}

// Seed a `claimed` (active) attempt for taskId — same record shape the claim
// verb itself writes, so it round-trips through TaskStateSchema.
function seedActiveAttempt(forgeDir: string, taskId: string): void {
  const dir = join(forgeDir, 'orchestrator/tasks', taskId);
  mkdirSync(dir, { recursive: true });
  const rid = uuidv7();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'claimed',
      state_version: 0,
      attempt_count: 0,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: rid, claim_id: rid, generation: 0 },
    }),
    'utf8',
  );
}

const claimArgs = (forgeDir: string, taskId: string, force?: boolean) => ({
  taskId,
  runId: uuidv7(),
  forgeDir,
  json: true,
  ...(force ? { force: true } : {}),
});
const deps = (
  tracker: ClaimableTracker,
  repoRoot: string,
): Parameters<typeof runOrchestrateClaim>[1] => ({
  tracker,
  specRevision: { revision: 'git:abc1234', source: 'git' },
  repoRoot,
});

test('gate refuses claim that hard-overlaps an active attempt', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  writePhases(repoRoot, ['spec/**'], ['spec/**']);
  seedActiveAttempt(forgeDir, 'FORGE-1');
  const tracker = new StubTracker();
  const res = await runOrchestrateClaim(claimArgs(forgeDir, 'FORGE-2'), deps(tracker, repoRoot));
  assert.equal(res.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'OVERLAP_CONFLICT');
  assert.equal(env.error.retriable, true);
  assert.deepEqual(env.error.details.conflicting_task_ids, ['FORGE-1']);
  assert.ok(env.error.details.offending_globs.includes('spec/**'));
  // Gate fires BEFORE the tracker claim — no claim, no lease.
  assert.equal(tracker.claims.length, 0);
  assert.ok(!existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-2/lease.json')));
});

test('gate --force bypasses a hard-overlap and claims', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  writePhases(repoRoot, ['spec/**'], ['spec/**']);
  seedActiveAttempt(forgeDir, 'FORGE-1');
  const tracker = new StubTracker();
  const res = await runOrchestrateClaim(claimArgs(forgeDir, 'FORGE-2', true), deps(tracker, repoRoot));
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(tracker.claims.length, 1);
  assert.ok(existsSync(join(forgeDir, 'orchestrator/tasks/FORGE-2/lease.json')));
});

test('gate allows a claim with disjoint write_globs (no-overlap)', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  writePhases(repoRoot, ['spec/**'], ['docs/**']);
  seedActiveAttempt(forgeDir, 'FORGE-1');
  const tracker = new StubTracker();
  const res = await runOrchestrateClaim(claimArgs(forgeDir, 'FORGE-2'), deps(tracker, repoRoot));
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(tracker.claims.length, 1);
});

test('gate degrades to allow when phases.yaml is absent', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  // No phases.yaml. An active attempt exists but the gate can't classify.
  seedActiveAttempt(forgeDir, 'FORGE-1');
  const tracker = new StubTracker();
  const res = await runOrchestrateClaim(claimArgs(forgeDir, 'FORGE-2'), deps(tracker, repoRoot));
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(tracker.claims.length, 1);
});

test('settings.agents.hard_lock_globs override relaxes the gate', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = tmpRoot();
  writePhases(repoRoot, ['spec/**'], ['spec/**']);
  seedActiveAttempt(forgeDir, 'FORGE-1');
  // Empty hard-lock list → spec/** is no longer a hard-lock → soft-overlap, not
  // hard → gate allows the claim.
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    `version: 1
project:
  name: test
tracker:
  type: linear
  config:
    team_id: "t"
secrets:
  manager: env_file
  env_file_path: ./.env.local
agents:
  hard_lock_globs: []
`,
    'utf8',
  );
  const tracker = new StubTracker();
  const res = await runOrchestrateClaim(claimArgs(forgeDir, 'FORGE-2'), deps(tracker, repoRoot));
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(tracker.claims.length, 1);
});
