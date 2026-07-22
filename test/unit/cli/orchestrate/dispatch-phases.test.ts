import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { execaSync } from 'execa';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';
import { TASK_MARKER_RELPATH } from '../../../../src/core/workspace.ts';

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

test('dispatch --phase review without a frozen base marker refuses with a backfill hint', async (t) => {
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
  assert.match(env.error.message, /base_branch/);
});

test('dispatch --phase ship: legal only from reviewed; pointer self-loop', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupClaimed(stdout);

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
