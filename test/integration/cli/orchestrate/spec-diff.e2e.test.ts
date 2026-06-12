import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa, execaSync } from 'execa';
import { acquire } from '../../../../src/orchestrator/leases.ts';
import { runOrchestrateSpecDiff } from '../../../../src/cli/orchestrate/spec-diff.ts';
import { computeSpecRevisionSync } from '../../../../src/orchestrator/spec-diff.ts';
import { tsxBin, forgeBinEntry as entry } from '../../../helpers/spawn-tsx.ts';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-spec-diff-e2e-'));
}

function gitInit(repo: string): void {
  execaSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, reject: true });
  execaSync('git', ['config', 'user.email', 'test@forge.test'], { cwd: repo, reject: true });
  execaSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo, reject: true });
  execaSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo, reject: true });
}

function gitCommit(repo: string, msg: string): string {
  execaSync('git', ['add', '-A'], { cwd: repo, reject: true });
  execaSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: repo, reject: true });
  return String(execaSync('git', ['rev-parse', 'HEAD'], { cwd: repo, reject: true }).stdout).trim();
}

function writeSpec(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// Capture stdout/stderr writes into a string for runOrchestrateSpecDiff calls.
function captureStream(): { stream: NodeJS.WritableStream; readonly buffer: string[] } {
  const buf: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      buf.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, get buffer() { return buf; } };
}

// ---- Direct runner (programmatic) ----

