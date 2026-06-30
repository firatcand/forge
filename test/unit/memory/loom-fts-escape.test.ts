import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBackend, buildFtsQuery } from '../../../src/memory/local/backend.ts';

test('buildFtsQuery strips FTS operators and special chars, quoting terms', () => {
  // Hyphens, colons, asterisks, quotes, and bareword operators must not survive.
  const q = buildFtsQuery('FORGE-200: loom* "WAL" AND fts NEAR cache');
  // No raw special chars.
  assert.ok(!/[-:*]/.test(q), `query still has special chars: ${q}`);
  // Bareword operators dropped.
  assert.ok(!/\bAND\b/i.test(q.replace(/"/g, '')), 'AND operator should be dropped');
  assert.ok(!/\bNEAR\b/i.test(q.replace(/"/g, '')), 'NEAR operator should be dropped');
  // Surviving terms are quoted literals.
  assert.match(q, /"forge"/);
  assert.match(q, /"200"/);
  assert.match(q, /"loom"/);
  assert.match(q, /"wal"/);
  assert.match(q, /"cache"/);
});

test('buildFtsQuery returns empty for operator-only / punctuation-only input', () => {
  assert.equal(buildFtsQuery('AND OR NOT NEAR'), '');
  assert.equal(buildFtsQuery('-:*"()'), '');
  assert.equal(buildFtsQuery(''), '');
});

test('recall over a node with FTS-hostile title/description does not throw and matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-fts-'));
  const dbPath = join(dir, 'loom.db');
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      {
        id: 'task:A',
        kind: 'task',
        title: 'FORGE-200: loom* "graph" AND recall',
        body: 'handle - : * " AND OR NOT NEAR safely',
      },
      {
        id: 'learning:l',
        kind: 'learning',
        title: 'loom graph recall notes',
        body: 'graph recall caveat',
      },
    ]);
    // Must not throw on the hostile query; the learning should match via FTS.
    const hits = await backend.recallForTask('A');
    assert.ok(Array.isArray(hits));
    assert.ok(hits.some((h) => h.id === 'learning:l'), 'expected an FTS match on shared terms');
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
