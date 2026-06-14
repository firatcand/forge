import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runStatusline } from '../../../src/cli/statusline.ts';
import type { TaskState } from '../../../src/schemas/task-state.ts';

function capture(): { stdout: PassThrough; out: () => string } {
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { stdout, out: () => chunks.join('') };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-statusline-'));
}

/** Write a minimal valid state.json for <taskId> in <cwd>/.forge. */
function writeState(cwd: string, taskId: string, state: TaskState): void {
  const p = join(cwd, '.forge', 'orchestrator', 'tasks', taskId, 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      task_id: taskId,
      state,
      state_version: 0,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'run-seed', claim_id: 'claim-seed', generation: 0 },
    }),
    'utf8',
  );
}

/** Materialize an empty orchestrator tasks root so the dir is a "forge repo". */
function makeForgeRepo(cwd: string): void {
  mkdirSync(join(cwd, '.forge', 'orchestrator', 'tasks'), { recursive: true });
}

test('statusline: not a forge repo (no .forge tasks root) → empty output, exit 0', () => {
  const cwd = freshDir();
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: forge repo with 0 parked tasks → "forge ◇ 0"', () => {
  const cwd = freshDir();
  makeForgeRepo(cwd);
  // A non-parked task does not contribute to the count.
  writeState(cwd, 'P1-T01', 'running');
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◇ 0\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: forge repo with 0 tasks at all → "forge ◇ 0"', () => {
  const cwd = freshDir();
  makeForgeRepo(cwd);
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◇ 0\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: N parked tasks → "forge ◆ N to answer"', () => {
  const cwd = freshDir();
  makeForgeRepo(cwd);
  writeState(cwd, 'P1-T01', 'blocked_on_question');
  writeState(cwd, 'P1-T02', 'blocked_on_question');
  writeState(cwd, 'P1-T03', 'running'); // not counted
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◆ 2 to answer\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: single parked task → "forge ◆ 1 to answer"', () => {
  const cwd = freshDir();
  makeForgeRepo(cwd);
  writeState(cwd, 'P1-T01', 'blocked_on_question');
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◆ 1 to answer\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: corrupt state.json does not crash → benign output', () => {
  const cwd = freshDir();
  makeForgeRepo(cwd);
  const p = join(cwd, '.forge', 'orchestrator', 'tasks', 'P1-T01', 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'not json', 'utf8');
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: [], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◇ 0\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('statusline: --forge-dir resolves an alternate forge dir', () => {
  const cwd = freshDir();
  const altForge = join(cwd, 'custom-forge');
  mkdirSync(join(altForge, 'orchestrator', 'tasks'), { recursive: true });
  const p = join(altForge, 'orchestrator', 'tasks', 'P1-T01', 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      task_id: 'P1-T01',
      state: 'blocked_on_question',
      state_version: 0,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
    }),
    'utf8',
  );
  const { stdout, out } = capture();
  try {
    const res = runStatusline({ cwd, rest: ['--forge-dir', altForge], stdout });
    assert.equal(res.exitCode, 0);
    assert.equal(out(), 'forge ◆ 1 to answer\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
