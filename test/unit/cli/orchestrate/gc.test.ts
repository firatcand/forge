import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOrchestrateGc } from '../../../../src/cli/orchestrate/gc.ts';

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-gc-'));
}

function writeLegacy(forgeDir: string, kind: 'questions' | 'answers', file: string, body: string): void {
  const dir = join(forgeDir, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}

function captureStreams(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on('data', (c: Buffer) => outChunks.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

const fixedNow = (): Date => new Date('2026-05-15T01:23:45.000Z');

test('orchestrate gc on a clean tree exits 0 with no migrations', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    const result = runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 0);
    assert.match(out(), /No legacy files to migrate\./);
    assert.equal(err(), '');
    // No archive directory should be created if there's nothing to archive.
    assert.equal(existsSync(join(forgeDir, 'orchestrator', 'legacy')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc moves legacy questions and answers to a timestamped archive', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{"hello":"q1"}');
    writeLegacy(forgeDir, 'questions', 'q2.json', '{"hello":"q2"}');
    writeLegacy(forgeDir, 'answers', 'q1.json', '{"hello":"a1"}');
    const result = runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 3);
    assert.match(out(), /Migrated 3 legacy file/);
    // Archive root exists with the timestamp-derived session.
    const sessions = readdirSync(join(forgeDir, 'orchestrator', 'legacy'));
    assert.equal(sessions.length, 1);
    const archiveBase = join(forgeDir, 'orchestrator', 'legacy', sessions[0]!);
    // All three files copied with content intact.
    assert.equal(readFileSync(join(archiveBase, 'questions', 'q1.json'), 'utf8'), '{"hello":"q1"}');
    assert.equal(readFileSync(join(archiveBase, 'questions', 'q2.json'), 'utf8'), '{"hello":"q2"}');
    assert.equal(readFileSync(join(archiveBase, 'answers', 'q1.json'), 'utf8'), '{"hello":"a1"}');
    // Originals removed.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json')), false);
    assert.equal(existsSync(join(forgeDir, 'questions', 'q2.json')), false);
    assert.equal(existsSync(join(forgeDir, 'answers', 'q1.json')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc leaves .tmp residue alone — only canonical .json files migrate', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    writeLegacy(forgeDir, 'questions', 'q1.json.123.4.abc.tmp', 'aborted-write-residue');
    const result = runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 1);
    // The .tmp residue stays where it was.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json.123.4.abc.tmp')), true);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc --dry-run prints the plan without modifying disk', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    writeLegacy(forgeDir, 'answers', 'q1.json', '{}');
    const result = runOrchestrateGc({
      forgeDir,
      dryRun: true,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 2);
    assert.match(out(), /gc plan/);
    assert.match(out(), /2 file\(s\) would be migrated/);
    // Originals remain — dry-run is read-only.
    assert.equal(existsSync(join(forgeDir, 'questions', 'q1.json')), true);
    assert.equal(existsSync(join(forgeDir, 'answers', 'q1.json')), true);
    // No archive directory created.
    assert.equal(existsSync(join(forgeDir, 'orchestrator', 'legacy')), false);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// Codex review T-codex-2: a pathological subdirectory whose name ends in .json
// must NOT be planned as a file. Without isFile() filtering, linkSync would
// fail mid-pass and abort the whole gc, leaving valid legacy files unmigrated.
test('orchestrate gc skips subdirectories whose name ends in .json (Codex review)', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    // Real legacy file that should migrate.
    writeLegacy(forgeDir, 'questions', 'q1.json', '{"hello":"q1"}');
    // Pathological subdirectory with a .json name. Without dirent filtering
    // this would be treated as a candidate, link() would fail with EISDIR or
    // EPERM, and the gc would abort before migrating q1.json.
    mkdirSync(join(forgeDir, 'questions', 'pathological.json'), {
      recursive: true,
    });
    const result = runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.migrated.length, 1);
    assert.match(out(), /Migrated 1 legacy file/);
    // The real file landed in the archive.
    const sessions = readdirSync(join(forgeDir, 'orchestrator', 'legacy'));
    assert.equal(sessions.length, 1);
    const archiveBase = join(forgeDir, 'orchestrator', 'legacy', sessions[0]!);
    assert.equal(
      readFileSync(join(archiveBase, 'questions', 'q1.json'), 'utf8'),
      '{"hello":"q1"}',
    );
    // The pathological directory is left in place.
    assert.equal(existsSync(join(forgeDir, 'questions', 'pathological.json')), true);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate gc is idempotent — re-running after a successful migration is a no-op', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr } = captureStreams();
  try {
    writeLegacy(forgeDir, 'questions', 'q1.json', '{}');
    const first = runOrchestrateGc({ forgeDir, stdout, stderr, now: fixedNow });
    assert.equal(first.exitCode, 0);
    assert.equal(first.migrated.length, 1);
    // Second run sees no source files; reports 0 migrations.
    const { stdout: s2, stderr: e2, out: out2 } = captureStreams();
    const second = runOrchestrateGc({ forgeDir, stdout: s2, stderr: e2, now: fixedNow });
    assert.equal(second.exitCode, 0);
    assert.equal(second.migrated.length, 0);
    assert.match(out2(), /No legacy files to migrate/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
