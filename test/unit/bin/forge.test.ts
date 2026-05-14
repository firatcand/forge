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

test('forge with no args fails loudly (Codex P1 — was the v0.2.1 install entry; silent exit 0 would regress consumer scripts)', async () => {
  const result = await runCli([]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /forge: no command specified/);
  assert.match(result.stderr, /install\/setup flow that was the v0\.2\.1/);
  assert.match(result.stderr, /forge --help/);
});

test('forge init is dispatched to runInit (fails loudly without answers in non-interactive)', async () => {
  // With FORGE_INIT_NONINTERACTIVE=1 and no FORGE_INIT_ANSWERS_JSON, runInit should
  // refuse to prompt and exit 1 with a clear errorBlock about the missing env var.
  // This proves the dispatcher fires (no "not yet available" fall-through).
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'forge-bin-init-'));
  mkdirSync(join(tmp, '.git'), { recursive: true });
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'consumer' }));
  const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
  const result = await execa(tsxBin, [entry, 'init'], {
    cwd: tmp,
    reject: false,
    env: { ...process.env, NODE_OPTIONS: '', FORGE_INIT_NONINTERACTIVE: '1' },
  });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stdout + result.stderr,
    /FORGE_INIT_NONINTERACTIVE=1 requires FORGE_INIT_ANSWERS_JSON/,
  );
});

test('forge orchestrate with no subcommand prints usage and exits 1', async () => {
  const result = await runCli(['orchestrate']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Usage: forge orchestrate/);
  assert.match(result.stderr, /questions\|answer\|status\|attach/);
});

test('forge orchestrate <unknown> rejects the subcommand and exits 1', async () => {
  const result = await runCli(['orchestrate', 'mystery']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown subcommand 'mystery'/);
});

test('forge orchestrate questions --open returns 0 against an empty forge dir', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'forge-bin-orch-'));
  const result = await runCli(['orchestrate', 'questions', '--open', '--forge-dir', join(tmp, '.forge')]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No open questions\./);
});
