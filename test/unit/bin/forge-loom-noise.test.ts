import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';
import { tsxBin, forgeBinEntry as entry, repoRoot } from '../../helpers/spawn-tsx.ts';

// FORGE-200 (Codex B1 regression): `node:sqlite` is experimental and emits an
// ExperimentalWarning the moment it loads. The statusline / --version paths must
// be NOISE-FREE. Because forge.ts dynamic-imports the loom dispatcher only in the
// `loom` branch, AND db.ts lazy-imports node:sqlite only inside openDb(), neither
// of these invocations may print any sqlite/Experimental warning on stderr.

const NOISE = /node:sqlite|ExperimentalWarning|SQLite is an experimental/i;
// FORGE-219 (Loom I2b-1): web-tree-sitter / the wasm grammar pack must NEVER load
// outside `loom reindex`. extractSymbols dynamic-imports web-tree-sitter only
// inside itself (never at module top), and ingest/loom code is dynamic-imported
// only in the `loom` branch — so --version / statusline must show zero
// tree-sitter / wasm activity on stderr.
const TREE_SITTER_NOISE = /tree-sitter|web-tree-sitter|\.wasm|WebAssembly/i;

async function run(args: readonly string[], cwd: string) {
  return execa(tsxBin, [entry, ...args], {
    cwd,
    reject: false,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('forge --version emits NO node:sqlite / ExperimentalWarning on stderr', async () => {
  const r = await run(['--version'], repoRoot);
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.stderr, NOISE, `unexpected sqlite warning on stderr: ${r.stderr}`);
});

test('forge statusline emits NO node:sqlite / ExperimentalWarning on stderr', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'loom-noise-'));
  const r = await run(['statusline'], tmp);
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.stderr, NOISE, `unexpected sqlite warning on stderr: ${r.stderr}`);
});

// FORGE-219: --version is byte-silent on stderr AND loads no tree-sitter / wasm.
test('forge --version emits NO tree-sitter / wasm activity on stderr', async () => {
  const r = await run(['--version'], repoRoot);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '', `--version must be byte-silent on stderr, got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, TREE_SITTER_NOISE, `unexpected tree-sitter/wasm load: ${r.stderr}`);
});

test('forge statusline emits NO tree-sitter / wasm activity on stderr', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'loom-noise-ts-'));
  const r = await run(['statusline'], tmp);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '', `statusline must be byte-silent on stderr, got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, TREE_SITTER_NOISE, `unexpected tree-sitter/wasm load: ${r.stderr}`);
});
