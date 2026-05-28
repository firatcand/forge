import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runPreflight,
  resolveRepoRelative,
  suggestDecisionKey,
} from '../../../src/orchestrator/preflight.ts';
import { SettingsSchema } from '../../../src/schemas/settings.ts';

// The real default guardrail glob list (schema default), so this test tracks
// changes to spec/ORCHESTRATOR.md §Preflight wrapper automatically.
const DEFAULT_GLOBS = SettingsSchema.parse({
  version: 1,
  project: { name: 't' },
  tracker: { type: 'linear', config: { team_id: 'T' } },
  secrets: { manager: 'env_file' },
}).agents.preflight_globs;

// A representative repo-relative path that SHOULD match each default glob, and
// the glob we expect first-hit-wins matching to attribute it to. Order matters:
// glob-match returns the first matching entry, so each path is chosen to land
// on its intended glob given the default list order.
const GLOB_FIXTURES: ReadonlyArray<{ path: string; glob: string }> = [
  { path: 'src/index.ts', glob: 'src/index.ts' },
  { path: 'src/schemas/settings.ts', glob: 'src/schemas/**' },
  { path: 'src/bin/cli.ts', glob: 'src/bin/**' },
  { path: 'src/cli/orchestrate/foo.ts', glob: 'src/cli/**' },
  { path: 'src/trackers/base.ts', glob: 'src/trackers/base.ts' },
  { path: 'spec/SPEC.md', glob: 'spec/**' },
  { path: 'CRITICAL.md', glob: 'CRITICAL.md' },
  { path: 'CLAUDE.md', glob: 'CLAUDE.md' },
  { path: 'AGENTS.md', glob: 'AGENTS.md' },
  { path: 'GEMINI.md', glob: 'GEMINI.md' },
  { path: 'package.json', glob: 'package.json' },
  { path: 'phases.yaml', glob: 'phases.yaml' },
];

function setupRepo(): { repoRoot: string } {
  return { repoRoot: mkdtempSync(join(tmpdir(), 'forge-preflight-')) };
}

test('runPreflight: detects writes to ALL default guardrail globs (AC2)', () => {
  const { repoRoot } = setupRepo();
  // Every default glob must be exercised by a fixture — guards against a new
  // default glob slipping in without coverage.
  const covered = new Set(GLOB_FIXTURES.map((f) => f.glob));
  for (const glob of DEFAULT_GLOBS) {
    assert.ok(covered.has(glob), `default glob '${glob}' has no preflight fixture`);
  }

  for (const { path: rel, glob } of GLOB_FIXTURES) {
    const outcome = runPreflight({
      repoRoot,
      cwd: repoRoot,
      targetPath: rel,
      globs: DEFAULT_GLOBS,
    });
    assert.equal(outcome.kind, 'ok', `${rel}: expected ok outcome`);
    if (outcome.kind !== 'ok') continue;
    assert.equal(outcome.result.architectural, true, `${rel}: expected architectural`);
    assert.equal(outcome.result.matched_glob, glob, `${rel}: expected glob ${glob}`);
    assert.ok(outcome.result.suggested_decision_key, `${rel}: expected a decision_key`);
  }
});

test('runPreflight: non-guarded path is not architectural', () => {
  const { repoRoot } = setupRepo();
  const outcome = runPreflight({
    repoRoot,
    cwd: repoRoot,
    targetPath: 'src/orchestrator/internal-helper.ts',
    globs: DEFAULT_GLOBS,
  });
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal(outcome.result.architectural, false);
  assert.equal(outcome.result.matched_glob, null);
  assert.equal(outcome.result.suggested_decision_key, null);
});

test('runPreflight: repo-relative path computed from a subdirectory cwd', () => {
  const { repoRoot } = setupRepo();
  const subCwd = join(repoRoot, 'src');
  mkdirSync(subCwd, { recursive: true });
  const outcome = runPreflight({
    repoRoot,
    cwd: subCwd,
    targetPath: 'schemas/settings.ts',
    globs: DEFAULT_GLOBS,
  });
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal(outcome.result.path, 'src/schemas/settings.ts');
  assert.equal(outcome.result.architectural, true);
});

test('runPreflight: absolute path outside the repo → outside_repo', () => {
  const { repoRoot } = setupRepo();
  const otherDir = mkdtempSync(join(tmpdir(), 'forge-other-'));
  const outcome = runPreflight({
    repoRoot,
    cwd: repoRoot,
    targetPath: join(otherDir, 'src/index.ts'),
    globs: DEFAULT_GLOBS,
  });
  assert.equal(outcome.kind, 'outside_repo');
});

test('runPreflight: ../ traversal → outside_repo', () => {
  const { repoRoot } = setupRepo();
  const outcome = runPreflight({
    repoRoot,
    cwd: repoRoot,
    targetPath: '../../../etc/passwd',
    globs: DEFAULT_GLOBS,
  });
  assert.equal(outcome.kind, 'outside_repo');
});

test('runPreflight: symlink inside repo pointing OUT → outside_repo (realpath, not lexical)', () => {
  const { repoRoot } = setupRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'forge-evil-'));
  writeFileSync(join(outsideDir, 'evil.ts'), 'export const x = 1;');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  symlinkSync(join(outsideDir, 'evil.ts'), join(repoRoot, 'src/index.ts'));
  const outcome = runPreflight({
    repoRoot,
    cwd: repoRoot,
    targetPath: 'src/index.ts',
    globs: DEFAULT_GLOBS,
  });
  assert.equal(outcome.kind, 'outside_repo');
});

test('runPreflight: invalid glob (leading slash) → invalid_glob with the offending glob', () => {
  const { repoRoot } = setupRepo();
  const outcome = runPreflight({
    repoRoot,
    cwd: repoRoot,
    targetPath: 'src/index.ts',
    globs: ['/abs/pattern'],
  });
  assert.equal(outcome.kind, 'invalid_glob');
  if (outcome.kind !== 'invalid_glob') return;
  assert.equal(outcome.glob, '/abs/pattern');
});

test('suggestDecisionKey: stable + per-file (basename-anchored)', () => {
  const a = suggestDecisionKey('src/schemas/**', 'src/schemas/settings.ts');
  const b = suggestDecisionKey('src/schemas/**', 'src/schemas/settings.ts');
  assert.equal(a, b, 'same inputs → same key');
  assert.equal(a, 'guardrail:src-schemas:settings.ts');
  const c = suggestDecisionKey('src/schemas/**', 'src/schemas/other.ts');
  assert.notEqual(a, c, 'different files → different keys');
});

test('resolveRepoRelative: in-repo path resolves to a repo-relative string', () => {
  const { repoRoot } = setupRepo();
  const resolved = resolveRepoRelative(repoRoot, repoRoot, 'src/cli/foo.ts');
  assert.ok('relative' in resolved);
  if ('relative' in resolved) assert.equal(resolved.relative, 'src/cli/foo.ts');
});
