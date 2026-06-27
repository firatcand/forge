// FORGE-155: unit tests for the `forge upgrade` exit-2 in-flight guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execaSync } from 'execa';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkInFlight } from '../../../src/cli/upgrade/in-flight-guard.ts';

const NOW = new Date('2026-06-26T12:00:00.000Z');

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-inflight-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeLease(dir: string, taskId: string, body: string): void {
  const taskDir = join(dir, '.forge', 'orchestrator', 'tasks', taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'lease.json'), body);
}

function leaseJson(expiresAt: string, taskId = 'FORGE-1'): string {
  return JSON.stringify({
    version: 1,
    claim_id: 'claim-1',
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-1',
    acquired_at: '2026-06-26T11:00:00.000Z',
    expires_at: expiresAt,
    last_heartbeat_at: '2026-06-26T11:55:00.000Z',
    generation: 0,
    spec_revision: 'abc123',
  });
}

function gitInit(dir: string): void {
  execaSync('git', ['init', '-q'], { cwd: dir });
  execaSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  execaSync('git', ['config', 'user.name', 'T'], { cwd: dir });
}

// ── toggle + --force ──────────────────────────────────────────────────────────

test('guard disabled → never blocks even with a dirty tree + active lease', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'foo.txt'), 'uncommitted');
    writeLease(dir, 'FORGE-1', leaseJson('2026-06-26T12:30:00.000Z'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: false, now: NOW });
    assert.equal(r, null);
  } finally {
    cleanup();
  }
});

test('--force → overrides both dirty tree and active lease', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'foo.txt'), 'uncommitted');
    writeLease(dir, 'FORGE-1', leaseJson('2026-06-26T12:30:00.000Z'));
    const r = checkInFlight({ cwd: dir, force: true, guardEnabled: true, now: NOW });
    assert.equal(r, null);
  } finally {
    cleanup();
  }
});

// ── dirty tree ────────────────────────────────────────────────────────────────

test('dirty working tree → exit 2', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'foo.txt'), 'uncommitted');
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r);
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /uncommitted changes/);
  } finally {
    cleanup();
  }
});

test('clean tree, no leases → proceeds (null)', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null);
  } finally {
    cleanup();
  }
});

test('non-git dir with no leases → proceeds (dirty-tree half is inert)', () => {
  const { dir, cleanup } = tmp();
  try {
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null);
  } finally {
    cleanup();
  }
});

// ── leases ────────────────────────────────────────────────────────────────────

test('active (non-expired) lease → exit 2 and names the task', () => {
  const { dir, cleanup } = tmp();
  try {
    writeLease(dir, 'FORGE-42', leaseJson('2026-06-26T12:30:00.000Z', 'FORGE-42')); // 30 min in the future
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r);
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /active worker lease/);
    assert.match(r!.stderr, /FORGE-42/);
  } finally {
    cleanup();
  }
});

test('stale (expired past grace) lease → proceeds', () => {
  const { dir, cleanup } = tmp();
  try {
    // expired 30 min ago → well past the 5-min steal grace → stale, not alive.
    writeLease(dir, 'FORGE-1', leaseJson('2026-06-26T11:30:00.000Z'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null);
  } finally {
    cleanup();
  }
});

test('git repo without .forge gitignored: an expired lease does NOT block (.forge excluded from dirty)', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir); // no .gitignore block → .forge would otherwise show as untracked
    writeLease(dir, 'FORGE-1', leaseJson('2026-06-26T11:30:00.000Z')); // expired
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null, 'forge-managed .forge state must not register as a dirty tree');
  } finally {
    cleanup();
  }
});

