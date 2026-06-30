import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBackend } from '../../../src/memory/local/backend.ts';
import { openDb } from '../../../src/memory/local/db.ts';

// node:sqlite DatabaseSync is synchronous; "concurrency" here means many separate
// connections to ONE WAL db writing in an interleaved fashion. The real assertion
// is that WAL + busy_timeout are set so writers retry-then-block (no silent
// SQLITE_BUSY row-drop) and ALL rows land.

test('WAL + busy_timeout are enabled on an opened db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-conc-pragma-'));
  const dbPath = join(dir, 'loom.db');
  const { db } = await openDb(dbPath);
  try {
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(jm.journal_mode.toLowerCase(), 'wal');
    const bt = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.ok(bt.timeout >= 5000, `busy_timeout should be >= 5000, got ${bt.timeout}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('N parallel upsert transactions across separate WAL connections lose no rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-conc-'));
  const dbPath = join(dir, 'loom.db');
  // Initialize the schema once.
  const init = await openLocalBackend(dbPath);
  await init.close();

  const N = 10;
  const perWriter = 5;
  // Each writer opens its OWN backend/connection to the same WAL db and upserts
  // a disjoint set of nodes in a transaction. Promise.all interleaves them.
  await Promise.all(
    Array.from({ length: N }, async (_unused, w) => {
      const backend = await openLocalBackend(dbPath);
      try {
        const nodes = Array.from({ length: perWriter }, (_u, i) => ({
          id: `task:W${w}-N${i}`,
          kind: 'task' as const,
          title: `node ${w}-${i}`,
          body: `body ${w}-${i}`,
        }));
        await backend.upsertNodes(nodes);
      } finally {
        await backend.close();
      }
    }),
  );

  const verify = await openLocalBackend(dbPath);
  try {
    const s = await verify.status();
    assert.equal(s.node_count, N * perWriter, 'every concurrently-upserted row must be present');
  } finally {
    await verify.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
