#!/usr/bin/env node
// npm-pack-gate: fail if any file under spec/, plans/, docs/, .forge/
// leaks into the published npm tarball. Defense in depth on top of the
// package.json#files allowlist — catches regressions in the allowlist.
import { spawnSync } from 'node:child_process';

const FORBIDDEN_PREFIXES = ['spec/', 'plans/', 'docs/', '.forge/'];

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
if (result.status !== 0) {
  console.error('npm pack failed:');
  console.error(result.stderr);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch (err) {
  console.error('npm pack returned non-JSON output:');
  console.error(result.stdout);
  process.exit(2);
}

const files = parsed[0]?.files ?? [];
const leaked = files
  .map((f) => f.path)
  .filter((p) => FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)));

if (leaked.length > 0) {
  console.error('npm-pack-gate FAIL — forbidden paths in tarball:');
  for (const path of leaked) console.error(`  ${path}`);
  console.error(`\nForbidden prefixes: ${FORBIDDEN_PREFIXES.join(', ')}`);
  console.error('Fix: remove offending paths from package.json#files allowlist.');
  process.exit(1);
}

console.log(`npm-pack-gate OK — 0 forbidden paths in tarball (${files.length} files total)`);
