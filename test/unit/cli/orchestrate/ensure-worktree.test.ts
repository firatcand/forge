import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateEnsureWorktree } from '../../../../src/cli/orchestrate/ensure-worktree.ts';

// Each test gets a fresh throwaway repo so worktree operations are isolated.
// Mirrors the pattern used by other orchestrate tests (mkdtemp + cwd).
async function freshRepo(): Promise<{ repoRoot: string; forgeDir: string; cleanup: () => void }> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-ensure-wt-'));
  // Bootstrap a minimal git repo with one commit on 'main' so `worktree add` has a base.
  await execa('git', ['init', '-b', 'main', repoRoot], { reject: true });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, reject: true });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, reject: true });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot, reject: true });
  writeFileSync(join(repoRoot, 'CLAUDE.md'), '# test\n');
  await execa('git', ['add', '.'], { cwd: repoRoot, reject: true });
  await execa('git', ['commit', '-m', 'bootstrap', '--allow-empty'], { cwd: repoRoot, reject: true });

  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(forgeDir, { recursive: true });

  return {
    repoRoot,
    forgeDir,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

// Capture stdout so we can parse JSON envelopes without polluting test output.
function captureStdout(t: { after: (fn: () => void) => void }): { lines: string[] } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return { lines: captured };
}

function lastJsonEnvelope(lines: string[]): { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } {
  const last = lines[lines.length - 1] ?? '';
  return JSON.parse(last);
}

test('ensure-worktree: fresh create writes worktree + marker + hydrates CLAUDE.md', async (t) => {
  const { repoRoot, forgeDir, cleanup } = await freshRepo();
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const result = await runOrchestrateEnsureWorktree({
    taskId: 'FORGE-200',
    forgeDir,
    repoRoot,
    json: true,
    base: 'main',
  });
  assert.equal(result.exitCode, 0);
  const env = lastJsonEnvelope(lines);
  assert.equal(env.ok, true);
  const data = env.data as Record<string, unknown>;
  assert.equal(data.created, true);
  const wtPath = data.worktree_path as string;
  assert.ok(existsSync(wtPath), 'worktree path exists');
  assert.ok(existsSync(join(wtPath, '.forge', 'worktree-task.json')), 'marker present');
  assert.ok(existsSync(join(wtPath, 'CLAUDE.md')), 'CLAUDE.md hydrated');
  // The marker binds this worktree to FORGE-200.
  const marker = JSON.parse(readFileSync(join(wtPath, '.forge', 'worktree-task.json'), 'utf8'));
  assert.equal(marker.taskId, 'FORGE-200');
});

test('ensure-worktree: second call with same task_id is idempotent (no-op exit 0)', async (t) => {
  const { repoRoot, forgeDir, cleanup } = await freshRepo();
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const first = await runOrchestrateEnsureWorktree({
    taskId: 'FORGE-201',
    forgeDir,
    repoRoot,
    json: true,
    base: 'main',
  });
  assert.equal(first.exitCode, 0);

  const second = await runOrchestrateEnsureWorktree({
    taskId: 'FORGE-201',
    forgeDir,
    repoRoot,
    json: true,
    base: 'main',
  });
  assert.equal(second.exitCode, 0);
  const env = lastJsonEnvelope(lines);
  assert.equal(env.ok, true);
  const data = env.data as Record<string, unknown>;
  // Second call recognized the existing marker — created: false.
  assert.equal(data.created, false);
});

test('ensure-worktree: conflicting marker (different task_id at same path) returns WORKTREE_CONFLICT', async (t) => {
  const { repoRoot, forgeDir, cleanup } = await freshRepo();
  const { lines } = captureStdout(t);
  t.after(cleanup);

  // Pre-create a worktree path with a marker for a DIFFERENT task.
  const wtPath = join(repoRoot, '.forge', 'worktrees', 'FORGE-202');
  mkdirSync(join(wtPath, '.forge'), { recursive: true });
  writeFileSync(
    join(wtPath, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId: 'FORGE-OTHER' }),
  );

  const result = await runOrchestrateEnsureWorktree({
    taskId: 'FORGE-202',
    forgeDir,
    repoRoot,
    json: true,
    base: 'main',
  });
  assert.equal(result.exitCode, 1);
  const env = lastJsonEnvelope(lines);
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, 'WORKTREE_CONFLICT');
});

test('ensure-worktree: existing path with no marker refuses to overwrite', async (t) => {
  const { repoRoot, forgeDir, cleanup } = await freshRepo();
  const { lines } = captureStdout(t);
  t.after(cleanup);

  // Create the path without a marker.
  const wtPath = join(repoRoot, '.forge', 'worktrees', 'FORGE-203');
  mkdirSync(wtPath, { recursive: true });

  const result = await runOrchestrateEnsureWorktree({
    taskId: 'FORGE-203',
    forgeDir,
    repoRoot,
    json: true,
    base: 'main',
  });
  assert.equal(result.exitCode, 1);
  const env = lastJsonEnvelope(lines);
  assert.equal(env.error?.code, 'WORKTREE_CONFLICT');
});

test('ensure-worktree: malformed task_id returns INVALID_ARGS', async (t) => {
  const { repoRoot, forgeDir, cleanup } = await freshRepo();
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const result = await runOrchestrateEnsureWorktree({
    taskId: '../etc/passwd',
    forgeDir,
    repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastJsonEnvelope(lines);
  assert.equal(env.ok, false);
  // Schema rejects ../etc/passwd via TaskIdSchema regex before workspace.ts runs.
  assert.equal(env.error?.code, 'INVALID_ARGS');
});
