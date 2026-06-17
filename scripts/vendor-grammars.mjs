#!/usr/bin/env node
// FORGE-219 (Loom I2b-1): vendor the tree-sitter runtime + grammar pack.
//
// Loom's multi-language symbol extractor (src/memory/symbols.ts) needs the
// web-tree-sitter core wasm + a curated set of grammar wasms at runtime — with
// ZERO extra install on adopter machines (no postinstall, no network). So the
// wasm + the hand-authored definition queries are COMMITTED under
// vendor/tree-sitter/ and shipped via package.json `files[]` (same pattern as
// templates/). This script is DEV-ONLY: it reproduces the copy from node_modules
// and regenerates the NOTICE manifest so provenance + licenses are documented
// and the committed assets can be refreshed deterministically.
//
//   node scripts/vendor-grammars.mjs
//
// Sources:
//   - core wasm:    node_modules/web-tree-sitter/tree-sitter.wasm   (MIT)
//   - grammar wasm: node_modules/tree-sitter-wasms/out/tree-sitter-<lang>.wasm
//     (the tree-sitter-wasms BUNDLE is Unlicense; each GRAMMAR carries its own
//      upstream license — recorded per-language in the NOTICE below.)
//
// The query .scm files are hand-authored (tree-sitter-wasms ships wasm only),
// so they are NOT regenerated here — they live under vendor/tree-sitter/queries/
// and are snapshot-tested. This script only refreshes the wasm + NOTICE.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const vendorDir = path.join(repoRoot, 'vendor', 'tree-sitter');
const nmTreeSitter = path.join(repoRoot, 'node_modules', 'tree-sitter-wasms', 'out');
const nmCore = path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');

// The curated language set (must match LANGUAGES in src/memory/symbols.ts) and
// each grammar's upstream license for the NOTICE. tree-sitter grammars are
// overwhelmingly MIT (a few Apache-2.0); the values below are the canonical
// upstream licenses for tree-sitter-<lang> at the versions tree-sitter-wasms
// 0.1.13 bundles. Update here when refreshing the pack.
const GRAMMARS = [
  { lang: 'python', repo: 'tree-sitter/tree-sitter-python', license: 'MIT', copyright: 'Copyright (c) 2016 Max Brunsfeld and tree-sitter-python contributors' },
  { lang: 'rust', repo: 'tree-sitter/tree-sitter-rust', license: 'MIT', copyright: 'Copyright (c) 2017 Maxim Sokolov and tree-sitter-rust contributors' },
  { lang: 'go', repo: 'tree-sitter/tree-sitter-go', license: 'MIT', copyright: 'Copyright (c) 2014 Max Brunsfeld and tree-sitter-go contributors' },
  { lang: 'c', repo: 'tree-sitter/tree-sitter-c', license: 'MIT', copyright: 'Copyright (c) 2014 Max Brunsfeld and tree-sitter-c contributors' },
  { lang: 'cpp', repo: 'tree-sitter/tree-sitter-cpp', license: 'MIT', copyright: 'Copyright (c) 2014 Max Brunsfeld and tree-sitter-cpp contributors' },
  { lang: 'java', repo: 'tree-sitter/tree-sitter-java', license: 'MIT', copyright: 'Copyright (c) 2017 Ayman Nadeem and tree-sitter-java contributors' },
  { lang: 'javascript', repo: 'tree-sitter/tree-sitter-javascript', license: 'MIT', copyright: 'Copyright (c) 2014 Max Brunsfeld and tree-sitter-javascript contributors' },
  { lang: 'typescript', repo: 'tree-sitter/tree-sitter-typescript', license: 'MIT', copyright: 'Copyright (c) 2017 GitHub, Inc. and tree-sitter-typescript contributors' },
  { lang: 'tsx', repo: 'tree-sitter/tree-sitter-typescript', license: 'MIT', copyright: 'Copyright (c) 2017 GitHub, Inc. and tree-sitter-typescript contributors' },
  { lang: 'ruby', repo: 'tree-sitter/tree-sitter-ruby', license: 'MIT', copyright: 'Copyright (c) 2016 Rob Rix and tree-sitter-ruby contributors' },
];

// The MIT permission notice (identical across all MIT licenses). Reproduced in
// NOTICE.md per the MIT requirement that "the above copyright notice and this
// permission notice shall be included in all copies" of redistributed software.
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Read web-tree-sitter's actual LICENSE verbatim (the core runtime wasm).
function readCoreLicense() {
  try {
    return readFileSync(path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'LICENSE'), 'utf8').trim();
  } catch {
    return `The MIT License (MIT)\n\nCopyright (c) 2018-2024 Max Brunsfeld\n\n${MIT_PERMISSION}`;
  }
}

