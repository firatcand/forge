import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync , existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { execaSync } from 'execa';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestratePhases } from '../../../../src/cli/orchestrate/phases.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';
import { TASK_MARKER_RELPATH } from '../../../../src/core/workspace.ts';

function writeShipPhasesFixture(repoRoot: string): void {
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), 'project: "fixture"\nphases:\n  - id: phase-1\n    name: "Phase"\n    status: active\n    goal: "Goal."\n    gate_criteria:\n      - "Gate."\n    tasks:\n      - id: P1-T01\n        title: "Subject"\n        description: "Subject task."\n        type: foundation\n        priority: P0\n        estimate: S\n        owner_type: backend-dev\n        tracker_issue_id: FORGE-1\n        acceptance:\n          - "ok"\n', 'utf8');
}


// FORGE-231: per-phase dispatch legality (owner decision PA).

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
  async setClaimFence(): Promise<void> {}
}

interface Ctx {
  forgeDir: string;
  repoRoot: string;
  runId: string;
  claimId: string;
}

async function setupClaimed(stdout: string[]): Promise<Ctx> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-dphase-'));
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

function forceState(ctx: Ctx, state: string, extra: Record<string, unknown> = {}): void {
  const statePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  const current = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(
    statePath,
    JSON.stringify({ ...current, state, state_version: current.state_version + 1, ...extra }),
    'utf8',
  );
}

// A real git worktree fixture with the FORGE-231 frozen-base marker.
function makeReviewWorktree(ctx: Ctx): { worktree: string; headSha: string; baseSha: string } {
  const worktree = join(ctx.repoRoot, 'wt');
  mkdirSync(worktree, { recursive: true });
  const git = (...args: string[]): string =>
    String(
      execaSync('git', args, { cwd: worktree, env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }).stdout ?? '',
    ).trim();
  git('init', '-q');
  writeFileSync(join(worktree, 'a.txt'), 'base\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  // Simulate the frozen base ref (origin/main) then advance HEAD.
  git('update-ref', 'refs/remotes/origin/main', baseSha);
  writeFileSync(join(worktree, 'a.txt'), 'work\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
  const headSha = git('rev-parse', 'HEAD');
  // Marker with the frozen base (owner decision SB).
  mkdirSync(join(worktree, '.forge'), { recursive: true });
  writeFileSync(
    join(worktree, TASK_MARKER_RELPATH),
    JSON.stringify({ version: 1, taskId: 'FORGE-1', branch: 'feat/FORGE-1', base_branch: 'main' }),
    'utf8',
  );
  return { worktree, headSha, baseSha };
}

test('dispatch --phase review: pointer self-loop with BOTH diff endpoints pinned at dispatch time', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  forceState(ctx, 'ready_for_review');
  const { worktree, headSha, baseSha } = makeReviewWorktree(ctx);

  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: worktree,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.phase, 'review');

  const manifest = JSON.parse(readFileSync(env.data.manifest_path, 'utf8'));
  assert.equal(manifest.phase, 'review');
  assert.equal(manifest.review_target_sha, headSha);
  assert.equal(manifest.review_base_sha, baseSha);

  // Pointer self-loop: state UNCHANGED, pointer + informational counter moved.
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'ready_for_review');
  assert.equal(state.current_attempt_id, env.data.attempt_id);
  assert.equal(state.review_attempt_count, 1);
  assert.equal(state.attempt_count, 0, 'implement counter must not move on a review dispatch');
});

test('dispatch --phase review against an unbound worktree refuses (binding gate before base resolution)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  forceState(ctx, 'ready_for_review');
  const bare = join(ctx.repoRoot, 'bare-wt');
  mkdirSync(bare, { recursive: true });

  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: bare,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.match(env.error.message, /bound to|base_branch/);
});

test('dispatch --phase ship: legal only from reviewed; pointer self-loop', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  writeShipPhasesFixture(ctx.repoRoot);
  // FORGE-234: ship dispatch pins ship_target_sha from the ship record.
  const recDir = join(ctx.forgeDir, 'orchestrator', 'tasks', 'FORGE-1');
  mkdirSync(recDir, { recursive: true });
  writeFileSync(
    join(recDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: 'FORGE-1', revision: 1, reviewed_head_sha: 'a'.repeat(40),
      review_attempt_id: 'att-rev', base: null, pr: null, merge_attempt: 'not_started',
      updated_at: new Date().toISOString(),
    }),
    'utf8',
  );

  // Illegal from claimed.
  const bad = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(bad.exitCode, 1);
  stdout.length = 0;

  forceState(ctx, 'reviewed');
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'reviewed');
  assert.equal(state.current_attempt_id, env.data.attempt_id);
  assert.equal(state.ship_attempt_count, 1);
  // FORGE-234: the manifest is pinned to the record's reviewed SHA.
  const manifest = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', env.data.attempt_id, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.ship_target_sha, 'a'.repeat(40));
});

