import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  ModelsCatalogSchema,
  ModelEntrySchema,
  CATALOG_HOSTS,
  CATALOG_VERSION,
} from '../../../src/schemas/models-catalog.ts';

function validCatalog(): unknown {
  return {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          {
            id: 'claude-opus-4',
            tier: 'frontier',
            capabilities: 'most capable',
            sources: ['https://docs.anthropic.com/models'],
          },
        ],
      },
    },
  };
}

test('valid catalog parses', () => {
  const r = ModelsCatalogSchema.safeParse(validCatalog());
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.data.version, CATALOG_VERSION);
  assert.equal(r.data.hosts.claude?.models[0]?.tier, 'frontier');
});

test('capabilities is optional', () => {
  const c = validCatalog() as { hosts: { claude: { models: { capabilities?: string }[] } } };
  delete c.hosts.claude.models[0]!.capabilities;
  assert.equal(ModelsCatalogSchema.safeParse(c).success, true);
});

test('rejects unknown host key', () => {
  const c = validCatalog() as { hosts: Record<string, unknown> };
  c.hosts.openai = { models: [{ id: 'x', tier: 'small', sources: ['https://x.com'] }] };
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects bad tier', () => {
  const c = validCatalog() as { hosts: { claude: { models: { tier: string }[] } } };
  c.hosts.claude.models[0]!.tier = 'mega';
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects missing sources', () => {
  const c = validCatalog() as { hosts: { claude: { models: { sources?: string[] }[] } } };
  delete c.hosts.claude.models[0]!.sources;
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects empty sources array (.min(1))', () => {
  const c = validCatalog() as { hosts: { claude: { models: { sources: string[] }[] } } };
  c.hosts.claude.models[0]!.sources = [];
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects non-url source', () => {
  const c = validCatalog() as { hosts: { claude: { models: { sources: string[] }[] } } };
  c.hosts.claude.models[0]!.sources = ['not-a-url'];
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects missing version', () => {
  const c = validCatalog() as { version?: number };
  delete c.version;
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('rejects wrong version literal', () => {
  const c = validCatalog() as { version: number };
  c.version = 2;
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

test('R4 — rejects empty hosts catalog', () => {
  const c = validCatalog() as { hosts: Record<string, unknown> };
  c.hosts = {};
  const r = ModelsCatalogSchema.safeParse(c);
  assert.equal(r.success, false);
  if (r.success) return;
  assert.ok(r.error.issues.some((i) => i.message.includes('at least one host')));
});

test('R4 — accepts a SUBSET of hosts', () => {
  // Only claude listed — codex/gemini/cursor absent is fine.
  assert.equal(ModelsCatalogSchema.safeParse(validCatalog()).success, true);
});

test('R4 — z.record(z.enum(...)) accepts subset, rejects unknown key', () => {
  // Pin the zod-3.25 behavior our schema relies on: a record keyed by a
  // z.enum accepts a SUBSET of the enum members and REJECTS an unknown key.
  const rec = z.record(z.enum(CATALOG_HOSTS), z.string());
  assert.equal(rec.safeParse({ claude: 'a' }).success, true); // subset OK
  assert.equal(rec.safeParse({}).success, true); // empty OK at the record level
  assert.equal(rec.safeParse({ claude: 'a', openai: 'b' }).success, false); // unknown key rejected
});

test('R2 — ModelEntry is strict (rejects unknown key)', () => {
  const r = ModelEntrySchema.safeParse({
    id: 'x',
    tier: 'small',
    sources: ['https://x.com'],
    extra: 'nope',
  });
  assert.equal(r.success, false);
});

test('R2 — id length bound (max 200)', () => {
  const r = ModelEntrySchema.safeParse({
    id: 'a'.repeat(201),
    tier: 'small',
    sources: ['https://x.com'],
  });
  assert.equal(r.success, false);
});

test('R2 — capabilities length bound (max 2000)', () => {
  const r = ModelEntrySchema.safeParse({
    id: 'x',
    tier: 'small',
    capabilities: 'a'.repeat(2001),
    sources: ['https://x.com'],
  });
  assert.equal(r.success, false);
});

test('R2 — sources array bound (max 20)', () => {
  const r = ModelEntrySchema.safeParse({
    id: 'x',
    tier: 'small',
    sources: Array(21).fill('https://x.com'),
  });
  assert.equal(r.success, false);
});

test('R2 — source url length bound (max 500)', () => {
  const r = ModelEntrySchema.safeParse({
    id: 'x',
    tier: 'small',
    sources: ['https://x.com/' + 'a'.repeat(500)],
  });
  assert.equal(r.success, false);
});

test('R2 — models array bound (max 100)', () => {
  const models = Array.from({ length: 101 }, (_, i) => ({
    id: `m${i}`,
    tier: 'small',
    sources: ['https://x.com'],
  }));
  const r = ModelsCatalogSchema.safeParse({
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: { claude: { models } },
  });
  assert.equal(r.success, false);
});

test('R2 — host catalog requires >=1 model', () => {
  const r = ModelsCatalogSchema.safeParse({
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: { claude: { models: [] } },
  });
  assert.equal(r.success, false);
});

test('rejects non-offset/invalid refreshed_at', () => {
  const c = validCatalog() as { refreshed_at: string };
  c.refreshed_at = 'yesterday';
  assert.equal(ModelsCatalogSchema.safeParse(c).success, false);
});

// ── F1: model id charset (reject control chars / ANSI / newlines / spaces) ─────

test('F1 — accepts real-world model ids', () => {
  for (const id of [
    'claude-opus-4',
    'gpt-5.1-codex',
    'gemini-2.5-pro',
    'anthropic/claude-3.5',
    'cursor_composer:1',
  ]) {
    const r = ModelEntrySchema.safeParse({ id, tier: 'small', sources: ['https://x.com'] });
    assert.equal(r.success, true, `expected ${JSON.stringify(id)} to parse`);
  }
});

test('F1 — rejects id with a newline', () => {
  const r = ModelEntrySchema.safeParse({ id: 'claude\nopus', tier: 'small', sources: ['https://x.com'] });
  assert.equal(r.success, false);
});

test('F1 — rejects id with an ANSI escape (\\x1b[31m)', () => {
  const r = ModelEntrySchema.safeParse({ id: '\x1b[31mclaude', tier: 'small', sources: ['https://x.com'] });
  assert.equal(r.success, false);
});

test('F1 — rejects id with a tab', () => {
  const r = ModelEntrySchema.safeParse({ id: 'claude\topus', tier: 'small', sources: ['https://x.com'] });
  assert.equal(r.success, false);
});

test('F1 — rejects id with a space', () => {
  const r = ModelEntrySchema.safeParse({ id: 'claude opus', tier: 'small', sources: ['https://x.com'] });
  assert.equal(r.success, false);
});

// ── F2: reject duplicate model ids within a host ──────────────────────────────

test('F2 — rejects duplicate model ids in a host (even different tiers)', () => {
  const r = ModelsCatalogSchema.safeParse({
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://x.com'] },
          { id: 'claude-opus-4', tier: 'standard', sources: ['https://x.com'] },
        ],
      },
    },
  });
  assert.equal(r.success, false);
});

test('F2 — same id across DIFFERENT hosts is allowed', () => {
  const r = ModelsCatalogSchema.safeParse({
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: { models: [{ id: 'shared-id', tier: 'small', sources: ['https://x.com'] }] },
      codex: { models: [{ id: 'shared-id', tier: 'small', sources: ['https://x.com'] }] },
    },
  });
  assert.equal(r.success, true);
});
