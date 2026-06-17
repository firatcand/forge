#!/usr/bin/env node
// npm-pack-gate: fail if any file under spec/, plans/, docs/, .forge/,
// examples/ leaks into the published npm tarball. Defense in depth on top of
// the package.json#files allowlist — catches regressions in the allowlist.
import { spawnSync } from 'node:child_process';

const FORBIDDEN_PREFIXES = ['spec/', 'plans/', 'docs/', '.forge/', 'examples/'];

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

const meta = parsed[0] ?? {};
const files = meta.files ?? [];
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

// FORGE-219 (Loom I2b-1): the bundled tree-sitter grammar pack (vendor/) pushes
// the tarball past the historic 1 MB discipline line. SPEC §Performance targets
// grants an explicit exception with a 20 MiB unpacked ceiling so growth stays
// measured/bounded. Enforce it here so adding more languages (or a fatter
// grammar) trips CI before it ships.
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024; // 20 MiB
const unpacked = meta.unpackedSize;
if (typeof unpacked !== 'number') {
  console.error('npm-pack-gate FAIL — npm pack did not report an unpackedSize');
  process.exit(2);
}
const unpackedMiB = (unpacked / (1024 * 1024)).toFixed(2);
if (unpacked > MAX_UNPACKED_BYTES) {
  console.error(
    `npm-pack-gate FAIL — unpacked tarball ${unpackedMiB} MiB exceeds the ${(
      MAX_UNPACKED_BYTES /
      (1024 * 1024)
    ).toFixed(0)} MiB ceiling (SPEC Loom grammar-pack budget).`,
  );
  console.error('Fix: trim the vendor/tree-sitter grammar set or raise the SPEC budget deliberately.');
  process.exit(1);
}

// Belt: the grammar pack MUST actually ship (regression guard against dropping
// vendor/ from files[] — which would silently break symbol extraction).
const tarPaths = files.map((f) => f.path);
const hasCoreWasm = tarPaths.includes('vendor/tree-sitter/tree-sitter.wasm');
const hasNotice = tarPaths.includes('vendor/tree-sitter/NOTICE.md');
const grammarCount = tarPaths.filter(
  (p) => /^vendor\/tree-sitter\/tree-sitter-.+\.wasm$/.test(p),
).length;
if (!hasCoreWasm || !hasNotice || grammarCount < 10) {
  console.error('npm-pack-gate FAIL — Loom grammar pack incomplete in tarball:');
  console.error(`  core wasm: ${hasCoreWasm}, NOTICE.md: ${hasNotice}, grammars: ${grammarCount}`);
  console.error('Fix: ensure "vendor/" is in package.json#files and vendor/tree-sitter/ is populated.');
  process.exit(1);
}

console.log(
  `npm-pack-gate OK — 0 forbidden paths, ${files.length} files, ${grammarCount} grammars, unpacked ${unpackedMiB} MiB (≤ 20 MiB).`,
);
