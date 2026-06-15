import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSymlinkAt, isHardlinkAt } from '../../../src/core/symlink-guard.ts';

function mkScratch(): string {
  return mkdtempSync(join(tmpdir(), 'forge-symlink-guard-test-'));
}

// ============================================================================
// FORGE-209-(2) — isSymlinkAt fail-closed error posture
// ============================================================================

test('isSymlinkAt — absent path (ENOENT) returns false', () => {
  const dir = mkScratch();
  try {
    assert.equal(isSymlinkAt(join(dir, 'does-not-exist')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSymlinkAt — a real symlink returns true (incl. dangling)', () => {
  const dir = mkScratch();
  try {
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'x');
    const link = join(dir, 'link.txt');
    symlinkSync('real.txt', link);
    assert.equal(isSymlinkAt(link), true);

    const dangling = join(dir, 'dangling.txt');
    symlinkSync('nope.txt', dangling);
    assert.equal(isSymlinkAt(dangling), true, 'dangling link is still a link');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSymlinkAt — a regular file returns false', () => {
  const dir = mkScratch();
  try {
    const f = join(dir, 'plain.txt');
    writeFileSync(f, 'x');
    assert.equal(isSymlinkAt(f), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSymlinkAt — non-ENOENT lstat failure (ENOTDIR) THROWS, not swallowed to false', () => {
  const dir = mkScratch();
  try {
    // Deterministic, cross-platform ENOTDIR: lstat a path UNDER a regular FILE.
    const fileAsParent = join(dir, 'afile');
    writeFileSync(fileAsParent, 'x');
    const underFile = join(fileAsParent, 'x'); // parent is a file → ENOTDIR

    let caught: unknown;
    try {
      isSymlinkAt(underFile);
    } catch (err) {
      caught = err;
    }
    assert.notEqual(caught, undefined, 'expected isSymlinkAt to throw on ENOTDIR');
    assert.equal((caught as NodeJS.ErrnoException).code, 'ENOTDIR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// FORGE-209-(5) — isHardlinkAt
// ============================================================================

test('isHardlinkAt — absent path (ENOENT) returns false', () => {
  const dir = mkScratch();
  try {
    assert.equal(isHardlinkAt(join(dir, 'nope')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isHardlinkAt — single-link regular file returns false', () => {
  const dir = mkScratch();
  try {
    const f = join(dir, 'single.txt');
    writeFileSync(f, 'x');
    assert.equal(isHardlinkAt(f), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isHardlinkAt — a regular file with nlink>1 returns true', (t) => {
  const dir = mkScratch();
  try {
    const orig = join(dir, 'orig.txt');
    writeFileSync(orig, 'shared');
    const link = join(dir, 'hard.txt');
    try {
      linkSync(orig, link);
    } catch (err) {
      // Skip only on a genuine unsupported-FS error; a real bug must surface.
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(code)) {
        return t.skip('hard links unsupported on this filesystem');
      }
      throw err;
    }
    assert.equal(isHardlinkAt(orig), true);
    assert.equal(isHardlinkAt(link), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isHardlinkAt — a symlink is NOT counted as a hardlink', () => {
  const dir = mkScratch();
  try {
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'x');
    const link = join(dir, 'link.txt');
    symlinkSync('real.txt', link);
    // lstat sees the link itself (not a regular file) → false.
    assert.equal(isHardlinkAt(link), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isHardlinkAt — a directory returns false', () => {
  const dir = mkScratch();
  try {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    assert.equal(isHardlinkAt(sub), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isHardlinkAt — non-ENOENT lstat failure (ENOTDIR) THROWS', () => {
  const dir = mkScratch();
  try {
    const fileAsParent = join(dir, 'afile');
    writeFileSync(fileAsParent, 'x');
    const underFile = join(fileAsParent, 'x');
    let caught: unknown;
    try {
      isHardlinkAt(underFile);
    } catch (err) {
      caught = err;
    }
    assert.notEqual(caught, undefined, 'expected isHardlinkAt to throw on ENOTDIR');
    assert.equal((caught as NodeJS.ErrnoException).code, 'ENOTDIR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
