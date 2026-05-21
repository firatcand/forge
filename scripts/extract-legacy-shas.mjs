#!/usr/bin/env node
// Extract SHA-256 of each methodology section from test/fixtures/legacy-claudemd.md
// and print them in a form ready to paste into REFERENCE_SHAS in
// src/cli/upgrade/migrate-claudemd.ts.
//
// Run via tsx (resolves the .ts import transparently):
//   node --import tsx scripts/extract-legacy-shas.mjs
//
// Re-run any time test/fixtures/legacy-claudemd.md changes — the migration
// SHA-matches against this fixture, so REFERENCE_SHAS must agree byte-for-byte.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODOLOGY_HEADINGS, extractSection } from '../src/cli/upgrade/migrate-claudemd.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '..', 'test', 'fixtures', 'legacy-claudemd.md');
const file = readFileSync(fixturePath, 'utf8');

let missing = 0;
console.log('// Paste into REFERENCE_SHAS in src/cli/upgrade/migrate-claudemd.ts:');
console.log('export const REFERENCE_SHAS: Readonly<Record<string, string>> = {');
for (const h of METHODOLOGY_HEADINGS) {
  const sec = extractSection(file, h);
  if (!sec) {
    console.error(`MISSING heading in fixture: ${h}`);
    missing++;
    continue;
  }
  const sha = createHash('sha256').update(sec.fullBlock).digest('hex');
  // Escape single quotes in heading text for the literal.
  const escaped = h.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  console.log(`  '${escaped}':\n    '${sha}',`);
}
console.log('};');

if (missing > 0) {
  process.exit(1);
}
