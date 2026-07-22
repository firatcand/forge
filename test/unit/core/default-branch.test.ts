import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execaSync } from 'execa';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeBranchRef,
  resolveDefaultBranch,
} from '../../../src/core/default-branch.ts';
import { OrchestratorError } from '../../../src/core/errors.ts';

function git(cwd: string, ...args: string[]): string {
  const r = execaSync('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } });
  return String(r.stdout ?? '').trim();
}

// A local BARE remote makes ls-remote work hermetically (no network).
function makeRepoWithRemote(defaultBranch: string): { root: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-defbranch-'));
  const bare = join(root, 'origin.git');
  execaSync('git', ['init', '-q', '--bare', '-b', defaultBranch, bare]);
  const work = join(root, 'work');
  execaSync('git', ['init', '-q', '-b', defaultBranch, work]);
  writeFileSync(join(work, 'a.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', defaultBranch);
  return { root, work };
}

test('resolveDefaultBranch: ls-remote is the primary source (detects remote truth)', async () => {
  const { root, work } = makeRepoWithRemote('trunk');
  try {
    const info = await resolveDefaultBranch(work);
    assert.equal(info.default_branch, 'trunk');
    assert.equal(info.source, 'ls-remote');
    // The cache was refreshed at the MAIN repo root.
    const cached = JSON.parse(
      readFileSync(join(work, '.forge', 'orchestrator', 'global', 'repo.json'), 'utf8'),
    );
    assert.equal(cached.default_branch, 'trunk');
    assert.match(cached.remote_fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDefaultBranch: detects a same-remote default change even with a stale local origin/HEAD', async () => {
  const { root, work } = makeRepoWithRemote('main');
  try {
    // Local origin/HEAD says main…
    git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    // …but the REMOTE default moves to dev.
    const bare = join(root, 'origin.git');
    git(work, 'checkout', '-q', '-b', 'dev');
    git(work, 'push', '-q', 'origin', 'dev');
    execaSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/dev'], { cwd: bare });

    const info = await resolveDefaultBranch(work);
    assert.equal(info.default_branch, 'dev', 'remote truth wins over the stale local symbolic ref');
    assert.equal(info.source, 'ls-remote');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDefaultBranch: falls back to the local symbolic ref when the remote is unreachable', async () => {
  const { root, work } = makeRepoWithRemote('main');
  try {
    git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    // Break the remote URL (keeps `remote get-url` working for the fingerprint,
    // but ls-remote cannot reach it).
    git(work, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
    const info = await resolveDefaultBranch(work);
    assert.equal(info.default_branch, 'main');
    assert.equal(info.source, 'symbolic-ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDefaultBranch: cache is honored only with a matching fingerprint', async () => {
  const { root, work } = makeRepoWithRemote('main');
  try {
    await resolveDefaultBranch(work); // seeds the cache
    // Unreachable remote + no local origin/HEAD → cache is the last resort.
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    // Cache fingerprint no longer matches the (changed) origin URL → hard fail.
    await assert.rejects(
      () => resolveDefaultBranch(work),
      (err: unknown) => err instanceof OrchestratorError && err.code === 'IO_ERROR',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalizeBranchRef: canonicalizes remote-qualified forms and validates the grammar', async () => {
  const { root, work } = makeRepoWithRemote('main');
  try {
    assert.equal(await normalizeBranchRef(work, 'dev'), 'dev');
    assert.equal(await normalizeBranchRef(work, 'origin/dev'), 'dev');
    assert.equal(await normalizeBranchRef(work, 'refs/remotes/origin/dev'), 'dev');
    await assert.rejects(
      () => normalizeBranchRef(work, 'bad..name'),
      (err: unknown) => err instanceof OrchestratorError && err.code === 'INVALID_ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
