import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '../../../src/core/fs-atomic.ts';

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
