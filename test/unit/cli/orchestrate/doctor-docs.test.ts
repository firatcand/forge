import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateDoctor } from '../../../../src/cli/orchestrate/doctor.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

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

function lastEnvelope(buf: string[]): { ok: boolean; data?: Record<string, unknown> } {
  return JSON.parse(buf[buf.length - 1] ?? '');
}

function git(repo: string, argv: string[]): void {
  execFileSync('git', argv, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
}

function writeCommit(repo: string, rel: string, contents: string, msg: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
  git(repo, ['add', rel]);
  git(repo, ['commit', '-q', '-m', msg]);
}

// A git repo with a `main` base commit and a feature branch HEAD that changed a
// schema file (Contract trigger) with NO Contract doc → expected gap.
function makeRepoWithSchemaChange(): { repo: string; forgeDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'forge-docs-doctor-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  writeCommit(repo, 'README.md', '# base\n', 'base');
  git(repo, ['checkout', '-q', '-b', 'feat/x']);
  writeCommit(repo, 'src/schemas/thing.ts', 'export const x = 1;\n', 'change schema');
  return { repo, forgeDir: join(repo, '.forge') };
}

function writeMinimalSettings(forgeDir: string, extra = ''): void {
  mkdirSync(forgeDir, { recursive: true });
  const body = `version: 1
project:
  name: docs-coverage-fixture
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
${extra}`;
  writeFileSync(join(forgeDir, 'settings.yaml'), body, 'utf8');
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('doctor --scope docs reports the Contract gap + exit 0', async (t) => {
  const buf = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSchemaChange();
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir,
    json: true,
    repoRoot: repo,
    base: 'main',
  });
  assert.equal(result.exitCode, 0, 'docs scope is non-blocking → exit 0');
  const env = lastEnvelope(buf);
  assert.equal(env.ok, true);
  const dc = (env.data as Record<string, unknown>).docsCoverage as {
    required: string[];
    gaps: { category: string }[];
  };
  assert.deepEqual(dc.required, ['Contract']);
  assert.equal(dc.gaps.length, 1);
  assert.equal(dc.gaps[0]!.category, 'Contract');
});

test('doctor --scope docs is satisfied when a Contract doc is in the diff (no gap, exit 0)', async (t) => {
  const buf = captureStdout(t);
  const repo = mkdtempSync(join(tmpdir(), 'forge-docs-sat-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  writeCommit(repo, 'README.md', '# base\n', 'base');
  git(repo, ['checkout', '-q', '-b', 'feat/y']);
  // Change a schema AND update SPEC.md in the same diff.
  const sa = join(repo, 'src/schemas/thing.ts');
  mkdirSync(join(sa, '..'), { recursive: true });
  writeFileSync(sa, 'export const x = 1;\n', 'utf8');
  const spec = join(repo, 'spec/SPEC.md');
  mkdirSync(join(spec, '..'), { recursive: true });
  writeFileSync(spec, '# spec\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'schema + spec']);

  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir: join(repo, '.forge'),
    json: true,
    repoRoot: repo,
    base: 'main',
  });
  assert.equal(result.exitCode, 0);
  const dc = (lastEnvelope(buf).data as Record<string, unknown>).docsCoverage as {
    satisfied: string[];
    gaps: unknown[];
  };
  assert.deepEqual(dc.satisfied, ['Contract']);
  assert.deepEqual(dc.gaps, []);
});

test('doctor --scope docs on a non-git dir → warning + empty + exit 0', async (t) => {
  const buf = captureStdout(t);
  const repo = mkdtempSync(join(tmpdir(), 'forge-docs-nogit-'));
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir: join(repo, '.forge'),
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(buf);
  const data = env.data as Record<string, unknown>;
  const dc = data.docsCoverage as { required: string[]; gaps: unknown[] };
  assert.deepEqual(dc.required, []);
  assert.deepEqual(dc.gaps, []);
  assert.ok((data.warnings as string[]).some((w) => /not a git repository/i.test(w)));
});

test('doctor --scope docs with a bad --base → warning + empty + exit 0', async (t) => {
  const buf = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSchemaChange();
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir,
    json: true,
    repoRoot: repo,
    base: 'no-such-ref',
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(buf);
  const data = env.data as Record<string, unknown>;
  const dc = data.docsCoverage as { required: string[] };
  assert.deepEqual(dc.required, []);
  assert.ok((data.warnings as string[]).some((w) => /does not resolve/i.test(w)));
});

test('B1 — docs scope runs even when settings.doctor.spec_code_check_enabled = false', async (t) => {
  const buf = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSchemaChange();
  writeMinimalSettings(forgeDir, 'doctor:\n  spec_code_check_enabled: false\n');
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir,
    json: true,
    repoRoot: repo,
    base: 'main',
  });
  assert.equal(result.exitCode, 0);
  const dc = (lastEnvelope(buf).data as Record<string, unknown>).docsCoverage as { required: string[] };
  // spec-code disabled must NOT kill docs-coverage — the Contract gap still fires.
  assert.deepEqual(dc.required, ['Contract']);
});

test('B2 — missing settings.yaml → best-effort defaults, no crash', async (t) => {
  const buf = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSchemaChange();
  // No settings.yaml written under forgeDir.
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir,
    json: true,
    repoRoot: repo,
    base: 'main',
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(buf);
  const data = env.data as Record<string, unknown>;
  const dc = data.docsCoverage as { required: string[] };
  assert.deepEqual(dc.required, ['Contract']);
  assert.ok((data.warnings as string[]).some((w) => /settings\.yaml unavailable/i.test(w)));
});

test('docs-coverage disabled (settings.docs_coverage.enabled=false) → empty report + note, exit 0', async (t) => {
  const buf = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSchemaChange();
  writeMinimalSettings(forgeDir, 'docs_coverage:\n  enabled: false\n');
  const result = await runOrchestrateDoctor({
    scope: 'docs',
    forgeDir,
    json: true,
    repoRoot: repo,
    base: 'main',
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(buf);
  const data = env.data as Record<string, unknown>;
  const dc = data.docsCoverage as { required: string[]; gaps: unknown[] };
  assert.deepEqual(dc.required, []);
  assert.deepEqual(dc.gaps, []);
  assert.match(String(data.note), /disabled/i);
});
