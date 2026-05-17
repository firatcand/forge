import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidGlobError,
  matchAny,
  __resetGlobMatchCacheForTests,
} from '../../../src/orchestrator/glob-match.ts';

test('matchAny: literal path matches exactly', () => {
  const r = matchAny('src/index.ts', ['src/index.ts']);
  assert.equal(r.matched, true);
  assert.equal(r.matchedGlob, 'src/index.ts');
});

test('matchAny: literal path does not match a longer path', () => {
  assert.equal(matchAny('src/index.ts.bak', ['src/index.ts']).matched, false);
  assert.equal(matchAny('src/index.ts2', ['src/index.ts']).matched, false);
});

test('matchAny: ** matches any depth under prefix', () => {
  assert.equal(matchAny('src/schemas/settings.ts', ['src/schemas/**']).matched, true);
  assert.equal(matchAny('src/schemas/sub/dir/file.ts', ['src/schemas/**']).matched, true);
});

test('matchAny: **/ enforces segment boundary (regression for FORGE-97 Codex review)', () => {
  // Codex flagged: src/**/foo.ts compiled as raw .* matches src/barfoo.ts.
  // The fix compiles **/ to (?:[^/]+/)* (zero or more whole segments).
  assert.equal(matchAny('src/foo.ts', ['src/**/foo.ts']).matched, true);
  assert.equal(matchAny('src/a/foo.ts', ['src/**/foo.ts']).matched, true);
  assert.equal(matchAny('src/a/b/c/foo.ts', ['src/**/foo.ts']).matched, true);
  // The bug case — must NOT match:
  assert.equal(matchAny('src/barfoo.ts', ['src/**/foo.ts']).matched, false);
  assert.equal(matchAny('src/foo.tsx', ['src/**/foo.ts']).matched, false);
});

test('matchAny: trailing ** requires at least one char (no bare prefix match)', () => {
  // `src/**` should match `src/foo` but not bare `src/` (empty trailing).
  assert.equal(matchAny('src/foo', ['src/**']).matched, true);
  assert.equal(matchAny('src/sub/foo', ['src/**']).matched, true);
  assert.equal(matchAny('src/', ['src/**']).matched, false);
});

test('matchAny: compiled regex is cached (same glob compiles once)', () => {
  __resetGlobMatchCacheForTests();
  // Repeat the same glob through matchAny — the cache hit path must produce
  // the same result as a fresh compile. Indirect test: 10 calls in a row.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(matchAny('src/schemas/x.ts', ['src/schemas/**']).matched, true);
  }
});

test('matchAny: ** does NOT match prefix without trailing path', () => {
  // `src/schemas/**` requires at least `src/schemas/<something>`, not bare `src/schemas`.
  assert.equal(matchAny('src/schemas', ['src/schemas/**']).matched, false);
});

test('matchAny: * matches within a single segment', () => {
  assert.equal(matchAny('src/foo.ts', ['src/*.ts']).matched, true);
  assert.equal(matchAny('src/sub/foo.ts', ['src/*.ts']).matched, false);
});

test('matchAny: regex metachars in pattern are escaped', () => {
  // `package.json` must not match `packageXjson` (the dot is literal).
  assert.equal(matchAny('packageXjson', ['package.json']).matched, false);
  assert.equal(matchAny('package.json', ['package.json']).matched, true);
});

test('matchAny: returns the first matching glob', () => {
  const r = matchAny('src/schemas/settings.ts', ['src/index.ts', 'src/schemas/**', 'src/cli/**']);
  assert.equal(r.matched, true);
  assert.equal(r.matchedGlob, 'src/schemas/**');
});

test('matchAny: empty glob list returns no match', () => {
  assert.equal(matchAny('src/index.ts', []).matched, false);
});

test('matchAny: paths starting with ./ are normalized', () => {
  assert.equal(matchAny('./src/index.ts', ['src/index.ts']).matched, true);
});

test('matchAny: paths outside the repo (..) never match', () => {
  assert.equal(matchAny('../outside.ts', ['**']).matched, false);
  assert.equal(matchAny('..', ['**']).matched, false);
});

test('matchAny: absolute path throws (caller must pass relative)', () => {
  assert.throws(
    () => matchAny('/abs/src/index.ts', ['src/index.ts']),
    /repo-relative path/,
  );
});

test('matchAny: leading slash in pattern throws', () => {
  assert.throws(
    () => matchAny('src/index.ts', ['/src/index.ts']),
    InvalidGlobError,
  );
});

test('matchAny: empty pattern throws', () => {
  assert.throws(() => matchAny('src/index.ts', ['']), InvalidGlobError);
});

test('matchAny: spec preflight_globs default list matches expected paths', () => {
  // Mirrors the default list from spec/ORCHESTRATOR.md §Preflight wrapper.
  // (src/cli/migrate.ts is intentionally omitted; first-hit-wins makes it
  // unreachable behind src/cli/**.)
  const globs = [
    'src/index.ts',
    'src/schemas/**',
    'src/bin/**',
    'src/cli/**',
    'src/trackers/base.ts',
    'spec/**',
    'CRITICAL.md',
    'CLAUDE.md',
    'AGENTS.md',
    'package.json',
    'phases.yaml',
  ];
  for (const [path, expectedGlob] of [
    ['src/index.ts', 'src/index.ts'],
    ['src/schemas/settings.ts', 'src/schemas/**'],
    ['src/bin/forge.ts', 'src/bin/**'],
    ['src/cli/orchestrate/guardrail-check.ts', 'src/cli/**'],
    ['src/trackers/base.ts', 'src/trackers/base.ts'],
    ['src/cli/migrate.ts', 'src/cli/**'],
    ['spec/SPEC.md', 'spec/**'],
    ['CRITICAL.md', 'CRITICAL.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['package.json', 'package.json'],
    ['phases.yaml', 'phases.yaml'],
  ] as const) {
    const r = matchAny(path, globs);
    assert.equal(r.matched, true, `expected ${path} to match`);
    assert.equal(r.matchedGlob, expectedGlob, `expected ${path} to match ${expectedGlob}, got ${r.matchedGlob}`);
  }
  // Non-architectural paths should NOT match.
  assert.equal(matchAny('src/orchestrator/internal-helper.ts', globs).matched, false);
  assert.equal(matchAny('test/unit/foo.test.ts', globs).matched, false);
});
