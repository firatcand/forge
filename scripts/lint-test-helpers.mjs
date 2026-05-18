#!/usr/bin/env node
// lint-test-helpers: fail if any file under test/**/*.ts hardcodes the legacy
// `node_modules/.bin/tsx` path. Worktrees inherit git refs but not
// node_modules, so this absolute path resolves to a non-existent file from
// any worktree checkout and tests silently return exitCode: undefined.
//
// Fix: import { tsxBin } from 'test/helpers/spawn-tsx.ts' instead.
// See plans/tasks/FORGE-122.plan.md (this rule must not be weakened by
// excluding files — and no test file may include the forbidden literal
// even in a comment, since the grep matches anywhere in source).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = 'node_modules/.bin/tsx';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const testRoot = join(repoRoot, 'test');

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

const offenders = [];
for (const file of walk(testRoot)) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(FORBIDDEN)) offenders.push(file);
}

if (offenders.length > 0) {
  console.error(`lint-test-helpers FAIL — ${offenders.length} file(s) contain the legacy '${FORBIDDEN}' path:`);
  for (const f of offenders) console.error(`  ${relative(repoRoot, f)}`);
  console.error('');
  console.error('Fix: import { tsxBin } from "test/helpers/spawn-tsx.ts" (see plans/tasks/FORGE-122.plan.md).');
  console.error('The literal must not appear in test files — not even in comments.');
  process.exit(1);
}

console.log(`lint-test-helpers OK — 0 hardcoded '${FORBIDDEN}' paths in test/`);