test('dispatch implement from awaiting_respawn refuses when the failure budget is exhausted', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  forceState(ctx, 'awaiting_respawn', { failure_count: 10 });

  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.match(env.error.message, /failure budget exhausted/);
});

test('dispatch implement from ready_for_review is dual-host-illegal (single-host re-verify only)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  forceState(ctx, 'ready_for_review');

  // No settings.yaml → schema-default dual-host mode → implement from
  // ready_for_review is illegal (REVIEW owns that state in dual-host mode).
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);

  // Single-host mode (review_host_cli: null) legalizes the re-verify path.
  writeFileSync(
    join(ctx.forgeDir, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: t',
      'tracker:',
      '  type: github',
      '  config:',
      '    repo: o/r',
      'secrets:',
      '  manager: env_file',
      'agents:',
      '  review_host_cli: null',
      '',
    ].join('\n'),
    'utf8',
  );
  stdout.length = 0;
  const ok = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(ok.exitCode, 0);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'dispatched');
  assert.equal(state.attempt_count, 1);
});

test("dispatch --phase review against ANOTHER task's worktree refuses (impl R1 MAJ-4 regression)", async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  forceState(ctx, 'ready_for_review');
  const { worktree } = makeReviewWorktree(ctx);
  // Rebind the marker to a different task.
  writeFileSync(
    join(worktree, TASK_MARKER_RELPATH),
    JSON.stringify({ version: 1, taskId: 'FORGE-999', branch: 'feat/FORGE-999', base_branch: 'main' }),
    'utf8',
  );
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: worktree,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.match(env.error.message, /bound to 'FORGE-999'/);
});

test('dispatch refuses an EXPIRED lease even with matching identity (impl R1 MAJ-3 regression)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  // Expire the lease in place (identity preserved).
  const leasePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json');
  const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  writeFileSync(
    leasePath,
    JSON.stringify({ ...lease, expires_at: new Date(Date.now() - 60_000).toISOString() }),
    'utf8',
  );
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: ctx.claimId,
    runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'LEASE_EXPIRED');
});

test('FORGE-233: ship dispatch with an unmet dep → exact DEPS_NOT_MERGED envelope, ZERO side effects', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  // Subject depends on DEP-1 (merge_pending, open PR).
  mkdirSync(join(ctx.repoRoot, 'plans'), { recursive: true });
  writeFileSync(
    join(ctx.repoRoot, 'plans', 'phases.yaml'),
    [
      'project: "fixture"',
      'phases:',
      '  - id: phase-1',
      '    name: "Phase"',
      '    status: active',
      '    goal: "Goal."',
      '    gate_criteria: ["Gate."]',
      '    tasks:',
      '      - id: P1-T01',
      '        title: "Subject"',
      '        description: "Subject."',
      '        type: foundation',
      '        priority: P0',
      '        estimate: S',
      '        owner_type: backend-dev',
      '        tracker_issue_id: FORGE-1',
      '        acceptance: ["ok"]',
      '        depends_on: [P1-T00]',
      '      - id: P1-T00',
      '        title: "Dep"',
      '        description: "Dep."',
      '        type: foundation',
      '        priority: P0',
      '        estimate: S',
      '        owner_type: backend-dev',
      '        tracker_issue_id: DEP-1',
      '        acceptance: ["ok"]',
      '',
    ].join('\n'),
    'utf8',
  );
  const depDir = join(ctx.forgeDir, 'orchestrator', 'tasks', 'DEP-1');
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, 'state.json'),
    JSON.stringify({
      version: 1, task_id: 'DEP-1', state: 'merge_pending', state_version: 3, attempt_count: 1,
      failure_count: 0, last_failure_key: null, review_attempt_count: 1, ship_attempt_count: 1,
      current_attempt_id: 'att-1', updated_at: new Date().toISOString(),
      updated_by: { run_id: 'r', claim_id: 'c', generation: 1 },
    }),
    'utf8',
  );
  writeFileSync(
    join(depDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: 'DEP-1', revision: 2, reviewed_head_sha: 'a'.repeat(40),
      review_attempt_id: 'att-r', base: { repo: 'octo/base', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'octo/base', number: 5, url: 'https://github.com/octo/base/pull/5' },
      merge_attempt: 'submitted', updated_at: new Date().toISOString(),
    }),
    'utf8',
  );
  forceState(ctx, 'reviewed');
  const before = readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8');

  const result = await runOrchestrateDispatch(
    {
      taskId: 'FORGE-1', claimId: ctx.claimId, runId: ctx.runId,
      worktreePath: join(ctx.repoRoot, 'wt'), phase: 'ship', forgeDir: ctx.forgeDir, json: true,
    },
    { observerFor: async () => ({ mergeResult: async () => ({ merged: false, state: 'open' as const }) }) },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  // Exact envelope contract (Codex plan R2 #5): closed enums, machine-readable.
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'DEPS_NOT_MERGED');
  assert.equal(env.error.retriable, true, 'open PR is a waiting condition');
  const gate = env.error.details.dependency_gate;
  assert.equal(gate.version, 1);
  assert.deepEqual(gate.subject, { resolved: true, task_id: 'P1-T01' });
  assert.equal(gate.satisfied, false);
  assert.equal(gate.deps.length, 1);
  assert.equal(gate.deps[0].declared_id, 'P1-T00');
  assert.equal(gate.deps[0].reason, 'not_merged');
  assert.equal(gate.deps[0].disposition, 'waiting');
  assert.deepEqual(gate.duplicate_declared_ids, []);
  // ZERO side effects: state byte-identical, no attempt dir created.
  const after = readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8');
  assert.equal(after, before, 'no pointer bump on refusal');
  assert.equal(existsSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts')), false, 'no attempt dir');
});

