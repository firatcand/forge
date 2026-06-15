import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLoomDbPath } from '../../../src/memory/paths.ts';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

test('resolveLoomDbPath returns <git-root>/.forge/loom.db and is stable from a subdir', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'loom-paths-')));
  gitInit(root);
  const sub = join(root, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  try {
    const fromRoot = resolveLoomDbPath(root);
    const fromSub = resolveLoomDbPath(sub);
    assert.equal(fromRoot, join(root, '.forge', 'loom.db'));
    // A subdir resolves to the SAME db (under the git-common-dir root).
    assert.equal(fromSub, fromRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLoomDbPath falls back to <cwd>/.forge/loom.db outside a git repo', () => {
  // A temp dir with no .git anywhere up the chain that git would honor — git
  // rev-parse fails, so we fall back to cwd.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loom-nogit-')));
  try {
    const p = resolveLoomDbPath(dir);
    // Either fallback (no git) OR an ambient parent repo; both must end in the
    // canonical rel path. We assert the rel suffix to stay robust on CI.
    assert.match(p, /\.forge[/\\]loom\.db$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
