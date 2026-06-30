// FORGE-228 (Loom I4): opt-in smoke test against a REAL Postgres/Neon.
//
// SKIPPED unless LOOM_PG_SMOKE_URL is set (CI stays hermetic — the unit contract
// runs on in-process PGlite). PGlite is single-connection, so it cannot exercise
// the real `pg` Pool, true advisory-lock blocking across connections, GIN, or the
// exact `to_tsquery('simple')` planner behaviour — this test does, when pointed at
// a DISPOSABLE database (it wipes nodes/edges via replaceGraph).
//
//   LOOM_PG_SMOKE_URL='postgres://user:pass@host/db?sslmode=require' \
//     node --test --import tsx 'test/integration/loom-pg-smoke.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openRemoteBackend } from '../../src/memory/remote/backend.ts';
import type { MemoryEdge, MemoryNode } from '../../src/schemas/memory.ts';

const SMOKE_URL = process.env.LOOM_PG_SMOKE_URL;

test(
  'remote smoke: real Postgres round-trip (reindex → recall → traverse → doctor)',
  { skip: !SMOKE_URL ? 'set LOOM_PG_SMOKE_URL to run (uses a DISPOSABLE db)' : false },
  async () => {
    // openRemoteBackend reads NEON_DATABASE_URL; point it at the smoke db.
    process.env.NEON_DATABASE_URL = SMOKE_URL;
    const backend = await openRemoteBackend({ backend: 'neon' }, '');
    try {
      const nodes: MemoryNode[] = [
        { id: 'task:A', kind: 'task', title: 'smoke A', body: 'orchestrate the widget' },
        { id: 'task:B', kind: 'task', title: 'smoke B', body: '' },
        { id: 'learning:l', kind: 'learning', title: 'widget lesson', body: 'the widget rationale' },
      ];
      const edges: MemoryEdge[] = [
        { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
        { src: 'learning:l', dst: 'task:B', kind: 'learned_from' },
      ];
      await backend.replaceGraph(nodes, edges);

      const status = await backend.status();
      assert.equal(status.node_count, 3);
      assert.ok(!status.db_path.includes('@'), 'db_path must be redacted (no credentials)');

      const hits = await backend.recallForTask('A');
      const ids = hits.map((h) => h.id);
      assert.ok(ids.includes('learning:l'), `expected learning:l in recall, got ${JSON.stringify(ids)}`);

      const sub = await backend.traverse('task:A', { depth: 1 });
      assert.ok(sub.nodes.some((n) => n.id === 'task:B'));

      const health = await backend.doctor();
      assert.equal(health.orphan_edges.count, 0);
      assert.equal(health.invalid_rows.count, 0);

      // Leave the disposable db clean.
      await backend.reset();
    } finally {
      await backend.close();
    }
  },
);