test('FORGE-233: ship dispatch with subject MISSING from phases.yaml → refusal, zero side effects', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  mkdirSync(join(ctx.repoRoot, 'plans'), { recursive: true });
  writeFileSync(
    join(ctx.repoRoot, 'plans', 'phases.yaml'),
    [
      'project: "fixture"', 'phases:', '  - id: phase-1', '    name: "P"', '    status: active',
      '    goal: "G."', '    gate_criteria: ["g"]', '    tasks:',
      '      - id: P1-T77', '        title: "Other"', '        description: "o"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev', '        acceptance: ["ok"]', '',
    ].join('\n'),
    'utf8',
  );
  forceState(ctx, 'reviewed');
  const before = readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8');
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1', claimId: ctx.claimId, runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'), phase: 'ship', forgeDir: ctx.forgeDir, json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'DEPS_NOT_MERGED');
  assert.equal(env.error.retriable, false, 'unresolved subject is operator territory');
  assert.equal(env.error.details.dependency_gate.subject.resolved, false);
  const after = readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8');
  assert.equal(after, before);
});

test('FORGE-233: phases --phase ship filters unmet-dep candidates into blocked_on_deps', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  // Same two-task fixture: subject reviewed, dep merge_pending with open PR.
  mkdirSync(join(ctx.repoRoot, 'plans'), { recursive: true });
  writeFileSync(
    join(ctx.repoRoot, 'plans', 'phases.yaml'),
    [
      'project: "fixture"', 'phases:', '  - id: phase-1', '    name: "P"', '    status: active',
      '    goal: "G."', '    gate_criteria: ["g"]', '    tasks:',
      '      - id: P1-T01', '        title: "Subject"', '        description: "s"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev',
      '        tracker_issue_id: FORGE-1', '        acceptance: ["ok"]', '        depends_on: [P1-T00]',
      '      - id: P1-T00', '        title: "Dep"', '        description: "d"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev',
      '        tracker_issue_id: DEP-1', '        acceptance: ["ok"]', '',
    ].join('\n'),
    'utf8',
  );
  const depDir = join(ctx.forgeDir, 'orchestrator', 'tasks', 'DEP-1');
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, 'state.json'),
    JSON.stringify({
      version: 1, task_id: 'DEP-1', state: 'merge_pending', state_version: 3, attempt_count: 1,
      failure_count: 0, last_failure_key: null, review_attempt_count: 1, ship_attempt_count: 1,
      current_attempt_id: 'att-1', updated_at: new Date().toISOString(),
      updated_by: { run_id: 'r', claim_id: 'c', generation: 1 },
    }),
    'utf8',
  );
  writeFileSync(
    join(depDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: 'DEP-1', revision: 2, reviewed_head_sha: 'a'.repeat(40),
      review_attempt_id: 'att-r', base: { repo: 'octo/base', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'octo/base', number: 5, url: 'https://github.com/octo/base/pull/5' },
      merge_attempt: 'submitted', updated_at: new Date().toISOString(),
    }),
    'utf8',
  );
  forceState(ctx, 'reviewed');
  stdout.length = 0;

  const open = await runOrchestratePhases(
    { ready: true, phase: 'ship', forgeDir: ctx.forgeDir, json: true },
    { observerFor: async () => ({ mergeResult: async () => ({ merged: false, state: 'open' as const }) }) },
  );
  assert.equal(open.exitCode, 0);
  const env1 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env1.data.tasks.length, 0, 'unmet-dep candidate is not dispatchable');
  assert.equal(env1.data.blocked_on_deps.length, 1);
  assert.equal(env1.data.blocked_on_deps[0].task_id, 'FORGE-1');
  assert.equal(env1.data.blocked_on_deps[0].dependency_gate.deps[0].reason, 'not_merged');
  stdout.length = 0;

  const merged = await runOrchestratePhases(
    { ready: true, phase: 'ship', forgeDir: ctx.forgeDir, json: true },
    {
      observerFor: async () => ({
        mergeResult: async () => ({
          merged: true as const, base_ref: 'main', merge_commit_sha: 'e'.repeat(40), merged_head_sha: 'a'.repeat(40),
        }),
      }),
    },
  );
  assert.equal(merged.exitCode, 0);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.data.tasks.length, 1, 'live merge proof admits the candidate');
  assert.equal(env2.data.blocked_on_deps.length, 0);
});