test('an UNTRACKED .forge/settings.yaml (fresh repo) blocks', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    mkdirSync(join(dir, '.forge'), { recursive: true });
    writeFileSync(join(dir, '.forge', 'settings.yaml'), 'version: 1\n'); // uncommitted
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'an uncommitted settings.yaml must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('a TRACKED + modified .forge file (e.g. committed .version) blocks', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    mkdirSync(join(dir, '.forge'), { recursive: true });
    const versionPath = join(dir, '.forge', '.version');
    writeFileSync(versionPath, '0.4.4\n');
    execaSync('git', ['add', '.forge/.version'], { cwd: dir });
    execaSync('git', ['commit', '-q', '-m', 'pin'], { cwd: dir });
    writeFileSync(versionPath, '0.4.5-local-edit\n'); // tracked + uncommitted edit
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a tracked .forge file upgrade rewrites must block when dirty');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('malformed lease JSON → fail-closed (exit 2)', () => {
  const { dir, cleanup } = tmp();
  try {
    writeLease(dir, 'FORGE-1', '{ this is not json');
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r);
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('schema-invalid lease (valid JSON, missing fields) → fail-closed (exit 2)', () => {
  const { dir, cleanup } = tmp();
  try {
    writeLease(dir, 'FORGE-1', JSON.stringify({ version: 1, task_id: 'X' }));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r);
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

// ── fail-closed on non-ENOENT read errors (portable EISDIR / ENOTDIR injection) ──

test('unreadable lease (lease.json is a directory → EISDIR) → fail-closed (exit 2)', () => {
  const { dir, cleanup } = tmp();
  try {
    // lease.json as a DIRECTORY makes readFileSync throw EISDIR (not ENOENT).
    mkdirSync(join(dir, '.forge', 'orchestrator', 'tasks', 'FORGE-1', 'lease.json'), {
      recursive: true,
    });
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a non-ENOENT lease read error must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('unreadable tasks tree (tasks is a file → ENOTDIR) → fail-closed (exit 2)', () => {
  const { dir, cleanup } = tmp();
  try {
    // .forge/orchestrator/tasks as a FILE makes readdirSync throw ENOTDIR.
    mkdirSync(join(dir, '.forge', 'orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.forge', 'orchestrator', 'tasks'), 'not a dir');
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'an unreadable orchestrator tree must block');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /orchestrator task tree/);
  } finally {
    cleanup();
  }
});

// ── hostile lease files (symlink / oversized / symlinked task dir) ─────────────

test('symlinked lease.json → fail-closed (never followed)', () => {
  const { dir, cleanup } = tmp();
  try {
    // A valid but EXPIRED lease outside the tree; a symlink to it must still block
    // (lstat catches the symlink; we never follow it to read the benign content).
    const outside = join(dir, 'outside-lease.json');
    writeFileSync(outside, leaseJson('2026-06-26T11:30:00.000Z')); // expired
    const taskDir = join(dir, '.forge', 'orchestrator', 'tasks', 'FORGE-1');
    mkdirSync(taskDir, { recursive: true });
    symlinkSync(outside, join(taskDir, 'lease.json'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a symlinked lease must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('oversized lease.json → fail-closed (never read)', () => {
  const { dir, cleanup } = tmp();
  try {
    writeLease(dir, 'FORGE-1', 'x'.repeat(70 * 1024)); // > 64 KiB cap
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'an oversized lease must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('symlinked task directory → fail-closed', () => {
  const { dir, cleanup } = tmp();
  try {
    const tasksRoot = join(dir, '.forge', 'orchestrator', 'tasks');
    mkdirSync(tasksRoot, { recursive: true });
    const realTask = join(dir, 'real-task');
    mkdirSync(realTask);
    writeFileSync(join(realTask, 'lease.json'), leaseJson('2099-01-01T00:00:00.000Z'));
    symlinkSync(realTask, join(tasksRoot, 'FORGE-1'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a symlinked task dir must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

// ── hostile git environment / config cannot silence the dirty probe ────────────

test('status.showUntrackedFiles=no config does NOT hide an untracked file', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    execaSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: dir });
    writeFileSync(join(dir, 'foo.txt'), 'untracked');
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, '--untracked-files=all must override the repo config');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('repo-local core.fsmonitor command is NOT executed by the dirty probe', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    const sentinel = join(dir, 'fsmonitor-ran');
    const script = join(dir, 'fsmon.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
    chmodSync(script, 0o755);
    execaSync('git', ['config', 'core.fsmonitor', script], { cwd: dir });
    writeFileSync(join(dir, 'foo.txt'), 'untracked');

    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r && r.exitCode === 2, 'dirty tree still detected with fsmonitor disabled');
    assert.ok(!existsSync(sentinel), 'core.fsmonitor command must never run (-c core.fsmonitor=false)');
  } finally {
    cleanup();
  }
});

test('a global core.excludesFile (XDG) cannot hide an untracked file', () => {
  const { dir, cleanup } = tmp();
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevHome = process.env.HOME;
  try {
    gitInit(dir);
    const xdg = join(dir, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    writeFileSync(join(xdg, 'git', 'ignore'), '*\n'); // global ignore matching everything
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.HOME = dir; // neutralize the ~/.config fallback too
    writeFileSync(join(dir, 'foo.txt'), 'untracked');
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r && r.exitCode === 2, 'core.excludesFile=/dev/null must keep the file visible');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    cleanup();
  }
});

// ── worktree locality: a worktree sees the MAIN checkout's leases ──────────────

test('invoked from a linked worktree → sees an active lease in the MAIN checkout', () => {
  const { dir, cleanup } = tmp();
  try {
    const main = join(dir, 'main');
    mkdirSync(main);
    gitInit(main);
    writeFileSync(join(main, 'seed.txt'), 'seed');
    execaSync('git', ['add', '.'], { cwd: main });
    execaSync('git', ['commit', '-q', '-m', 'seed'], { cwd: main });
    // Active lease lives ONLY under the main checkout.
    writeLease(main, 'FORGE-9', leaseJson('2099-01-01T00:00:00.000Z', 'FORGE-9'));
    // Add a linked worktree and invoke the guard from inside it.
    const wt = join(dir, 'wt');
    execaSync('git', ['worktree', 'add', '-q', wt, '-b', 'feat/x'], { cwd: main });

    const r = checkInFlight({ cwd: wt, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'the worktree must see the main checkout lease');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /FORGE-9/);
  } finally {
    cleanup();
  }
});

test('heartbeat torn window (lease.json absent, *.tmp present) → blocks', () => {
  const { dir, cleanup } = tmp();
  try {
    // Simulate the orchestrator's atomic write mid-flight: no lease.json yet, but
    // a lease.json.<pid>.<n>.<hex>.tmp sibling exists (write-tmp → unlink → link).
    const taskDir = join(dir, '.forge', 'orchestrator', 'tasks', 'FORGE-1');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'lease.json.12345.0.deadbeefdeadbeef.tmp'), leaseJson('2099-01-01T00:00:00.000Z'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a lease mid-refresh must block, not be read as absent');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('a crashed writer leaving a stale EXPIRED *.tmp does not wedge upgrades', () => {
  const { dir, cleanup } = tmp();
  try {
    const taskDir = join(dir, '.forge', 'orchestrator', 'tasks', 'FORGE-1');
    mkdirSync(taskDir, { recursive: true });
    // No lease.json; a leftover temp whose written expires_at is long past.
    writeFileSync(
      join(taskDir, 'lease.json.999.0.cafebabecafebabe.tmp'),
      leaseJson('2026-06-26T11:30:00.000Z', 'FORGE-1'), // expired
    );
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null, 'an expired leftover temp must not block forever');
  } finally {
    cleanup();
  }
});

// ── symlinked orchestrator/tasks chain → fail-closed (no scan outside the tree) ─

test('symlinked tasks root → fail-closed (not followed outside the checkout)', () => {
  const { dir, cleanup } = tmp();
  try {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere); // an empty dir the symlink would point at
    const orchestrator = join(dir, '.forge', 'orchestrator');
    mkdirSync(orchestrator, { recursive: true });
    symlinkSync(elsewhere, join(orchestrator, 'tasks'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a symlinked tasks root must block');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /symlink or non-directory/);
  } finally {
    cleanup();
  }
});

// ── corrupt lease: payload task_id must match its directory ─────────────────────

test('lease task_id not matching its directory → fail-closed (exit 2)', () => {
  const { dir, cleanup } = tmp();
  try {
    // Directory FORGE-1 but the payload claims a DIFFERENT (and expired) task —
    // a tampered/corrupt lease must not be trusted as benign.
    writeLease(dir, 'FORGE-1', leaseJson('2026-06-26T11:30:00.000Z', 'DIFFERENT'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a task_id/dir mismatch must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

// ── GIT_TRACE* env cannot make the probe write a file ──────────────────────────

test('GIT_TRACE2_EVENT in the environment does not write during the probe', () => {
  const { dir, cleanup } = tmp();
  const prev = process.env.GIT_TRACE2_EVENT;
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'foo.txt'), 'untracked');
    const trace = join(dir, 'trace.log');
    process.env.GIT_TRACE2_EVENT = trace; // would normally make git write a trace file
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r && r.exitCode === 2, 'dirty tree still detected');
    assert.ok(!existsSync(trace), 'GIT_TRACE2_EVENT must be stripped from the probe env');
  } finally {
    if (prev === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = prev;
    cleanup();
  }
});

test('separate-git-dir checkout → active lease under the working tree still blocks', () => {
  const { dir, cleanup } = tmp();
  try {
    const wt = join(dir, 'wt');
    const gd = join(dir, 'gitdir');
    mkdirSync(wt);
    // Git dir lives OUTSIDE the working tree — dirname(git-common-dir) would point
    // at `gitdir`'s parent, not `wt`; worktree-list resolution must still find wt.
    execaSync('git', ['init', '--separate-git-dir', gd, '-q'], { cwd: wt });
    execaSync('git', ['config', 'user.email', 't@t.dev'], { cwd: wt });
    execaSync('git', ['config', 'user.name', 'T'], { cwd: wt });
    writeFileSync(join(wt, '.gitignore'), '.forge/\n');
    writeFileSync(join(wt, 'seed.txt'), 'seed');
    execaSync('git', ['add', '.'], { cwd: wt });
    execaSync('git', ['commit', '-q', '-m', 'seed'], { cwd: wt });
    // Active lease lives under the WORKING TREE's .forge.
    writeLease(wt, 'FORGE-7', leaseJson('2099-01-01T00:00:00.000Z', 'FORGE-7'));

    const r = checkInFlight({ cwd: wt, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'the lease under the working tree must be found');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /FORGE-7/);
  } finally {
    cleanup();
  }
});

test('repo-local core.worktree redirect → fail-closed (probes cannot be diverted)', () => {
  const { dir, cleanup } = tmp();
  try {
    const other = join(dir, 'other');
    mkdirSync(other);
    gitInit(dir);
    // Redirect git's working tree away from cwd; both status and show-toplevel
    // would otherwise report the (clean) `other` tree.
    execaSync('git', ['config', 'core.worktree', other], { cwd: dir });
    writeFileSync(join(dir, 'foo.txt'), 'dirty under the REAL cwd');
    writeLease(dir, 'FORGE-1', leaseJson('2099-01-01T00:00:00.000Z')); // active, under real cwd
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'a redirected work tree must fail closed');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /could not be verified/);
  } finally {
    cleanup();
  }
});

test('core.worktree redirect to an ANCESTOR of cwd → fail-closed', () => {
  const { dir, cleanup } = tmp();
  try {
    const sub = join(dir, 'repo');
    mkdirSync(sub);
    gitInit(sub);
    // Redirect the work tree to the PARENT of the repo — exact-match must reject
    // it (containment would have let this ancestor redirect through).
    execaSync('git', ['config', 'core.worktree', dir], { cwd: sub });
    writeFileSync(join(sub, 'foo.txt'), 'dirty under the real cwd');
    writeLease(sub, 'FORGE-1', leaseJson('2099-01-01T00:00:00.000Z'));
    const r = checkInFlight({ cwd: sub, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'an ancestor work-tree redirect must fail closed');
    assert.equal(r!.exitCode, 2);
    assert.match(r!.stderr, /could not be verified/);
  } finally {
    cleanup();
  }
});

test('task dir name violating the orchestrator id contract → fail-closed if it holds a lease', () => {
  const { dir, cleanup } = tmp();
  try {
    // `-bad` cannot be produced by the orchestrator (ids must start alphanumeric);
    // an EXPIRED lease there would slip through expiry logic, so it must block.
    writeLease(dir, '-bad', leaseJson('2026-06-26T11:30:00.000Z', '-bad'));
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r, 'an invalid task-dir name holding a lease must block');
    assert.equal(r!.exitCode, 2);
  } finally {
    cleanup();
  }
});

test('stray non-task directory with no lease → ignored (no false block)', () => {
  const { dir, cleanup } = tmp();
  try {
    // An invalid-named dir with NO lease file is a stray dir, not a corrupt lease.
    mkdirSync(join(dir, '.forge', 'orchestrator', 'tasks', '.cache'), { recursive: true });
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.equal(r, null, 'a stray dir without a lease must not block');
  } finally {
    cleanup();
  }
});

// ── no-mutation: the dirty probe must not rewrite .git/index ───────────────────

test('exit-2 dirty-tree probe does not rewrite .git/index', () => {
  const { dir, cleanup } = tmp();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'foo.txt'), 'staged then modified');
    execaSync('git', ['add', '.'], { cwd: dir }); // materialize .git/index
    writeFileSync(join(dir, 'foo.txt'), 'now dirty vs index'); // working tree dirty
    const indexPath = join(dir, '.git', 'index');
    assert.ok(existsSync(indexPath), 'precondition: .git/index exists');
    const before = readFileSync(indexPath);
    const r = checkInFlight({ cwd: dir, force: false, guardEnabled: true, now: NOW });
    assert.ok(r && r.exitCode === 2, 'precondition: the dirty tree blocks');
    const after = readFileSync(indexPath);
    assert.ok(before.equals(after), '.git/index must be byte-identical after the probe');
  } finally {
    cleanup();
  }
});
