import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../../../src/core/fs-atomic.ts';
import { FsWriteError } from '../../../src/core/errors.ts';

function mkScratch(): string {
  return mkdtempSync(join(tmpdir(), 'forge-fs-atomic-test-'));
}

test('writeAtomic — happy path writes file with expected contents', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'x.txt');
    writeAtomic(target, 'hello');
    assert.equal(readFileSync(target, 'utf8'), 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — creates intermediate directories', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'a', 'b', 'c', 'nested.txt');
    writeAtomic(target, 'deep');
    assert.equal(readFileSync(target, 'utf8'), 'deep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — overwrites existing file', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'overwrite.txt');
    writeFileSync(target, 'old');
    writeAtomic(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — leaves no tmp file behind on success', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'cleanup.txt');
    writeAtomic(target, 'data');
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((e) => e.includes('forge-tmp-'));
    assert.deepEqual(tmpFiles, [], `expected no tmp files, found: ${tmpFiles.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — cleans up tmp file when rename fails', () => {
  const dir = mkScratch();
  try {
    // Create a read-only directory inside; renameSync into it should fail
    const lockedDir = join(dir, 'locked');
    writeAtomic(join(lockedDir, 'sentinel.txt'), 'init'); // creates dir
    chmodSync(lockedDir, 0o500); // r-x only — writing into target should still work, but...

    // Better repro: rename to a directory path (target is a dir not file)
    const targetAsDir = join(dir, 'as-dir');
    writeAtomic(join(targetAsDir, 'inside.txt'), 'a'); // makes targetAsDir/inside.txt
    // Now try to writeAtomic to targetAsDir (which is a non-empty dir).
    // renameSync(tmp, targetAsDir) should fail with ENOTEMPTY or EISDIR.

    let threw = false;
    try {
      writeAtomic(targetAsDir, 'collide');
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'expected writeAtomic to throw on rename failure');

    // No leftover tmp files at `dir` level
    const entries = readdirSync(dir);
    const leftover = entries.filter((e) => e.includes('forge-tmp-'));
    assert.deepEqual(leftover, [], `expected no leftover tmp, found: ${leftover.join(',')}`);
  } finally {
    // restore perms so cleanup works
    try {
      chmodSync(join(dir, 'locked'), 0o700);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// FORGE-208 — default-deny symlink preflight (the primitive trio)
// ============================================================================

test('writeAtomic — refuses a symlinked target with typed FsWriteError; link and target untouched', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'real.md');
    writeFileSync(target, 'original target content');
    const link = join(dir, 'link.md');
    symlinkSync('real.md', link);

    let caught: unknown;
    try {
      writeAtomic(link, 'overwrite attempt');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof FsWriteError, `expected FsWriteError, got: ${String(caught)}`);
    assert.equal(caught.name, 'FsWriteError');
    assert.equal(caught.code, 'SYMLINK_TARGET_REFUSED');
    assert.equal(caught.details.path, link, 'details.path carries the refused path');
    assert.match(caught.message, /symbolic link/);

    // The link is still a link, still pointing at the same place.
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'link survives');
    assert.equal(readlinkSync(link), 'real.md', 'link target unchanged');
    // The target's bytes are untouched.
    assert.equal(readFileSync(target, 'utf8'), 'original target content');
    // No tmp leftovers.
    const leftover = readdirSync(dir).filter((e) => e.includes('forge-tmp-'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — refuses a dangling symlink target too (lstat sees the link itself)', () => {
  const dir = mkScratch();
  try {
    const link = join(dir, 'dangling.md');
    symlinkSync('does-not-exist.md', link);
    assert.throws(
      () => writeAtomic(link, 'x'),
      (err: unknown) => err instanceof FsWriteError && err.code === 'SYMLINK_TARGET_REFUSED',
    );
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'dangling link survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — plain file and absent target behavior unchanged by the preflight', () => {
  const dir = mkScratch();
  try {
    // Plain regular file: still overwritten atomically.
    const plain = join(dir, 'plain.txt');
    writeFileSync(plain, 'old');
    writeAtomic(plain, 'new');
    assert.equal(readFileSync(plain, 'utf8'), 'new');
    assert.equal(lstatSync(plain).isFile(), true);
    // Absent target: still created.
    const fresh = join(dir, 'fresh', 'created.txt');
    writeAtomic(fresh, 'made');
    assert.equal(readFileSync(fresh, 'utf8'), 'made');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomic — non-ENOENT lstat failure propagates (does not get swallowed as absent)', () => {
  const dir = mkScratch();
  try {
    // Make a PARENT path a regular file so lstat on a child path fails ENOTDIR.
    // Deterministic + cross-platform (no permissions/symlink dependence).
    const fileAsParent = join(dir, 'not-a-dir');
    writeFileSync(fileAsParent, 'x');
    const target = join(fileAsParent, 'child.txt'); // parent is a file → ENOTDIR

    let caught: unknown;
    try {
      writeAtomic(target, 'data');
    } catch (err) {
      caught = err;
    }

    assert.notEqual(caught, undefined, 'expected writeAtomic to throw');
    // The real preflight failure must surface — NOT be misclassified as a
    // symlink refusal and NOT be silently swallowed as "absent, fine to create".
    assert.equal(
      caught instanceof FsWriteError,
      false,
      'a non-ENOENT lstat failure must not be reported as FsWriteError/SYMLINK',
    );
    assert.equal((caught as NodeJS.ErrnoException).code, 'ENOTDIR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
