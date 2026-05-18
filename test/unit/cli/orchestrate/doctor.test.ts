import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOrchestrateDoctor } from '../../../../src/cli/orchestrate/doctor.ts';
import type { DoctorArgs } from '../../../../src/schemas/cli-args.ts';

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return buf;
}

function makeRepoWithSpec(specBody: string, srcFiles: string[]): { repo: string; forgeDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'forge-doctor-'));
  mkdirSync(join(repo, 'spec'), { recursive: true });
  writeFileSync(join(repo, 'spec/SPEC.md'), specBody, 'utf8');
  if (srcFiles.length > 0) {
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (const rel of srcFiles) {
      const full = join(repo, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '// placeholder\n', 'utf8');
    }
  }
  return { repo, forgeDir: join(repo, '.forge') };
}

// Minimal valid settings.yaml body — every required SettingsSchema field is
// present; doctor/decisions/codex blocks rely on their `.default({})` to fill
// in. Adjust `doctorBlock` to override `spec_code_check_enabled`.
function writeSettingsYaml(forgeDir: string, doctorBlock: string): void {
  mkdirSync(forgeDir, { recursive: true });
  const body = `version: 1
project:
  name: doctor-test-fixture
tracker:
  type: github
  config:
    repo: firatcand/forge-fixture
secrets:
  manager: env_file
  env_file_path: ./.env.local
agents:
  max_concurrent: 2
  retry_attempts: 3
  retry_backoff_ms_max: 60000
  poll_interval_ms: 1000
  worktree_root: ./.forge/worktrees
  on_persistent_failure: notify
  primary_host_cli: claude
  review_host_cli: codex
${doctorBlock}`;
  writeFileSync(join(forgeDir, 'settings.yaml'), body, 'utf8');
}

test('doctor --scope spec-code exits 0 on clean repo', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/cli/init.ts` and `src/orchestrator/leases.ts` for details.\n',
    ['src/cli/init.ts', 'src/orchestrator/leases.ts'],
  );
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.deepEqual(env.data.drift, []);
});

test('doctor --scope spec-code exits 2 when SPEC mentions a missing src path', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/cli/init.ts` and `src/orchestrator/leases.ts` for details.\n',
    ['src/cli/init.ts'],
  );
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 2);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.ok(env.data.drift.length > 0);
  assert.equal(env.data.drift[0].target, 'src/orchestrator/leases.ts');
});

test('doctor --scope all returns identical envelope data to --scope spec-code', async (t) => {
  const stdoutA = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/cli/init.ts`.\n',
    ['src/cli/init.ts'],
  );
  const resultAll = await runOrchestrateDoctor({
    scope: 'all',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(resultAll.exitCode, 0);
  const envAll = JSON.parse(stdoutA[stdoutA.length - 1] ?? '');

  // Same input, --scope spec-code — must produce identical `data` envelope.
  const resultSpec = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(resultSpec.exitCode, 0);
  const envSpec = JSON.parse(stdoutA[stdoutA.length - 1] ?? '');

  assert.deepEqual(envAll.data, envSpec.data);
});

test('doctor --scope adr-drafts → INVALID_ARGS pre-parse with v0.5 + §21 pointers', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec('# spec\n', []);
  const result = await runOrchestrateDoctor({
    // Bypass TS narrowing — Zod-narrowed scope cannot hold the legacy string,
    // but the pre-parse layer rejects it at runtime before Zod sees it.
    scope: 'adr-drafts' as unknown as DoctorArgs['scope'],
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ARGS');
  assert.match(env.error.message, /v0\.5/, 'message must mention v0.5');
  assert.match(env.error.message, /§21/, 'message must reference SPEC §21');
});

test('doctor --scope apply-journal → INVALID_ARGS pre-parse with v0.5 + §21 pointers', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec('# spec\n', []);
  const result = await runOrchestrateDoctor({
    scope: 'apply-journal' as unknown as DoctorArgs['scope'],
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ARGS');
  assert.match(env.error.message, /v0\.5/);
  assert.match(env.error.message, /§21/);
});

test('doctor honors settings.doctor.spec_code_check_enabled: false → exit 0 empty report', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    // Body deliberately references a missing src path — without the flag this
    // would exit 2. The flag short-circuits before drift detection runs.
    'See `src/missing.ts` for details.\n',
    [],
  );
  writeSettingsYaml(forgeDir, 'doctor:\n  spec_code_check_enabled: false\n');
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.deepEqual(env.data.drift, []);
  assert.deepEqual(env.data.warnings, []);
});

test('doctor with missing settings.yaml falls back to defaults (check runs)', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/missing.ts` for details.\n',
    [],
  );
  // No settings.yaml written — loadSettings will throw; doctor must still run.
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 2, 'check ran (defaults applied) → drift exits 2');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.drift.length, 1);
  assert.equal(env.data.drift[0].target, 'src/missing.ts');
});

// AC3 gate — doctor on the forge worktree itself returns exit 0. This is the
// hard guard for "doctor on this very project returns exit 0 after Phase 2.5
// ships" — if any future PR re-introduces a stale `src/...` reference to
// SPEC.md or ORCHESTRATOR.md without creating the file, this test fires.
//
// Treat as a SPEC-hygiene gate, not a normal unit test: it depends on the
// hydrated spec/ tree present in this worktree (which mirrors main after
// /pickup-task step 5 + the §6 SPEC cleanup landed in this PR).
test('doctor on the forge worktree itself returns exit 0 (AC3 SPEC hygiene gate)', async (t) => {
  captureStdout(t);
  const here = dirname(fileURLToPath(import.meta.url));
  // here = test/unit/cli/orchestrate → 4 levels up = repo root.
  const repoRoot = resolve(here, '../../../..');
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir: join(repoRoot, '.forge'),
    json: true,
    repoRoot,
  });
  assert.equal(
    result.exitCode,
    0,
    'doctor on the forge worktree must return exit 0; if this fails, SPEC.md or ORCHESTRATOR.md mentions a `src/...ts` path that does not exist.',
  );
});
