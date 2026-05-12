// Repo-wide guard: no stray `/push-to-linear` mentions outside an explicit
// allowlist. Prevents regression on the FORGE-23 rename.
//
// Allowlist captures files where Linear-by-name is correct:
//   - skills/push-to-linear/SKILL.md      → the deprecation stub itself
//   - CHANGELOG.md                         → historical entries + deprecation note
//   - docs/retros/**                       → historical task tracking rows
//   - test/fixtures/phases/live-snapshot.yaml → frozen Linear export at decompose-time

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const STALE = '/push-to-linear';

const ALLOWLIST: ReadonlyArray<RegExp> = [
  /^skills\/push-to-linear\/SKILL\.md$/,
  /^CHANGELOG\.md$/,
  /^docs\/retros\//,
  /^test\/fixtures\/phases\/live-snapshot\.yaml$/,
  // Self: this test file documents the stale string.
  /^test\/unit\/repo\/no-stale-push-to-linear\.test\.ts$/,
  // Plan files are gitignored in worktrees but list here for safety.
  /^plans\//,
];

const SCAN_ROOTS: ReadonlyArray<string> = [
  'skills',
  'agents',
  'docs',
  'templates',
  'examples',
  'README.md',
  'CHANGELOG.md',
];

const SCAN_EXTS: ReadonlySet<string> = new Set(['.md', '.yaml', '.yml']);

function isAllowlisted(rel: string): boolean {
  return ALLOWLIST.some((re) => re.test(rel));
}

function* walk(root: string): Generator<string> {
  const abs = resolve(repoRoot, root);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield abs;
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (entry.name === 'node_modules') continue;
    const child = join(abs, entry.name);
    if (entry.isDirectory()) {
      yield* walk(relative(repoRoot, child));
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

function shouldScan(abs: string): boolean {
  const dot = abs.lastIndexOf('.');
  if (dot < 0) return false;
  return SCAN_EXTS.has(abs.slice(dot));
}

test('no-stale-push-to-linear: repo is clean of stray /push-to-linear references', () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(root)) {
      if (!shouldScan(abs)) continue;
      const rel = relative(repoRoot, abs).replaceAll('\\', '/');
      if (isAllowlisted(rel)) continue;
      const body = readFileSync(abs, 'utf8');
      if (body.includes(STALE)) {
        offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Stale /push-to-linear references found in:\n  ${offenders.join('\n  ')}\n` +
      'Either rename to /push-to-tracker, or extend the ALLOWLIST in this test with a clear rationale.',
  );
});

test('no-stale-push-to-linear: no `linear-syncer` mentions outside CHANGELOG/retros/plan/this-test', () => {
  const STALE_AGENT = 'linear-syncer';
  const ALLOWLIST_AGENT: ReadonlyArray<RegExp> = [
    /^CHANGELOG\.md$/,
    /^docs\/retros\//,
    /^plans\//,
    /^test\/unit\/repo\/no-stale-push-to-linear\.test\.ts$/,
    /^test\/unit\/skills\/push-to-tracker\.contract\.test\.ts$/,
    /^test\/fixtures\/phases\/live-snapshot\.yaml$/,
  ];
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(root)) {
      if (!shouldScan(abs)) continue;
      const rel = relative(repoRoot, abs).replaceAll('\\', '/');
      if (ALLOWLIST_AGENT.some((re) => re.test(rel))) continue;
      const body = readFileSync(abs, 'utf8');
      if (body.includes(STALE_AGENT)) {
        offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Stale "linear-syncer" references found in:\n  ${offenders.join('\n  ')}\n` +
      'The agent was renamed to "tracker-syncer" in FORGE-23.',
  );
});
