import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { tsxBin, forgeBinEntry as entry, repoRoot } from '../../helpers/spawn-tsx.ts';

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
  // Usage lists each verb on its own line; assert presence of representative verbs.
  for (const v of ['questions', 'answer', 'status', 'attach', 'gc', 'spec-diff']) {
    assert.match(result.stderr, new RegExp(`\\b${v}\\b`), `usage should mention ${v}`);
  }
});

test('forge orchestrate <unknown> rejects the verb and exits 1', async () => {
  const result = await runCli(['orchestrate', 'mystery']);
  assert.equal(result.exitCode, 1);
  // Verb-table dispatcher emits a stable error envelope code.
  assert.match(result.stderr, /UNKNOWN_VERB/);
  assert.match(result.stderr, /'mystery'/);
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

// FORGE-197 (Codex cross-review non-blocking #2): a status line runs on every
// host prompt repaint, so the `statusline` branch is dispatched in bin/forge.ts
// BEFORE loadForgeEnv and the drift/pin pre-hooks — any incidental stderr would
// corrupt the host's prompt. These bin-level cases pin that contract end-to-end
// (the unit test exercises runStatusline directly; only a spawned process proves
// the early dispatch keeps stderr clean).
test('forge statusline: outside a forge repo → exit 0, no stdout, no stderr', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'forge-bin-statusline-'));
  // Use the resolved tsxBin (absolute) — `node --import tsx` would resolve tsx
  // relative to the temp cwd, which has no node_modules.
  const result = await execa(tsxBin, [entry, 'statusline'], {
    cwd: tmp,
    reject: false,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('forge statusline: forge repo with a parked task → `◆ N to answer`, exit 0, NO stderr noise (early dispatch beats drift/env hooks)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'forge-bin-statusline-'));
  // A .forge/.env that loadForgeEnv would read on any OTHER command — proving
  // statusline returns before loadForgeEnv ever runs.
  mkdirSync(join(tmp, '.forge'), { recursive: true });
  writeFileSync(join(tmp, '.forge', '.env'), 'FORGE_FAKE=1\n');
  const statePath = join(tmp, '.forge', 'orchestrator', 'tasks', 'T-1', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      task_id: 'T-1',
      state: 'blocked_on_question',
      state_version: 0,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
    }),
  );
  const result = await execa(tsxBin, [entry, 'statusline'], {
    cwd: tmp,
    reject: false,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'forge ◆ 1 to answer');
  assert.equal(result.stderr, '');
});
