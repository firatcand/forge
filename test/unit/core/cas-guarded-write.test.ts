import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  casGuardedWrite,
  casMarkerPath,
  cleanupCompletedCasMarkers,
  listCasMarkers,
  writeAtomicDurable,
  type CasGuardedWriteOptions,
} from '../../../src/core/fs-atomic.ts';
import { CasError, FsWriteError } from '../../../src/core/errors.ts';

function mkScratch(): string {
  return mkdtempSync(join(tmpdir(), 'forge-cas-test-'));
}

const HOLDER = { run_id: 'run-1', claim_id: 'claim-1', generation: 1 };

function readVersion(raw: string): number {
  const v = (JSON.parse(raw) as { v: number }).v;
  if (typeof v !== 'number') throw new Error('no version field');
  return v;
}

function baseOpts(filePath: string, expectedVersion: number | 'create'): CasGuardedWriteOptions {
  return {
    filePath,
    expectedVersion,
    holder: HOLDER,
    readVersion,
    buildContent: (raw) => {
      const cur = raw === null ? 0 : readVersion(raw);
      return JSON.stringify({ v: raw === null ? 0 : cur + 1 });
    },
  };
}

test('writeAtomicDurable — happy path writes durable content', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'x.json');
    writeAtomicDurable(target, '{"v":1}');
    assert.equal(readFileSync(target, 'utf8'), '{"v":1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAtomicDurable — refuses symlink target', () => {
  const dir = mkScratch();
  try {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(real, '{}');
    symlinkSync(real, link);
    assert.throws(
      () => writeAtomicDurable(link, '{"v":1}'),
      (err: unknown) => err instanceof FsWriteError && err.code === 'SYMLINK_TARGET_REFUSED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — create path writes initial content and cleans its marker', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    casGuardedWrite(baseOpts(target, 'create'));
    assert.equal(readVersion(readFileSync(target, 'utf8')), 0);
    // Marker transition completed (file exists) → opportunistic cleanup removed it.
    assert.equal(existsSync(casMarkerPath(target, 'create')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — create over existing file is a version_conflict', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":3}');
    assert.throws(
      () => casGuardedWrite(baseOpts(target, 'create')),
      (err: unknown) => err instanceof CasError && err.code === 'version_conflict',
    );
    assert.equal(readVersion(readFileSync(target, 'utf8')), 3);
    assert.equal(existsSync(casMarkerPath(target, 'create')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — numeric transition advances the version and cleans markers', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":4}');
    casGuardedWrite(baseOpts(target, 4));
    assert.equal(readVersion(readFileSync(target, 'utf8')), 5);
    assert.equal(existsSync(casMarkerPath(target, 4)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — version 0 is a real version distinct from create (R6 CRIT-1 regression)', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    // Creation lands version 0 via the create domain…
    casGuardedWrite(baseOpts(target, 'create'));
    assert.equal(readVersion(readFileSync(target, 'utf8')), 0);
    // …and the first real transition acquires `.cas-0` without deadlocking.
    casGuardedWrite(baseOpts(target, 0));
    assert.equal(readVersion(readFileSync(target, 'utf8')), 1);
    assert.equal(existsSync(casMarkerPath(target, 0)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — wrong expected version fails fast with version_conflict', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":7}');
    assert.throws(
      () => casGuardedWrite(baseOpts(target, 5)),
      (err: unknown) => err instanceof CasError && err.code === 'version_conflict',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — held marker yields cas_conflict and is not stolen', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":2}');
    const marker = casMarkerPath(target, 2);
    writeFileSync(marker, JSON.stringify({ pid: 99999, run_id: 'other', token: 't' }));
    assert.throws(
      () => casGuardedWrite(baseOpts(target, 2)),
      (err: unknown) => err instanceof CasError && err.code === 'cas_conflict',
    );
    // The loser must not remove the holder's marker or touch the file.
    assert.equal(existsSync(marker), true);
    assert.equal(readVersion(readFileSync(target, 'utf8')), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — post-acquire revalidation aborts a stale pre-reader (R5 CRIT-1 regression)', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    let precheckDone = false;
    let mutated = false;
    const opts: CasGuardedWriteOptions = {
      ...baseOpts(target, 1),
      // Simulate a concurrent committer landing BETWEEN the pre-check read and
      // marker acquisition: the first readVersion call (pre-check) reports the
      // expected version, then the file advances underneath us.
      readVersion: (raw) => {
        const v = readVersion(raw);
        if (!precheckDone) {
          precheckDone = true;
          writeFileSync(target, '{"v":2}');
          return v;
        }
        return v;
      },
      buildContent: () => {
        mutated = true;
        return '{"v":999}';
      },
    };
    assert.throws(
      () => casGuardedWrite(opts),
      (err: unknown) => err instanceof CasError && err.code === 'version_conflict',
    );
    // The stale writer never mutated, never wrote, and released its marker.
    assert.equal(mutated, false);
    assert.equal(readVersion(readFileSync(target, 'utf8')), 2);
    assert.equal(existsSync(casMarkerPath(target, 1)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — fence rejection releases the marker and writes nothing', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    assert.throws(
      () =>
        casGuardedWrite({
          ...baseOpts(target, 1),
          fence: () => {
            throw new CasError('lease_lost', 'lease expired');
          },
        }),
      (err: unknown) => err instanceof CasError && err.code === 'lease_lost',
    );
    assert.equal(readVersion(readFileSync(target, 'utf8')), 1);
    assert.equal(existsSync(casMarkerPath(target, 1)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — thrown buildContent exception releases the marker (exception-safe cleanup)', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    assert.throws(
      () =>
        casGuardedWrite({
          ...baseOpts(target, 1),
          buildContent: () => {
            throw new Error('mutator exploded');
          },
        }),
      (err: unknown) => err instanceof CasError && err.code === 'io',
    );
    assert.equal(readVersion(readFileSync(target, 'utf8')), 1);
    assert.equal(existsSync(casMarkerPath(target, 1)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — proven pre-placement failure releases the marker (retriable)', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    const real = join(dir, 'elsewhere.json');
    writeFileSync(target, '{"v":1}');
    writeFileSync(real, '{}');
    assert.throws(
      () =>
        casGuardedWrite({
          ...baseOpts(target, 1),
          buildContent: (raw) => {
            // Swap the target for a symlink after the post-acquire read: the
            // durable writer's preflight refuses it BEFORE any byte is written
            // — a proven pre-placement failure, so the marker is released.
            const cur = raw === null ? 0 : readVersion(raw);
            unlinkSync(target);
            symlinkSync(real, target);
            return JSON.stringify({ v: cur + 1 });
          },
        }),
      (err: unknown) =>
        err instanceof CasError && err.code === 'io' && err.details.retriable === true,
    );
    assert.equal(existsSync(casMarkerPath(target, 1)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — ambiguous placement failure retains the marker', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    assert.throws(
      () =>
        casGuardedWrite({
          ...baseOpts(target, 1),
          buildContent: (raw) => {
            // Replace the target with a DIRECTORY after the post-acquire read:
            // the temp write succeeds but rename(file → dir) fails — an
            // ambiguous placement failure, so the marker must be retained.
            const cur = raw === null ? 0 : readVersion(raw);
            unlinkSync(target);
            mkdirSync(target);
            return JSON.stringify({ v: cur + 1 });
          },
        }),
      (err: unknown) =>
        err instanceof CasError && err.code === 'io' && err.details.retriable === false,
    );
    assert.equal(existsSync(casMarkerPath(target, 1)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — symlinked guarded file is refused', () => {
  const dir = mkScratch();
  try {
    const real = join(dir, 'real.json');
    const link = join(dir, 'state.json');
    writeFileSync(real, '{"v":1}');
    symlinkSync(real, link);
    assert.throws(
      () => casGuardedWrite(baseOpts(link, 1)),
      (err: unknown) => err instanceof CasError && err.code === 'io',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — oversize guarded file is refused', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    assert.throws(
      () => casGuardedWrite({ ...baseOpts(target, 1), maxBytes: 3 }),
      (err: unknown) => err instanceof CasError && err.code === 'io',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listCasMarkers / cleanupCompletedCasMarkers — completed vs incomplete classification', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":5}');
    // Completed: numeric marker below the current version.
    writeFileSync(casMarkerPath(target, 3), JSON.stringify({ pid: 1, token: 'a' }));
    // Incomplete: numeric marker AT the current version — an in-flight 5→6.
    writeFileSync(casMarkerPath(target, 5), JSON.stringify({ pid: 2, token: 'b' }));
    // Completed: create marker while the file exists.
    writeFileSync(casMarkerPath(target, 'create'), JSON.stringify({ pid: 3, token: 'c' }));
    // Corrupt marker content parses to null but still classifies.
    writeFileSync(casMarkerPath(target, 2), 'not-json');

    const infos = listCasMarkers(target, 5);
    const byDomain = new Map(infos.map((i) => [String(i.domain), i]));
    assert.equal(byDomain.get('3')?.completed, true);
    assert.equal(byDomain.get('5')?.completed, false);
    assert.equal(byDomain.get('create')?.completed, true);
    assert.equal(byDomain.get('2')?.completed, true);
    assert.equal(byDomain.get('2')?.content, null);

    cleanupCompletedCasMarkers(target, 5);
    assert.equal(existsSync(casMarkerPath(target, 3)), false);
    assert.equal(existsSync(casMarkerPath(target, 2)), false);
    assert.equal(existsSync(casMarkerPath(target, 'create')), false);
    // The incomplete marker is NEVER auto-removed.
    assert.equal(existsSync(casMarkerPath(target, 5)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupCompletedCasMarkers — create marker with absent file is incomplete and retained', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(casMarkerPath(target, 'create'), JSON.stringify({ pid: 1, token: 'a' }));
    cleanupCompletedCasMarkers(target, null);
    assert.equal(existsSync(casMarkerPath(target, 'create')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casGuardedWrite — paused holder that passed revalidation may legally land later', () => {
  const dir = mkScratch();
  try {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"v":1}');
    // Simulate the "paused writer" by performing the same protocol steps: the
    // marker is held, nothing else can commit 1→2 (they get cas_conflict), so
    // when the holder finally lands its post-acquire read is still current.
    const marker = casMarkerPath(target, 1);
    writeFileSync(marker, JSON.stringify({ pid: process.pid, run_id: 'r', token: 't' }));
    assert.throws(
      () => casGuardedWrite(baseOpts(target, 1)),
      (err: unknown) => err instanceof CasError && err.code === 'cas_conflict',
    );
    // File untouched while the marker is held.
    assert.equal(readVersion(readFileSync(target, 'utf8')), 1);
    // The holder "resumes": its write is still the unique legal commit.
    unlinkSync(marker); // holder's own commit path releases via completion
    casGuardedWrite(baseOpts(target, 1));
    assert.equal(readVersion(readFileSync(target, 'utf8')), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
