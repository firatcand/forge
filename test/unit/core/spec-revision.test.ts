import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSpecRevision,
  SpecRevisionError,
} from '../../../src/core/spec-revision.ts';

function mkScratch(): string {
  return mkdtempSync(join(tmpdir(), 'forge-spec-rev-test-'));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitInit(cwd: string): void {
  git(cwd, 'init', '--quiet', '--initial-branch=main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

test('computeSpecRevision — tracked + committed SPEC.md returns 40-char git sha', () => {
  const dir = mkScratch();
  try {
    gitInit(dir);
    mkdirSync(join(dir, 'spec'));
    writeFileSync(join(dir, 'spec', 'SPEC.md'), '# spec v1\n');
    git(dir, 'add', 'spec/SPEC.md');
    git(dir, 'commit', '-q', '-m', 'add spec');
    const expectedSha = git(dir, 'rev-parse', 'HEAD');

    const rev = computeSpecRevision(dir);
    assert.equal(rev.length, 40);
    assert.equal(rev, expectedSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSpecRevision — git sha reflects LAST commit touching SPEC.md, not HEAD', () => {
  const dir = mkScratch();
  try {
    gitInit(dir);
    mkdirSync(join(dir, 'spec'));
    writeFileSync(join(dir, 'spec', 'SPEC.md'), '# spec v1\n');
    git(dir, 'add', 'spec/SPEC.md');
    git(dir, 'commit', '-q', '-m', 'add spec');
    const specSha = git(dir, 'rev-parse', 'HEAD');

    // Commit an unrelated file — HEAD advances but spec/SPEC.md is unchanged.
    writeFileSync(join(dir, 'other.txt'), 'x\n');
    git(dir, 'add', 'other.txt');
    git(dir, 'commit', '-q', '-m', 'unrelated');
    const headSha = git(dir, 'rev-parse', 'HEAD');

    assert.notEqual(specSha, headSha);
    assert.equal(computeSpecRevision(dir), specSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSpecRevision — untracked SPEC.md falls back to content digest', () => {
  const dir = mkScratch();
  try {
    gitInit(dir);
    mkdirSync(join(dir, 'spec'));
    writeFileSync(join(dir, 'spec', 'SPEC.md'), '# untracked\n');
    // Not staged, not committed — git log returns empty.

    const rev = computeSpecRevision(dir);
    assert.equal(rev.length, 40);
    // sha256("# untracked\n") first 40 hex chars — verify it isn't a git sha
    // by hashing twice and ensuring stability + determinism.
    assert.equal(computeSpecRevision(dir), rev);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSpecRevision — non-git directory falls back to content digest', () => {
  const dir = mkScratch();
  try {
    mkdirSync(join(dir, 'spec'));
    writeFileSync(join(dir, 'spec', 'SPEC.md'), '# no git here\n');

    const rev = computeSpecRevision(dir);
    assert.equal(rev.length, 40);
    assert.equal(computeSpecRevision(dir), rev);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeSpecRevision — content digest is content-dependent', () => {
  const a = mkScratch();
  const b = mkScratch();
  try {
    mkdirSync(join(a, 'spec'));
    mkdirSync(join(b, 'spec'));
    writeFileSync(join(a, 'spec', 'SPEC.md'), '# alpha\n');
    writeFileSync(join(b, 'spec', 'SPEC.md'), '# beta\n');
    assert.notEqual(computeSpecRevision(a), computeSpecRevision(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('computeSpecRevision — missing SPEC.md throws SpecRevisionError', () => {
  const dir = mkScratch();
  try {
    gitInit(dir);
    assert.throws(() => computeSpecRevision(dir), SpecRevisionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
