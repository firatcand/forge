import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureProjectContextStub } from '../../../../src/cli/upgrade/project-context.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-projctx-'));
}

test('ensureProjectContextStub: creates spec/CONTEXT.md when missing', () => {
  const cwd = tmp();
  try {
    const res = ensureProjectContextStub({ cwd, projectName: 'acme' });
    assert.equal(res.changed, true);
    assert.equal(res.notice, undefined);
    const stub = readFileSync(resolve(cwd, 'spec/CONTEXT.md'), 'utf8');
    assert.match(stub, /# acme — Project Context/);
    assert.match(stub, /\/ingest-spec/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ensureProjectContextStub: no-op when a populated spec/CONTEXT.md exists', () => {
  const cwd = tmp();
  try {
    mkdirSync(resolve(cwd, 'spec'), { recursive: true });
    const real = '# acme — Project Context\n\nReal /ingest-spec content.\n';
    writeFileSync(resolve(cwd, 'spec/CONTEXT.md'), real);
    const res = ensureProjectContextStub({ cwd, projectName: 'acme' });
    assert.equal(res.changed, false);
    assert.equal(readFileSync(resolve(cwd, 'spec/CONTEXT.md'), 'utf8'), real, 'never overwritten');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ensureProjectContextStub: dry-run reports changed but writes nothing', () => {
  const cwd = tmp();
  try {
    const res = ensureProjectContextStub({ cwd, projectName: 'acme', dryRun: true });
    assert.equal(res.changed, true);
    assert.ok(!existsSync(resolve(cwd, 'spec/CONTEXT.md')), 'dry-run wrote nothing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ensureProjectContextStub: skips (notice) when spec/ parent is a symlink — never writes through it', () => {
  const cwd = tmp();
  const outside = tmp();
  try {
    // spec/ is a symlink to a directory outside the working tree.
    symlinkSync(outside, resolve(cwd, 'spec'));
    const res = ensureProjectContextStub({ cwd, projectName: 'acme' });
    assert.equal(res.changed, false);
    assert.match(res.notice ?? '', /symlink/i);
    assert.ok(!existsSync(join(outside, 'CONTEXT.md')), 'nothing written outside the tree');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('ensureProjectContextStub: skips (notice) when spec/CONTEXT.md is a (dangling) symlink', () => {
  const cwd = tmp();
  try {
    mkdirSync(resolve(cwd, 'spec'), { recursive: true });
    symlinkSync(resolve(cwd, 'nonexistent-target'), resolve(cwd, 'spec/CONTEXT.md'));
    const res = ensureProjectContextStub({ cwd, projectName: 'acme' });
    assert.equal(res.changed, false);
    assert.match(res.notice ?? '', /symlink/i);
    assert.ok(!existsSync(resolve(cwd, 'nonexistent-target')), 'dangling target not written through');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