function fmtBytes(n) {
  return `${(n / 1024).toFixed(0)} KiB`;
}

function main() {
  mkdirSync(vendorDir, { recursive: true });

  // 1. core wasm.
  const coreDest = path.join(vendorDir, 'tree-sitter.wasm');
  copyFileSync(nmCore, coreDest);
  const coreSize = statSync(coreDest).size;
  console.log(`vendored core: tree-sitter.wasm (${fmtBytes(coreSize)})`);

  // 2. grammar wasms.
  const rows = [];
  let total = coreSize;
  for (const g of GRAMMARS) {
    const src = path.join(nmTreeSitter, `tree-sitter-${g.lang}.wasm`);
    const dest = path.join(vendorDir, `tree-sitter-${g.lang}.wasm`);
    copyFileSync(src, dest);
    const size = statSync(dest).size;
    total += size;
    rows.push({ ...g, size });
    console.log(`vendored grammar: tree-sitter-${g.lang}.wasm (${fmtBytes(size)})`);
  }

  // 3. NOTICE.md manifest (provenance + per-grammar license).
  const coreVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'package.json'), 'utf8'),
  ).version;
  const wasmsVersion = JSON.parse(
    readFileSync(path.join(repoRoot, 'node_modules', 'tree-sitter-wasms', 'package.json'), 'utf8'),
  ).version;

  const lines = [
    '# Vendored tree-sitter assets (FORGE-219 / Loom I2b-1)',
    '',
    '> Auto-generated by `scripts/vendor-grammars.mjs`. Do not edit by hand —',
    '> rerun the script to refresh.',
    '',
    'These WebAssembly grammars + the core tree-sitter runtime are committed so',
    "Loom's multi-language symbol extractor works with ZERO extra install (no",
    'postinstall, no network). They ship in the npm tarball via package.json',
    '`files[]`.',
    '',
    '## Core runtime',
    '',
    `- **tree-sitter.wasm** — from [\`web-tree-sitter@${coreVersion}\`](https://www.npmjs.com/package/web-tree-sitter), license **MIT** (© Max Brunsfeld / tree-sitter contributors).`,
    '',
    '## Grammars',
    '',
    `Grammar wasm sourced from [\`tree-sitter-wasms@${wasmsVersion}\`](https://www.npmjs.com/package/tree-sitter-wasms)`,
    '(that aggregator package is Unlicense). Each grammar below carries its own',
    'upstream license:',
    '',
    '| Language | Grammar | Upstream | License | Size |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.lang} | tree-sitter-${r.lang}.wasm | [${r.repo}](https://github.com/${r.repo}) | ${r.license} | ${fmtBytes(r.size)} |`,
    ),
    '',
    `Total vendored size: **${fmtBytes(total)}** (core + ${rows.length} grammars).`,
    '',
    '## Full license texts',
    '',
    'MIT requires the copyright notice + permission notice be reproduced in all',
    'copies of redistributed software. The bundled grammar wasm are all MIT;',
    'their copyright holders are listed below, followed by the shared MIT',
    'permission notice and the core runtime license verbatim.',
    '',
    '### Core runtime — web-tree-sitter (verbatim)',
    '',
    '```',
    readCoreLicense(),
    '```',
    '',
    '### Bundled grammars — MIT',
    '',
    'Copyright notices (authoritative LICENSE in each linked upstream repo):',
    '',
    // De-dup typescript/tsx (same repo/copyright).
    ...[...new Map(rows.map((r) => [r.copyright, r])).values()].map(
      (r) => `- ${r.copyright} — <https://github.com/${r.repo}/blob/master/LICENSE>`,
    ),
    '',
    'All of the above grammars are distributed under the MIT License:',
    '',
    '```',
    MIT_PERMISSION,
    '```',
    '',
    '## Queries',
    '',
    'The `queries/<lang>-tags.scm` files are hand-authored (the wasm package ships',
    'no upstream tags.scm) and trimmed to DEFINITION captures only — names, kinds,',
    'and line spans, never bodies or docstrings. They are snapshot-tested in',
    '`test/unit/memory/symbols.test.ts`.',
    '',
  ];
  writeFileSync(path.join(vendorDir, 'NOTICE.md'), lines.join('\n'));
  console.log(`wrote NOTICE.md — total vendored ${fmtBytes(total)}`);
}

main();