test('e2e: spec-diff prints rendered block when 2 commits land in spec/ since claim', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'initial');
    gitCommit(repo, 'add initial spec');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    const rev = computeSpecRevisionSync(repo);
    const lease = acquire({
      forgeDir,
      taskId: 'TASK-E2E1',
      runId: 'run-1',
      specRevision: rev,
      repoRoot: repo,
    });
    assert.equal(lease.spec_revision, rev.revision);

    // Two further spec/ commits.
    writeSpec(repo, 'spec/SPEC.md', 'v2');
    gitCommit(repo, 'fix(spec): clarify lease invariants');
    writeSpec(repo, 'spec/PRD.md', 'first prd');
    gitCommit(repo, 'docs(spec): add doctor enforcement');

    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: 'TASK-E2E1',
      forgeDir,
      repoRoot: repo,
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(result.exitCode, 0);
    const stdout = out.buffer.join('');
    assert.match(stdout, /SPEC changed since you claimed/);
    assert.match(stdout, /2 commits/);
    assert.match(stdout, /spec\/PRD\.md/);
    assert.match(stdout, /spec\/SPEC\.md/);
    assert.match(stdout, /fix\(spec\): clarify lease invariants/);
    assert.match(stdout, /docs\(spec\): add doctor enforcement/);
    assert.match(stdout, /git diff [0-9a-f]+\.\.HEAD -- spec\//);
    assert.match(stdout, /informational only — proceed with your work/);
    assert.equal(err.buffer.join(''), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: spec-diff is silent when 0 commits in spec/ since claim', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'initial');
    gitCommit(repo, 'add initial spec');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    acquire({
      forgeDir,
      taskId: 'TASK-E2E2',
      runId: 'run-1',
      specRevision: computeSpecRevisionSync(repo),
      repoRoot: repo,
    });

    // Unrelated commit — no spec/ changes.
    writeFileSync(join(repo, 'src.txt'), 'a');
    gitCommit(repo, 'unrelated');

    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: 'TASK-E2E2',
      forgeDir,
      repoRoot: repo,
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(out.buffer.join(''), '');
    assert.equal(err.buffer.join(''), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: spec-diff --json returns structured envelope with data on changes', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    acquire({
      forgeDir,
      taskId: 'TASK-E2E3',
      runId: 'run-1',
      specRevision: computeSpecRevisionSync(repo),
      repoRoot: repo,
    });

    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: bump');

    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: 'TASK-E2E3',
      forgeDir,
      repoRoot: repo,
      json: true,
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.equal(payload.ok, true);
    assert.notEqual(payload.data, null);
    assert.equal(payload.data.commitCount, 1);
    assert.deepEqual(payload.data.filesAffected, ['spec/SPEC.md']);
    assert.equal(payload.data.summaries.length, 1);
    assert.match(payload.data.summaries[0], /spec: bump/);
    assert.equal(err.buffer.join(''), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: spec-diff --json returns data:null on empty diff', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    acquire({
      forgeDir,
      taskId: 'TASK-E2E4',
      runId: 'run-1',
      specRevision: computeSpecRevisionSync(repo),
      repoRoot: repo,
    });

    const out = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: 'TASK-E2E4',
      forgeDir,
      repoRoot: repo,
      json: true,
      stdout: out.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.data, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: spec-diff exits 1 with LEASE_NOT_FOUND when lease.json is absent', async () => {
  const repo = mkTmp();
  try {
    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: 'TASK-MISSING',
      forgeDir,
      repoRoot: repo,
      json: true,
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(result.exitCode, 1);
    const payload = JSON.parse(err.buffer.join('').trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'LEASE_NOT_FOUND');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- CLI shell out (built binary path via tsx) ----

test('e2e: forge orchestrate spec-diff via tsx exits 0 and prints block', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });
    acquire({
      forgeDir,
      taskId: 'TASK-E2E5',
      runId: 'run-1',
      specRevision: computeSpecRevisionSync(repo),
      repoRoot: repo,
    });

    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: bump');

    const result = await execa(
      tsxBin,
      [entry, 'orchestrate', 'spec-diff', 'TASK-E2E5', '--forge-dir', forgeDir, '--repo-root', repo],
      { reject: false },
    );
    assert.equal(result.exitCode, 0);
    assert.match(String(result.stdout), /SPEC changed since you claimed/);
    assert.match(String(result.stdout), /spec: bump/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


// ---- FORGE-164: --all-active enumeration ----

import { stateFilePath, leaseFilePath, taskDir } from '../../../../src/orchestrator/questions/paths.ts';

// Seed an ACTIVE task: lease.json (via acquire) + a state.json with an active state.
function seedActiveTask(
  repo: string,
  forgeDir: string,
  taskId: string,
  state: 'dispatched' | 'running' | 'blocked_on_question',
  opts: { expired?: boolean } = {},
): void {
  const lease = acquire({
    forgeDir,
    taskId,
    runId: 'run-1',
    specRevision: computeSpecRevisionSync(repo),
    repoRoot: repo,
  });
  // Overwrite expires_at to simulate an expired lease if requested.
  if (opts.expired) {
    const expired = { ...lease, expires_at: new Date(Date.now() - 60_000).toISOString() };
    writeFileSync(leaseFilePath(forgeDir, taskId), JSON.stringify(expired));
  }
  // Write a minimal valid state.json in an ACTIVE state.
  const now = new Date().toISOString();
  const stateRecord = {
    version: 1,
    task_id: taskId,
    state,
    state_version: 1,
    attempt_count: 1,
    current_attempt_id: 'att-1',
    updated_at: now,
    updated_by: { run_id: 'run-1', claim_id: lease.claim_id, generation: lease.generation },
  };
  mkdirSync(taskDir(forgeDir, taskId), { recursive: true });
  writeFileSync(stateFilePath(forgeDir, taskId), JSON.stringify(stateRecord));
}

test('FORGE-164 — --all-active lists only the stale claim, not the fresh one', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });

    // STALE: claimed at v0, then a spec/ commit lands.
    seedActiveTask(repo, forgeDir, 'TASK-STALE', 'running');
    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: change after stale claim');

    // FRESH: claimed AFTER the change → no diff since its claim.
    seedActiveTask(repo, forgeDir, 'TASK-FRESH', 'dispatched');

    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: '',
      forgeDir,
      repoRoot: repo,
      allActive: true,
      json: true,
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].task_id, 'TASK-STALE');
    assert.equal(payload.data[0].commit_count, 1);
    assert.equal(payload.data[0].lease_expired, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('FORGE-164 — --all-active includes blocked_on_question and flags expired leases', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');

    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });

    seedActiveTask(repo, forgeDir, 'TASK-BLOCKED', 'blocked_on_question', { expired: true });
    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: change');

    const out = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: '',
      forgeDir,
      repoRoot: repo,
      allActive: true,
      json: true,
      stdout: out.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].task_id, 'TASK-BLOCKED');
    assert.equal(payload.data[0].lease_expired, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('FORGE-164 — --all-active empty state → empty list, exit 0', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');
    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });

    const out = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: '',
      forgeDir,
      repoRoot: repo,
      allActive: true,
      json: true,
      stdout: out.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.deepEqual(payload.data, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('FORGE-164 — --all-active: terminal-state task is excluded', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');
    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });

    // Seed an active task, then overwrite state.json to a terminal state.
    seedActiveTask(repo, forgeDir, 'TASK-DONE', 'running');
    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: change');
    const now = new Date().toISOString();
    writeFileSync(
      stateFilePath(forgeDir, 'TASK-DONE'),
      JSON.stringify({
        version: 1, task_id: 'TASK-DONE', state: 'shipped', state_version: 2,
        attempt_count: 1, current_attempt_id: null, updated_at: now,
        updated_by: { run_id: 'run-1', claim_id: 'c', generation: 0 },
      }),
    );

    const out = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: '', forgeDir, repoRoot: repo, allActive: true, json: true, stdout: out.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.deepEqual(payload.data, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('FORGE-164 — --all-active: corrupt lease → skip + stderr note, never fails', async () => {
  const repo = mkTmp();
  try {
    gitInit(repo);
    writeSpec(repo, 'spec/SPEC.md', 'v0');
    gitCommit(repo, 'init');
    const forgeDir = join(repo, '.forge');
    mkdirSync(forgeDir, { recursive: true });

    seedActiveTask(repo, forgeDir, 'TASK-CORRUPT', 'running');
    writeSpec(repo, 'spec/SPEC.md', 'v1');
    gitCommit(repo, 'spec: change');
    // Corrupt the lease.
    writeFileSync(leaseFilePath(forgeDir, 'TASK-CORRUPT'), '{ not json');

    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateSpecDiff({
      taskId: '', forgeDir, repoRoot: repo, allActive: true, json: true,
      stdout: out.stream, stderr: err.stream,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.buffer.join('').trim());
    assert.deepEqual(payload.data, []);
    assert.match(err.buffer.join(''), /TASK-CORRUPT/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
