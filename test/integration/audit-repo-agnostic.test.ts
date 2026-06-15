// FORGE-182 (/audit P4) — proves the /audit feature is genuinely REPO-AGNOSTIC
// and READ-ONLY against a NON-forge fixture (a Python/Go layout with NO `src/`,
// its own .forge/settings.yaml + CRITICAL.md). Asserts: scope auto-discovers
// without assuming `src/`; protected globs come ONLY from the fixture's
// CRITICAL.md; rendered prompts + work-order leak NO forge-specific paths;
// `collect` is read-only (git clean except .forge/audits); verify-unset surfaces
// the unverifiable-findings warning. Plus a CLI smoke for `audit --help`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuditPlan, runAuditCollect } from '../../src/cli/orchestrate/audit.ts';
import { tsxBin, forgeBinEntry, repoRoot } from '../helpers/spawn-tsx.ts';

// Forge-specific path tokens that must NEVER leak into a non-forge repo's audit
// output (the shipped feature carries zero hardcoded forge paths — P1 guard test
// proves the SOURCE; this proves the RENDERED output for a foreign repo).
const FORGE_LEAK_TOKENS = [
  'src/orchestrator',
  'src/trackers',
  'src/harnesses',
  'forge.cjs',
  'leases.ts',
  'classifyOverlap',
  '.forge/worktrees',
];

function assertNoForgeLeak(text: string, where: string): void {
  for (const tok of FORGE_LEAK_TOKENS) {
    assert.ok(!text.includes(tok), `${where} must not leak the forge-specific token "${tok}"`);
  }
}

// A NON-forge fixture: a Python/Go project with NO `src/` dir, its own forge
// config + CRITICAL.md. (verify is INTENTIONALLY unset to exercise the
// unverifiable-findings warning.)
function makeNonForgeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'audit-nonforge-'));
  const w = (rel: string, body = 'x\n') => {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };
  // A python + go layout — deliberately NO `src/`.
  w('app/main.py', 'def main():\n    pass\n');
  w('app/util.py');
  w('app/legacy_helper.py');
  w('lib/parser.go', 'package lib\n');
  w('lib/parser_test.go', 'package lib\n');
  w('cmd/cli.go', 'package main\n');
  w('go.mod', 'module example.com/foo\n');
  w('pyproject.toml', '[project]\nname = "foo"\n');
  // The fixture's OWN protected set — fixture paths only, zero forge paths.
  w('CRITICAL.md', '# Critical paths\n\n- `app/payments.py`\n- lib/crypto/**\n');
  // Its own forge config (github tracker; NO verify block on purpose).
  w(
    '.forge/settings.yaml',
    ['version: 1', 'project:', '  name: nonforge', 'tracker:', '  type: github', '  config:', '    repo: acme/foo', 'secrets:', '  manager: env_file', ''].join('\n'),
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return repo;
}

function capture(t: { after: (fn: () => void) => void }): { text(): string; json(): unknown } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return {
    text: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('').trim().split('\n').pop()!),
  };
}

function porcelain(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
}

test('audit plan — repo-agnostic: auto-discovers a non-`src/` layout, no forge leak', (t) => {
  const repo = makeNonForgeRepo();
  try {
    const cap = capture(t);
    runAuditPlan({ forgeDir: join(repo, '.forge'), json: true });
    const env = cap.json() as { ok: boolean; data: { scope: string[]; protected_globs: string[]; prompts: { prompt: string }[] } };
    assert.equal(env.ok, true);
    // Scope auto-discovered from the real tree — app/ + lib/, NEVER an invented src/.
    assert.ok(env.data.scope.some((g) => g.startsWith('app')), `expected app in scope, got ${JSON.stringify(env.data.scope)}`);
    assert.ok(!env.data.scope.some((g) => g.startsWith('src')), 'must not invent src/');
    // Protected globs come ONLY from the fixture's CRITICAL.md — EQUALITY (not
    // just inclusion) proves the JS-flavored agents.preflight_globs default no
    // longer leaks into a non-forge repo's protected set.
    assert.deepEqual([...env.data.protected_globs].sort(), ['app/payments.py', 'lib/crypto/**']);
    // The rendered prompts must not leak any forge-specific path.
    for (const p of env.data.prompts) assertNoForgeLeak(p.prompt, 'rendered prompt');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('audit collect — READ-ONLY on a non-forge repo (git clean except .forge/audits), verify-unset warns, no forge leak', (t) => {
  const repo = makeNonForgeRepo();
  try {
    // Findings reference the fixture's own files (in-scope, non-protected).
    const findings = [
      { file: 'app/legacy_helper.py', line: 1, dimension: 'dead-code', classification: 'delete-safe', evidence: 'no importers', why_safe: 'unused', proposed_change: 'delete', blast_radius: 'none' },
    ];
    const ff = join(repo, 'findings.json');
    writeFileSync(ff, JSON.stringify(findings), 'utf8');
    execFileSync('git', ['add', 'findings.json'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'findings'], { cwd: repo });

    const cap = capture(t);
    const { exitCode } = runAuditCollect({ forgeDir: join(repo, '.forge'), json: true, findingsFile: ff, scopeOverride: ['app/**', 'lib/**'] });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { work_order_path: string; verify_configured: boolean; warnings: string[]; dropped: { count: number } } };
    assert.equal(env.ok, true);
    // Non-vacuity: the in-scope, non-protected finding is KEPT (not silently dropped).
    assert.equal(env.data.dropped.count, 0, 'the valid finding must not be dropped');

    // READ-ONLY: the only thing written is under .forge/audits/.
    const dirty = porcelain(repo).split('\n').filter((l) => l.trim().length > 0);
    assert.ok(dirty.length > 0, 'expected the audit artifact to show as untracked');
    for (const line of dirty) {
      assert.match(line, /\.forge\/audits\//, `unexpected non-audit change: ${line}`);
    }

    // verify unset → the work-order + result warn that findings are unverifiable.
    assert.equal(env.data.verify_configured, false);
    assert.ok(env.data.warnings.some((w) => /verify/i.test(w) && /unverifiab|gate/i.test(w)), `expected unverifiable warning, got ${JSON.stringify(env.data.warnings)}`);

    // The kept finding is actually in the work-order (non-vacuity).
    const wo = JSON.parse(readFileSync(env.data.work_order_path, 'utf8')) as { findings: { file: string }[] };
    assert.ok(wo.findings.some((f) => f.file === 'app/legacy_helper.py'), 'work-order must contain the kept finding');

    // The work-order leaks no forge-specific path.
    assertNoForgeLeak(readFileSync(env.data.work_order_path, 'utf8'), 'work-order.json');
    assertNoForgeLeak(readFileSync(env.data.work_order_path.replace(/\.json$/, '.md'), 'utf8'), 'work-order.md');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('audit --help — CLI smoke (exits 0, lists sub-verbs)', () => {
  const out = execFileSync(tsxBin, [forgeBinEntry, 'orchestrate', 'audit', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.match(out, /plan/);
  assert.match(out, /collect/);
  assert.match(out, /create-issues/);
});
