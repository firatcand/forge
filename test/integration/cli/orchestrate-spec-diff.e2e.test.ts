import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, execaSync } from 'execa';
import { acquire } from '../../../src/orchestrator/leases.ts';
import { runOrchestrateSpecDiff } from '../../../src/cli/orchestrate-spec-diff.ts';
import { computeSpecRevisionSync } from '../../../src/orchestrator/spec-diff.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const entry = resolve(repoRoot, 'src/bin/forge.ts');
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');

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

