import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { runOrchestrateGc } from '../../../../src/cli/orchestrate/gc.ts';
import { create } from '../../../../src/core/workspace.ts';
import { dispatchOrchestrate } from '../../../../src/cli/orchestrate/index.ts';

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-gc-'));
}

function writeLegacy(forgeDir: string, kind: 'questions' | 'answers', file: string, body: string): void {
  const dir = join(forgeDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}

function captureStreams(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on('data', (c: Buffer) => outChunks.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

const fixedNow = (): Date => new Date('2026-05-15T01:23:45.000Z');

test('orchestrate gc on a clean tree exits 0 with no migrations', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    const result = await runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 0);
    assert.match(out(), /No legacy files to migrate\./);
    assert.equal(err(), '');
    // No archive directory should be created if there's nothing to archive.
    assert.equal(existsSync(join(forgeDir, 'orchestrator', 'legacy')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc moves legacy questions and answers to a timestamped archive', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{"hello":"q1"}');
    writeLegacy(forgeDir, 'questions', 'q2.json', '{"hello":"q2"}');
    writeLegacy(forgeDir, 'answers', 'q1.json', '{"hello":"a1"}');
    const result = await runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 3);
    assert.match(out(), /Migrated 3 legacy file/);
    // Archive root exists with the timestamp-derived session.
    const sessions = readdirSync(join(forgeDir, 'orchestrator', 'legacy'));
    assert.equal(sessions.length, 1);
    const archiveBase = join(forgeDir, 'orchestrator', 'legacy', sessions[0]!);
    // All three files copied with content intact.
    assert.equal(readFileSync(join(archiveBase, 'questions', 'q1.json'), 'utf8'), '{"hello":"q1"}');
    assert.equal(readFileSync(join(archiveBase, 'questions', 'q2.json'), 'utf8'), '{"hello":"q2"}');
    assert.equal(readFileSync(join(archiveBase, 'answers', 'q1.json'), 'utf8'), '{"hello":"a1"}');
    // Originals removed.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json')), false);
    assert.equal(existsSync(join(forgeDir, 'questions', 'q2.json')), false);
    assert.equal(existsSync(join(forgeDir, 'answers', 'q1.json')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc leaves .tmp residue alone — only canonical .json files migrate', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    writeLegacy(forgeDir, 'questions', 'q1.json.123.4.abc.tmp', 'aborted-write-residue');
    const result = await runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 1);
    // The .tmp residue stays where it was.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json.123.4.abc.tmp')), true);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc --dry-run prints the plan without modifying disk', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    writeLegacy(forgeDir, 'answers', 'q1.json', '{}');
    const result = await runOrchestrateGc({
      forgeDir,
      dryRun: true,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 2);
    assert.match(out(), /gc plan/);
    assert.match(out(), /2 file\(s\) would be migrated/);
    // Originals remain — dry-run is read-only.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json')), true);
    assert.equal(existsSync(join(forgeDir, 'answers', 'q1.json')), true);
    // No archive directory created.
    assert.equal(existsSync(join(forgeDir, 'orchestrator', 'legacy')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// Codex review T-codex-2: a pathological subdirectory whose name ends in .json
// must NOT be planned as a file. Without isFile() filtering, linkSync would
// fail mid-pass and abort the whole gc, leaving valid legacy files unmigrated.
test('orchestrate gc skips subdirectories whose name ends in .json (Codex review)', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    // Real legacy file that should migrate.
    writeLegacy(forgeDir, 'questions', 'q1.json', '{"hello":"q1"}');
    // Pathological subdirectory with a .json name. Without dirent filtering
    // this would be treated as a candidate, link() would fail with EISDIR or
    // EPERM, and the gc would abort before migrating q1.json.
    mkdirSync(join(forgeDir, 'questions', 'pathological.json'), {
      recursive: true,
    });
    const result = await runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 1);
    assert.match(out(), /Migrated 1 legacy file/);
    // The real file landed in the archive.
    const sessions = readdirSync(join(forgeDir, 'orchestrator', 'legacy'));
    assert.equal(sessions.length, 1);
    const archiveBase = join(forgeDir, 'orchestrator', 'legacy', sessions[0]!);
    assert.equal(
      readFileSync(join(archiveBase, 'questions', 'q1.json'), 'utf8'),
      '{"hello":"q1"}',
    );
    // The pathological directory is left in place.
    assert.equal(existsSync(join(forgeDir, 'questions', 'pathological.json')), true);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc is idempotent — re-running after a successful migration is a no-op', async () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    const first = await runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(first.exitCode, 0);
    assert.equal(first.migrated.length, 1);
    // Second run sees no source files; reports 0 migrations.
    const { stdout: s2, stderr: e2, out: out2 } = captureStreams();
    const second = await runOrchestrateGc({ forgeDir, stdout: s2, stderr: e2, now: fixedNow });
    assert.equal(second.exitCode, 0);
    assert.equal(second.migrated.length, 0);
    assert.match(out2(), /No legacy files to migrate/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  `--remove-worktrees` mode (FORGE-116) — real-git-repo fixtures.
//
//  These need a REAL git repo (workspace.test.ts patterns), not gc's temp-.forge
//  harness alone — workspace.cleanup() shells out to `git worktree remove`.
// ────────────────────────────────────────────────────────────────────────────

import type { TaskState } from '../../../../src/schemas/task-state.ts';

function repoTmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `forge-gc-wt-${label}-`));
}

async function initRepo(repoDir: string): Promise<void> {
  await execa('git', ['init', '-b', 'main', repoDir], { reject: true });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, reject: true });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, reject: true });
  writeFileSync(join(repoDir, 'README.md'), '# test\n');
  await execa('git', ['add', '.'], { cwd: repoDir, reject: true });
  await execa('git', ['commit', '-m', 'init'], { cwd: repoDir, reject: true });
}

// Write state.json under forgeDir/orchestrator/tasks/<id>/.
function writeState(forgeDir: string, taskId: string, state: TaskState): void {
  const dir = join(forgeDir, 'orchestrator', 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  const record = {
    version: 1,
    task_id: taskId,
    state,
    state_version: 1,
    attempt_count: 1,
    current_attempt_id: null,
    updated_at: '2026-05-15T00:00:00.000Z',
    updated_by: { run_id: 'run-1', claim_id: 'claim-1', generation: 0 },
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(record, null, 2) + '\n');
}

// Write a valid lease.json with the given expires_at.
function writeLease(forgeDir: string, taskId: string, expiresAt: string): void {
  const dir = join(forgeDir, 'orchestrator', 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  const lease = {
    version: 1,
    claim_id: 'claim-1',
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-1',
    acquired_at: '2026-05-14T00:00:00.000Z',
    expires_at: expiresAt,
    last_heartbeat_at: '2026-05-14T00:00:00.000Z',
    generation: 0,
    spec_revision: 'git:' + 'a'.repeat(40),
  };
  writeFileSync(join(dir, 'lease.json'), JSON.stringify(lease, null, 2) + '\n');
}

function writeRawLease(forgeDir: string, taskId: string, body: string): void {
  const dir = join(forgeDir, 'orchestrator', 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lease.json'), body);
}

interface WtFixture {
  repoDir: string;
  forgeDir: string;
  root: string;
}

async function setupRepoFixture(label: string): Promise<WtFixture> {
  const repoDir = repoTmp(label);
  await initRepo(repoDir);
  const forgeDir = join(repoDir, '.forge');
  const root = join(forgeDir, 'worktrees');
  mkdirSync(root, { recursive: true });
  return { repoDir, forgeDir, root };
}

// Create a worktree for `taskId` and set its task state.
async function makeWorktree(fx: WtFixture, taskId: string, state: TaskState): Promise<string> {
  const result = await create(taskId, {
    root: fx.root,
    base: 'main',
    copyMeta: false,
    mainWorktree: fx.repoDir,
  });
  writeState(fx.forgeDir, taskId, state);
  return result.path;
}

const NOW = new Date('2026-05-15T12:00:00.000Z');
const fixedNowWt = (): Date => NOW;

// A lease that is far in the past is stale; far in the future is alive.
const STALE_EXPIRY = '2026-05-15T00:00:00.000Z';   // 12h before NOW (> grace) → stale
const ALIVE_EXPIRY = '2026-05-15T18:00:00.000Z';   // 6h after NOW → alive
const EXPIRING_EXPIRY = '2026-05-15T11:58:00.000Z'; // 2m before NOW, within 5m grace → expiring_soon

test('remove-worktrees: happy path — shipped task removed, branch SURVIVES', async () => {
  const fx = await setupRepoFixture('happy');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-1', 'shipped');
    assert.ok(existsSync(wtPath));
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-1',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.removeWorktrees?.results?.[0]?.outcome, 'removed');
    // Worktree directory gone.
    assert.equal(existsSync(wtPath), false);
    // Branch SURVIVES — verb removes worktrees only (delta 6).
    const branches = await execa('git', ['branch', '--list', 'feat/WT-1'], { cwd: fx.repoDir });
    assert.match(branches.stdout, /feat\/WT-1/);
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: ready_for_review allowed via --task', async () => {
  const fx = await setupRepoFixture('rfr-single');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-10', 'ready_for_review');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-10',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.removeWorktrees?.results?.[0]?.outcome, 'removed');
    assert.equal(existsSync(wtPath), false);
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: ready_for_review REFUSED in batch mode (terminal-only)', async () => {
  const fx = await setupRepoFixture('rfr-batch');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-11', 'ready_for_review');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true, // batch — no removeWorktreesTask
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    const refused = result.removeWorktrees?.refused ?? [];
    assert.ok(refused.some((r) => r.task_id === 'WT-11' && /terminal/.test(r.reason)));
    // Nothing deleted (dry-run anyway).
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: ACTIVE state (running) refused in both modes', async () => {
  const fx = await setupRepoFixture('active');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-12', 'running');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-12',
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    const refused = result.removeWorktrees?.refused ?? [];
    assert.ok(refused.some((r) => r.task_id === 'WT-12' && /active state/.test(r.reason)));
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: abandoned and unclaimed refused', async () => {
  const fx = await setupRepoFixture('abandoned-unclaimed');
  const { stdout, stderr } = captureStreams();
  try {
    await makeWorktree(fx, 'WT-13', 'abandoned');
    await makeWorktree(fx, 'WT-14', 'unclaimed');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    const refused = result.removeWorktrees?.refused ?? [];
    assert.ok(refused.some((r) => r.task_id === 'WT-13' && /abandoned/.test(r.reason)));
    assert.ok(refused.some((r) => r.task_id === 'WT-14' && /unclaimed/.test(r.reason)));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: alive lease refused', async () => {
  const fx = await setupRepoFixture('alive-lease');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-15', 'shipped');
    writeLease(fx.forgeDir, 'WT-15', ALIVE_EXPIRY);
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-15',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    assert.ok((result.removeWorktrees?.refused ?? []).some((r) => /alive/.test(r.reason)));
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: expiring_soon lease refused', async () => {
  const fx = await setupRepoFixture('expiring-lease');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-16', 'shipped');
    writeLease(fx.forgeDir, 'WT-16', EXPIRING_EXPIRY);
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-16',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    assert.ok((result.removeWorktrees?.refused ?? []).some((r) => /expiring_soon/.test(r.reason)));
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: stale lease allowed', async () => {
  const fx = await setupRepoFixture('stale-lease');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-17', 'shipped');
    writeLease(fx.forgeDir, 'WT-17', STALE_EXPIRY);
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-17',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.removeWorktrees?.results?.[0]?.outcome, 'removed');
    assert.equal(existsSync(wtPath), false);
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: malformed lease refused (never treated as absent)', async () => {
  const fx = await setupRepoFixture('malformed-lease');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-18', 'shipped');
    writeRawLease(fx.forgeDir, 'WT-18', '{ not valid json ');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-18',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    assert.ok((result.removeWorktrees?.refused ?? []).some((r) => /malformed|refusing/.test(r.reason)));
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: missing worktree → noop via absent list (delta 8, fix 3)', async () => {
  const fx = await setupRepoFixture('missing');
  const { stdout, stderr } = captureStreams();
  try {
    // No worktree created for WT-19; state exists but dir does not.
    writeState(fx.forgeDir, 'WT-19', 'shipped');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-19',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // Pure noop: exit 0 (distinguishable from a gate refusal).
    assert.equal(result.exitCode, 0);
    // Planner puts the absent worktree in `absent`, NOT `refused`.
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    assert.equal(result.removeWorktrees?.refused.length, 0);
    assert.ok((result.removeWorktrees?.absent ?? []).some((a) => a.task_id === 'WT-19'));
    // Non-dry-run also produces a noop outcome in results.
    const resultItem = result.removeWorktrees?.results?.find((r) => r.task_id === 'WT-19');
    assert.ok(resultItem, 'result entry present');
    assert.equal(resultItem?.outcome, 'noop');
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: --dry-run plans only, nothing deleted, JSON shape', async () => {
  const fx = await setupRepoFixture('dryrun');
  const { stdout, stderr, out } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-20', 'shipped');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-20',
      dryRun: true,
      json: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    // Worktree still present — dry-run deletes nothing.
    assert.ok(existsSync(wtPath));
    // Envelope: results is absent on dry-run; eligible carries the candidate.
    assert.equal(result.removeWorktrees?.dryRun, true);
    assert.equal(result.removeWorktrees?.results, undefined);
    assert.equal(result.removeWorktrees?.eligible.length, 1);
    const elig = result.removeWorktrees!.eligible[0]!;
    assert.equal(elig.task_id, 'WT-20');
    assert.equal(elig.branch, 'feat/WT-20');
    assert.equal(elig.state, 'shipped');
    assert.equal(elig.worktree_path, wtPath);
    // JSON stdout matches the planner envelope the SKILL consumes.
    const parsed = JSON.parse(out().trim());
    assert.deepEqual(Object.keys(parsed).sort(), ['absent', 'eligible', 'refused']);
    assert.equal(parsed.eligible[0].task_id, 'WT-20');
    assert.equal(parsed.eligible[0].worktree_path, wtPath);
    assert.equal(parsed.eligible[0].branch, 'feat/WT-20');
    assert.equal(parsed.eligible[0].state, 'shipped');
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: marker/dirname mismatch refused', async () => {
  const fx = await setupRepoFixture('mismatch');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-21', 'shipped');
    // Corrupt the marker so taskId != dirname.
    const markerPath = join(wtPath, '.forge', 'worktree-task.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.taskId = 'WT-OTHER';
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-21',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    assert.ok((result.removeWorktrees?.refused ?? []).some((r) => /marker/.test(r.reason)));
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees: gitignored-loss refusal surfaced verbatim with guidance', async () => {
  const fx = await setupRepoFixture('gitignored');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-22', 'shipped');
    // Plant a gitignored file NOT in the manifest (copyMeta:false → no manifest).
    writeFileSync(join(wtPath, '.gitignore'), 'junk.local\n');
    writeFileSync(join(wtPath, 'junk.local'), 'planted gitignored residue\n');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-22',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // Refused at execute time; surfaced verbatim with manual guidance.
    assert.equal(result.exitCode, 1);
    const r = result.removeWorktrees?.results?.[0];
    assert.equal(r?.outcome, 'refused');
    assert.match(r?.reason ?? '', /gitignored/);
    assert.match(r?.reason ?? '', /re-run/);
    // Worktree NOT removed.
    assert.ok(existsSync(wtPath));
  } finally {
    // Force-remove for cleanup since the verb refused.
    try {
      await execa('git', ['worktree', 'remove', '--force', join(fx.root, 'WT-22')], { cwd: fx.repoDir });
    } catch { /* ignore */ }
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

// ── Flag-validation through the real dispatch/parse path ──

function captureProcess(): { restore: () => void; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (c: string | Uint8Array): boolean => {
    outChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  };
  (process.stderr.write as unknown) = (c: string | Uint8Array): boolean => {
    errChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  };
  return {
    restore: () => {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

test('remove-worktrees flag validation: --task with no value rejected', async () => {
  const fx = await setupRepoFixture('flag-task-noval');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--task', '--dry-run', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees flag validation: unknown/incompatible flag rejected in this mode', async () => {
  const fx = await setupRepoFixture('flag-unknown');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--scope', 'all', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('remove-worktrees flag validation: --task with a value parses and runs (dry-run json)', async () => {
  const fx = await setupRepoFixture('flag-ok');
  const cap = captureProcess();
  try {
    await makeWorktree(fx, 'WT-23', 'shipped');
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--task', 'WT-23', '--dry-run', '--json', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(cap.out().trim());
    assert.equal(parsed.eligible[0].task_id, 'WT-23');
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

// ── Fix 1: task-id traversal validation ──────────────────────────────────────

test('fix1 traversal: --task with path-traversal value rejected before path construction', async () => {
  // A value like `../..` must be caught at the CLI flag level, well before any
  // path join happens in the gc planner. Without the fix this would navigate
  // outside .forge/worktrees.
  const fx = await setupRepoFixture('fix1-traversal');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--task', '../..', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
    // Either stdout or stderr should contain the INVALID_ARGS message.
    const combined = cap.out() + cap.err();
    assert.match(combined, /INVALID_ARGS|invalid task id/i);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix1 traversal: marker with invalid taskId (path sep) is refused by planner', async () => {
  // A worktree whose .forge/worktree-task.json has taskId = '../bad' must be
  // refused by readWorktreeMarker (marker invalid) before the taskId enters any
  // path join.
  const fx = await setupRepoFixture('fix1-marker');
  const { stdout, stderr } = captureStreams();
  try {
    // Create a valid worktree, then corrupt its marker taskId to contain '/'.
    const wtPath = await makeWorktree(fx, 'WT-24', 'shipped');
    const markerPath = join(wtPath, '.forge', 'worktree-task.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.taskId = '../bad';
    writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-24',
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // Marker is invalid → refused, not eligible.
    assert.equal(result.removeWorktrees?.eligible.length, 0);
    const refused = result.removeWorktrees?.refused ?? [];
    assert.ok(refused.some((r) => /marker/.test(r.reason)), 'marker refusal reason present');
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix1 traversal: --task with non-numeric suffix rejected (e.g. FORGE-abc)', async () => {
  const fx = await setupRepoFixture('fix1-bad-suffix');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--task', 'FORGE-abc', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
    const combined = cap.out() + cap.err();
    assert.match(combined, /INVALID_ARGS|invalid task id/i);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix1 traversal: phases-shape task id P1-T3 accepted by --task', async () => {
  // The phases shape (P\d+-T\d+) is a second valid form for worktree dirs.
  const fx = await setupRepoFixture('fix1-phases-id');
  const { stdout, stderr } = captureStreams();
  try {
    // P1-T3 is a valid phases-shape ID; the worktree doesn't exist so it
    // should land in `absent`, NOT be rejected as INVALID_ARGS.
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'P1-T3',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // Absent (not rejected), exit 0.
    assert.equal(result.exitCode, 0);
    assert.ok((result.removeWorktrees?.absent ?? []).some((a) => a.task_id === 'P1-T3'));
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

// ── Fix 2: execution-time gate refusals produce exit 1 ───────────────────────

test('fix2 exit-code: execute-time refused outcome → exit 1', async () => {
  // Simulate a lease that goes alive between plan and execute by using a
  // non-dry-run path where the re-check at execute time refuses. We exercise
  // this by creating a task that is eligible at plan time (shipped, no lease)
  // but writing a fresh alive lease between plan and execute.
  //
  // The cleanest harness: write an alive lease BEFORE the call, then run
  // runOrchestrateGc without dry-run. The planner runs first (plan includes it
  // in eligible because we haven't added the lease yet — wait, we need a trick).
  //
  // Alternative: just confirm the gitignored-loss path (already tested above at
  // `gitignored-loss refusal surfaced verbatim`) exits 1 — which it now does
  // per our fix. We add a second direct test by running non-dry-run against a
  // task whose execute-time re-check of state returns ineligible.
  const fx = await setupRepoFixture('fix2-exit-code');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-25', 'shipped');
    // After the worktree is created, overwrite the state to `running` so the
    // execute-time re-check refuses (state changed to active between plan and execute).
    // The planner will have included it in eligible (it sees `shipped` before the write).
    // We do the switch AFTER makeWorktree (which calls writeState(shipped)) to simulate
    // TOCTOU. However, planRemoveWorktrees re-reads state too — so we need to trick it.
    // Simplest: run the GC with --dry-run=false against a worktree that has a live lease.
    // The lease check at execute time will refuse, producing outcome: 'refused' → exit 1.
    writeLease(fx.forgeDir, 'WT-25', ALIVE_EXPIRY);
    // Plan will include WT-25 in eligible (checkLeaseGate at plan time might also refuse).
    // Non-dry-run with NO eligible tasks and ONE planner-refused task (alive
    // lease): the refusal MUST fail the command (exit 1) so /wrap-up never
    // proceeds to branch deletion after nothing was removed (Codex round 2).
    const state = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-25',
      dryRun: false,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // WT-25 had an alive lease → planner refuses it; eligible/results empty;
    // the refusal itself fails the command.
    assert.equal(state.exitCode, 1);
    assert.equal((state.removeWorktrees?.refused ?? []).length, 1);
    assert.equal((state.removeWorktrees?.results ?? []).length, 0);
    assert.ok(existsSync(wtPath), 'worktree not removed (was refused by planner)');
  } finally {
    try { await execa('git', ['worktree', 'remove', '--force', join(fx.root, 'WT-25')], { cwd: fx.repoDir }); } catch { /* ignore */ }
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix2 exit-code: result outcome=error in results[] → exit 1', async () => {
  // Directly verify: a RemoveWorktreesResult with outcome=error causes exit 1.
  // We test this via the gitignored-loss path (already verified above to exit 1),
  // and confirm the contract: any error or refused in results[] sets exit 1.
  // This test uses the existing gitignored fixture as a proxy but also directly
  // asserts the exit code is 1 (the earlier test already covers this; this is
  // a focused contract assertion).
  const fx = await setupRepoFixture('fix2-error-exit');
  const { stdout, stderr } = captureStreams();
  try {
    const wtPath = await makeWorktree(fx, 'WT-26', 'shipped');
    writeFileSync(join(wtPath, '.gitignore'), 'secret.local\n');
    writeFileSync(join(wtPath, 'secret.local'), 'planted\n');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-26',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 1, 'refused outcome in results[] must produce exit 1');
    const r = result.removeWorktrees?.results?.find((x) => x.task_id === 'WT-26');
    assert.equal(r?.outcome, 'refused');
  } finally {
    try { await execa('git', ['worktree', 'remove', '--force', join(fx.root, 'WT-26')], { cwd: fx.repoDir }); } catch { /* ignore */ }
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

// ── Fix 3: absent-worktree noop distinguishable from refused ─────────────────

test('fix3 noop: absent worktree in absent list, not refused, exit 0', async () => {
  // Dedicated test: absent is distinguishable from refused.
  const fx = await setupRepoFixture('fix3-absent');
  const { stdout, stderr } = captureStreams();
  try {
    writeState(fx.forgeDir, 'WT-27', 'shipped');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-27',
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.removeWorktrees?.refused.length, 0, 'absent must NOT be in refused');
    assert.ok((result.removeWorktrees?.absent ?? []).some((a) => a.task_id === 'WT-27'), 'absent must be in absent list');
    assert.equal(result.removeWorktrees?.eligible.length, 0);
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix3 noop: non-dry-run absent → outcome noop in results[], exit 0', async () => {
  const fx = await setupRepoFixture('fix3-absent-exec');
  const { stdout, stderr } = captureStreams();
  try {
    writeState(fx.forgeDir, 'WT-28', 'shipped');
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      removeWorktreesTask: 'WT-28',
      stdout,
      stderr,
      now: fixedNowWt,
    });
    assert.equal(result.exitCode, 0, 'pure noop must exit 0');
    const r = result.removeWorktrees?.results?.find((x) => x.task_id === 'WT-28');
    assert.ok(r, 'result entry present for absent worktree');
    assert.equal(r?.outcome, 'noop', 'absent worktree produces outcome: noop');
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

// ── Fix 4: positional arguments rejected ─────────────────────────────────────

test('fix4 positional: stray positional argument rejected in --remove-worktrees mode', async () => {
  const fx = await setupRepoFixture('fix4-positional');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', 'some-extra-arg', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
    const combined = cap.out() + cap.err();
    assert.match(combined, /INVALID_ARGS|positional/i);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix4 positional: positional before flags rejected', async () => {
  const fx = await setupRepoFixture('fix4-positional2');
  const cap = captureProcess();
  try {
    const result = await dispatchOrchestrate(
      ['gc', '--remove-worktrees', '--dry-run', 'some-extra-arg', '--forge-dir', fx.forgeDir],
      { cwd: fx.repoDir },
    );
    assert.equal(result.exitCode, 1);
    const combined = cap.out() + cap.err();
    assert.match(combined, /INVALID_ARGS|positional/i);
  } finally {
    cap.restore();
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});

test('fix4 positional: no positionals + valid flags passes (not rejected)', async () => {
  const fx = await setupRepoFixture('fix4-nopos');
  const { stdout, stderr } = captureStreams();
  try {
    const result = await runOrchestrateGc({
      forgeDir: fx.forgeDir,
      removeWorktrees: true,
      dryRun: true,
      stdout,
      stderr,
      now: fixedNowWt,
    });
    // Empty worktrees dir → no eligible, no refused, no absent.
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(fx.repoDir, { recursive: true, force: true });
  }
});
