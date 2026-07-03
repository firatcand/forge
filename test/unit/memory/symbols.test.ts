import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSymbols, resolveGrammarsDir } from '../../../src/memory/symbols.ts';
import { MEMORY_ID_MAX_LEN } from '../../../src/schemas/memory.ts';

// FORGE-219 (Loom I2b-1): the multi-language tree-sitter symbol extractor.
// These tests load real wasm grammars from vendor/tree-sitter/ — exercising the
// validated 0.22.6 API end to end.

function tmpRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolveGrammarsDir resolves the vendored asset dir in the dev layout', () => {
  const dir = resolveGrammarsDir();
  // Must contain the core wasm + the curated grammars.
  assert.ok(existsSync(join(dir, 'tree-sitter.wasm')), 'core wasm present');
  for (const lang of ['python', 'rust', 'go', 'c', 'cpp', 'java', 'javascript', 'typescript', 'tsx', 'ruby']) {
    assert.ok(existsSync(join(dir, `tree-sitter-${lang}.wasm`)), `${lang} grammar present`);
    assert.ok(existsSync(join(dir, 'queries', `${lang}-tags.scm`)), `${lang} tags query present`);
  }
  assert.ok(existsSync(join(dir, 'NOTICE.md')), 'NOTICE manifest present');
});

