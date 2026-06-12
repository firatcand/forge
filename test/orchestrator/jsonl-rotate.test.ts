import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  statSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rotateIfNeeded,
  STALE_LOCK_MS,
  LOG_ROTATE_MAX_BYTES_DEFAULT,
} from '../../src/orchestrator/jsonl-rotate.ts';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-rotate-test-'));
});
after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let n = 0;
function freshFile(content: string): string {
  const p = join(tmpDir, `log-${n++}.jsonl`);
  writeFileSync(p, content, 'utf8');
  return p;
}

test('schema default mirror equals 10 MiB', () => {
  assert.equal(LOG_ROTATE_MAX_BYTES_DEFAULT, 10_485_760);
});

test('rotateIfNeeded: no-op when file is absent', () => {
  const p = join(tmpDir, 'does-not-exist.jsonl');
  assert.equal(rotateIfNeeded(p, 10), false);
  assert.equal(existsSync(`${p}.1`), false);
});

test('rotateIfNeeded: no-op below threshold', () => {
  const p = freshFile('abc'); // 3 bytes
  assert.equal(rotateIfNeeded(p, 10), false);
  assert.equal(existsSync(`${p}.1`), false);
});

test('rotateIfNeeded: rotates at/over threshold (rename to .1, fresh start)', () => {
  const p = freshFile('0123456789'); // 10 bytes
  assert.equal(rotateIfNeeded(p, 10), true);
  assert.equal(existsSync(p), false, 'current renamed away');
  assert.equal(readFileSync(`${p}.1`, 'utf8'), '0123456789');
});

test('rotateIfNeeded: single generation — second rotation overwrites .1', () => {
  const p = freshFile('first-generation-data'); // > 10 bytes
  assert.equal(rotateIfNeeded(p, 10), true);
  writeFileSync(p, 'second-generation-data', 'utf8');
  assert.equal(rotateIfNeeded(p, 10), true);
  // .1 holds the SECOND generation now; the first is gone (single generation).
  assert.equal(readFileSync(`${p}.1`, 'utf8'), 'second-generation-data');
});

test('rotateIfNeeded: lock-or-skip — pre-created fresh lock → SKIP, no rotation, no data loss', () => {
  const p = freshFile('over-threshold-data');
  // Simulate a second rotator already holding the lock.
  const lock = `${p}.rotate.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  closeSync(fd);
  try {
    assert.equal(rotateIfNeeded(p, 10), false, 'contended → skip');
    assert.equal(existsSync(p), true, 'current untouched — no data loss');
    assert.equal(existsSync(`${p}.1`), false, 'no .1 created');
  } finally {
    rmSync(lock, { force: true });
  }
});

test('rotateIfNeeded: breaks a STALE lock (older than STALE_LOCK_MS) and rotates', () => {
  const p = freshFile('over-threshold-data');
  const lock = `${p}.rotate.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  closeSync(fd);
  // Backdate the lock mtime well beyond the stale window.
  const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(rotateIfNeeded(p, 10), true, 'stale lock broken → rotates');
  assert.equal(readFileSync(`${p}.1`, 'utf8'), 'over-threshold-data');
  // Lock removed in finally.
  assert.equal(existsSync(lock), false);
});

test('rotateIfNeeded: releases the lock in finally on success', () => {
  const p = freshFile('over-threshold-data');
  rotateIfNeeded(p, 10);
  assert.equal(existsSync(`${p}.rotate.lock`), false);
});

test('rotateIfNeeded: re-stat under lock — a near-empty file does not rotate', () => {
  // The cheap pre-check sees a big file; an injected fs whose under-lock stat
  // reports a small size must skip the rename (proves the double-check).
  const p = freshFile('over-threshold-data');
  let statCalls = 0;
  const realStat = statSync;
  const fsImpl = {
    statSync: ((path: string) => {
      // First stat = pre-check (big). Second stat (under lock, same path) = small.
      if (path === p) {
        statCalls++;
        if (statCalls >= 2) {
          return { size: 1, mtimeMs: Date.now() } as ReturnType<typeof statSync>;
        }
        return { size: 9999, mtimeMs: Date.now() } as ReturnType<typeof statSync>;
      }
      return realStat(path);
    }) as typeof statSync,
    renameSync: () => {
      throw new Error('rename must NOT be called when under-lock size is small');
    },
    openSync,
    closeSync,
    unlinkSync,
  };
  assert.equal(rotateIfNeeded(p, 10, fsImpl), false);
});
