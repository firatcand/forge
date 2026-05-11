import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const entry = resolve(repoRoot, 'src/bin/forge.ts');
const pkgPath = resolve(repoRoot, 'package.json');

type PackageJson = { version: string };
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
const expectedVersion = pkg.version;

async function runCli(args: readonly string[]) {
  return execa('node', ['--import', 'tsx', entry, ...args], {
    cwd: repoRoot,
    reject: false,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('forge --version prints package.json version and exits 0', async () => {
  const result = await runCli(['--version']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
  assert.equal(result.stderr.trim(), '');
});

test('forge -v is the short alias for --version', async () => {
  const result = await runCli(['-v']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
});

test('forge --help prints help to stdout and exits 0', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /forge .* foundations release/);
  assert.match(result.stdout, /--version/);
  assert.match(result.stdout, /--help/);
  assert.equal(result.stderr.trim(), '');
});

test('forge with no args prints help and exits 0', async () => {
  const result = await runCli([]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /foundations release/);
});

test('forge init exits 1 with a clear stderr message (fail loudly, no silent no-op)', async () => {
  const result = await runCli(['init']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /forge: 'init' is not yet available/);
  assert.match(result.stderr, new RegExp(`in ${expectedVersion.replace(/\./g, '\\.')}`));
  assert.match(result.stderr, /foundations release/);
  assert.match(result.stderr, /CHANGELOG\.md/);
});

test('forge orchestrate (another unknown command) also exits 1 with stderr', async () => {
  const result = await runCli(['orchestrate']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /forge: 'orchestrate' is not yet available/);
});
