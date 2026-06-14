import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ModelsCatalogSchema, CATALOG_HOSTS } from '../../../src/schemas/models-catalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SEED_PATH = resolve(repoRoot, 'templates', 'models-catalog.seed.json');

// R5: the bundled cold-start seed must ALWAYS be valid against the schema —
// it's the fallback the `models` verb loads when no cache exists. package.json
// `files` includes templates/, so it ships in the tarball.
test('R5 — templates/models-catalog.seed.json parses against ModelsCatalogSchema', () => {
  const raw = readFileSync(SEED_PATH, 'utf8');
  const r = ModelsCatalogSchema.safeParse(JSON.parse(raw));
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues, null, 2));
});

test('R5 — seed covers every host with at least one model', () => {
  const r = ModelsCatalogSchema.safeParse(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
  assert.equal(r.success, true);
  if (!r.success) return;
  for (const host of CATALOG_HOSTS) {
    const hc = r.data.hosts[host];
    assert.ok(hc && hc.models.length >= 1, `seed must list at least one ${host} model`);
  }
});
