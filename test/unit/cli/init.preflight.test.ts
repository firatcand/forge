import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPreflight } from '../../../src/cli/init/preflight.ts';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-preflight-'));
}

const noopExec: ExecaLike = async () => ({ exitCode: 0, stdout: '', stderr: '' });

test('preflight: refuses to run inside @firatcand/forge', async () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: '@firatcand/forge' }));
  const r = await runPreflight({ cwd, exec: noopExec });
  assert.equal(r.kind, 'refuse-framework');
});

test('preflight: passes on empty cwd (offers git init, accepts)', async () => {
  const cwd = tmp();
  let initCalled = false;
  const exec: ExecaLike = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'init') initCalled = true;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const r = await runPreflight({ cwd, exec, confirm: async () => true });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.gitInitialised, true);
  assert.equal(initCalled, true);
});

test('preflight: does not run git init when .git exists', async () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  let initCalled = false;
  const exec: ExecaLike = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'init') initCalled = true;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const r = await runPreflight({ cwd, exec, confirm: async () => false });
  assert.equal(r.kind, 'ok');
  assert.equal(initCalled, false);
});

test('preflight: when user declines git init, returns ok with gitInitialised:false', async () => {
  const cwd = tmp();
  const r = await runPreflight({
    cwd,
    exec: noopExec,
    confirm: async () => false,
  });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.gitInitialised, false);
});

test('preflight: existing settings.yaml + declined overwrite → cancelled', async () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'version: 1\n');
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  const r = await runPreflight({
    cwd,
    exec: noopExec,
    confirm: async () => false, // decline overwrite
  });
  assert.equal(r.kind, 'cancelled');
});

test('preflight: existing settings.yaml + accepted overwrite → ok with overwrite map', async () => {
  const cwd = tmp();
  mkdirSync(resolve(cwd, '.forge'), { recursive: true });
  writeFileSync(resolve(cwd, '.forge/settings.yaml'), 'version: 1\n');
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  const r = await runPreflight({
    cwd,
    exec: noopExec,
    confirm: async () => true,
  });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.overwrite['.forge/settings.yaml'], true);
  }
});

test('preflight: nonInteractive auto-declines overwrite, auto-accepts git init', async () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'CLAUDE.md'), 'existing user file\n');
  let initCalled = false;
  const exec: ExecaLike = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'init') initCalled = true;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const r = await runPreflight({ cwd, exec, nonInteractive: true });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.overwrite['CLAUDE.md'], false);
  }
  assert.equal(initCalled, true);
});

test('preflight: git init failure → cancelled', async () => {
  const cwd = tmp();
  const exec: ExecaLike = async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: bad' });
  const r = await runPreflight({ cwd, exec, confirm: async () => true });
  assert.equal(r.kind, 'cancelled');
});

test('preflight: malformed package.json (not framework) does not refuse', async () => {
  const cwd = tmp();
  writeFileSync(resolve(cwd, 'package.json'), '{not json');
  mkdirSync(resolve(cwd, '.git'), { recursive: true });
  const r = await runPreflight({ cwd, exec: noopExec });
  assert.equal(r.kind, 'ok');
});