test('FORGE-233 impl-R1 CRIT: the gate NEVER reads a phases.yaml outside the target repository', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  // NO plans/phases.yaml in ctx.repoRoot. The process cwd (the forge repo)
  // HAS one containing dependency-free tasks — it must not be consulted.
  forceState(ctx, 'reviewed');
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1', claimId: ctx.claimId, runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'), phase: 'ship', forgeDir: ctx.forgeDir, json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'DEPS_NOT_MERGED');
  assert.equal(env.error.details.dependency_gate.subject.resolved, false, 'foreign graph must never admit the task');
  assert.match(env.error.details.dependency_gate.subject.detail, /not found/);
});

test('FORGE-233 impl-R1 MIN: DEEP-EQUAL exact DEPS_NOT_MERGED envelope', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);
  mkdirSync(join(ctx.repoRoot, 'plans'), { recursive: true });
  writeFileSync(
    join(ctx.repoRoot, 'plans', 'phases.yaml'),
    [
      'project: "fixture"', 'phases:', '  - id: phase-1', '    name: "P"', '    status: active',
      '    goal: "G."', '    gate_criteria: ["g"]', '    tasks:',
      '      - id: P1-T01', '        title: "Subject"', '        description: "s"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev',
      '        tracker_issue_id: FORGE-1', '        acceptance: ["ok"]', '        depends_on: [P1-T00]',
      '      - id: P1-T00', '        title: "Dep"', '        description: "d"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev', '        acceptance: ["ok"]', '',
    ].join('\n'),
    'utf8',
  );
  forceState(ctx, 'reviewed');
  stdout.length = 0;
  const result = await runOrchestrateDispatch({
    taskId: 'FORGE-1', claimId: ctx.claimId, runId: ctx.runId,
    worktreePath: join(ctx.repoRoot, 'wt'), phase: 'ship', forgeDir: ctx.forgeDir, json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.deepEqual(env, {
    ok: false,
    error: {
      code: 'DEPS_NOT_MERGED',
      message: 'cannot ship FORGE-1: dependency merge gate unsatisfied (P1-T00:legacy_dependency_unproven)',
      retriable: false,
      details: {
        taskId: 'FORGE-1',
        dependency_gate: {
          version: 1,
          task_id: 'FORGE-1',
          subject: { resolved: true, task_id: 'P1-T01' },
          satisfied: false,
          deps: [{
            declared_id: 'P1-T00',
            resolved_task_id: 'P1-T00',
            state_id: 'P1-T00',
            observed_state: null,
            satisfied: false,
            reason: 'legacy_dependency_unproven',
            disposition: 'operator_action',
            observed: null,
            expected: null,
          }],
          duplicate_declared_ids: [],
        },
      },
    },
  });
});