test('extractSymbols extracts names/kinds/spans across py/go/rust/c/ts', async () => {
  const repoRoot = tmpRepo('loom-sym-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.py'), 'def hello(x):\n    return x\nclass Greeter:\n    def greet(self):\n        pass\n');
    writeFileSync(join(repoRoot, 'src', 'main.go'), 'package main\nfunc Run() {}\ntype Server struct{}\n');
    writeFileSync(join(repoRoot, 'src', 'lib.rs'), 'fn build() {}\nstruct Widget {}\nenum Color {}\n');
    writeFileSync(join(repoRoot, 'src', 'core.c'), 'int compute(int x){return x;}\nstruct Node{int v;};\n');
    writeFileSync(join(repoRoot, 'src', 'mod.ts'), 'export function load() {}\nexport class Store { save() {} }\ninterface Opts {}\ntype Id = string\n');

    const rel = ['src/app.py', 'src/main.go', 'src/lib.rs', 'src/core.c', 'src/mod.ts'];
    const { symbolNodes, definesEdges, warnings } = await extractSymbols({ repoRoot, relFiles: rel });

    assert.equal(warnings.length, 0, `no warnings expected: ${warnings.join('; ')}`);
    // One defines edge per symbol; each from the correct file node.
    assert.equal(definesEdges.length, symbolNodes.length);
    for (const e of definesEdges) {
      assert.equal(e.kind, 'defines');
      assert.ok(e.src.startsWith('file:'), 'defines src is a file node');
      assert.ok(e.dst.startsWith('symbol:'), 'defines dst is a symbol node');
    }

    const byName = new Map(symbolNodes.map((n) => [n.title, n]));
    // Python
    assert.ok(byName.has('hello'));
    assert.equal(byName.get('hello')?.attrs?.kind, 'function');
    assert.ok(byName.has('Greeter'));
    assert.equal(byName.get('Greeter')?.attrs?.kind, 'class');
    assert.ok(byName.has('greet'));
    // Go
    assert.equal(byName.get('Run')?.attrs?.kind, 'function');
    assert.equal(byName.get('Server')?.attrs?.kind, 'type');
    // Rust
    assert.equal(byName.get('build')?.attrs?.kind, 'function');
    assert.equal(byName.get('Widget')?.attrs?.kind, 'struct');
    assert.equal(byName.get('Color')?.attrs?.kind, 'enum');
    // C
    assert.equal(byName.get('compute')?.attrs?.kind, 'function');
    assert.equal(byName.get('Node')?.attrs?.kind, 'struct');
    // TS
    assert.equal(byName.get('load')?.attrs?.kind, 'function');
    assert.equal(byName.get('Store')?.attrs?.kind, 'class');
    assert.equal(byName.get('save')?.attrs?.kind, 'method');
    assert.equal(byName.get('Opts')?.attrs?.kind, 'interface');
    assert.equal(byName.get('Id')?.attrs?.kind, 'type');

    // Spans: hello is on line 1 (1-based); Greeter spans lines 3-5.
    assert.equal(byName.get('hello')?.attrs?.start_line, '1');
    assert.equal(byName.get('Greeter')?.attrs?.start_line, '3');
    assert.equal(byName.get('Greeter')?.attrs?.end_line, '5');

    // Names/kinds/spans/paths ONLY — body must be empty, attrs carry no source.
    for (const n of symbolNodes) {
      assert.equal(n.kind, 'symbol');
      assert.equal(n.body, '', 'symbol body must be empty (no source text)');
      assert.ok(n.attrs?.file, 'attrs.file present');
      assert.ok(n.id.length <= MEMORY_ID_MAX_LEN, `id ≤ ${MEMORY_ID_MAX_LEN}: ${n.id.length}`);
      assert.ok(/^symbol:[0-9a-f]{64}$/.test(n.id), `hashed id shape: ${n.id}`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols is deterministic: two runs produce identical nodes/edges', async () => {
  const repoRoot = tmpRepo('loom-sym-det-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'a.py'), 'def f():\n    pass\nclass C:\n    pass\n');
    const rel = ['src/a.py'];
    const r1 = await extractSymbols({ repoRoot, relFiles: rel });
    const r2 = await extractSymbols({ repoRoot, relFiles: rel });
    assert.deepEqual(r2.symbolNodes, r1.symbolNodes);
    assert.deepEqual(r2.definesEdges, r1.definesEdges);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols skips + warns on a symlinked source file (B2)', async () => {
  const repoRoot = tmpRepo('loom-sym-link-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'real.py'), 'def secret():\n    pass\n');
    symlinkSync(join(repoRoot, 'real.py'), join(repoRoot, 'src', 'link.py'));
    const { symbolNodes, warnings } = await extractSymbols({
      repoRoot,
      relFiles: ['src/link.py'],
    });
    assert.equal(symbolNodes.length, 0, 'symlinked source must not be parsed');
    assert.ok(warnings.some((w) => /symlink/i.test(w)), `expected a symlink warning: ${warnings.join('; ')}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols skips an oversize file with a warning', async () => {
  const repoRoot = tmpRepo('loom-sym-big-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    // > 1 MiB of valid-ish python.
    const big = 'def f():\n    pass\n' + '#'.repeat(1024 * 1024 + 10);
    writeFileSync(join(repoRoot, 'src', 'big.py'), big);
    const { symbolNodes, warnings } = await extractSymbols({ repoRoot, relFiles: ['src/big.py'] });
    assert.equal(symbolNodes.length, 0);
    // FORGE-229: warnings are now constants-only/aggregated by reason (no path echo).
    assert.ok(
      warnings.some((w) => w.includes('skipped (too large)')),
      `expected an oversize warning: ${warnings.join('; ')}`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols skips unknown extensions silently (no warning)', async () => {
  const repoRoot = tmpRepo('loom-sym-unk-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'README.md'), '# hello\n');
    writeFileSync(join(repoRoot, 'data.json'), '{"a":1}\n');
    const { symbolNodes, definesEdges, warnings } = await extractSymbols({
      repoRoot,
      relFiles: ['README.md', 'data.json'],
    });
    assert.equal(symbolNodes.length, 0);
    assert.equal(definesEdges.length, 0);
    assert.equal(warnings.length, 0, 'unknown extensions are skipped silently');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols never throws on malformed source — warn or partial, never crash', async () => {
  const repoRoot = tmpRepo('loom-sym-bad-');
  try {
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    // Syntactically broken across languages — tree-sitter is error-tolerant and
    // recovers, so this must not throw (extraction degrades gracefully).
    writeFileSync(join(repoRoot, 'src', 'broken.ts'), 'function (((( {{{ class ??? interface\n');
    writeFileSync(join(repoRoot, 'src', 'ok.py'), 'def good():\n    pass\n');
    const { symbolNodes } = await extractSymbols({
      repoRoot,
      relFiles: ['src/broken.ts', 'src/ok.py'],
    });
    // The well-formed file still yields its symbol.
    assert.ok(symbolNodes.some((n) => n.title === 'good'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('extractSymbols returns empty for a repo with no indexable code', async () => {
  const repoRoot = tmpRepo('loom-sym-empty-');
  try {
    const { symbolNodes, definesEdges, warnings } = await extractSymbols({
      repoRoot,
      relFiles: [],
    });
    assert.equal(symbolNodes.length, 0);
    assert.equal(definesEdges.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
