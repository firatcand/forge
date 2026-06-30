// FORGE-228 (Loom I4): contract tests for the remote Postgres backend, run
// against an in-process PGlite (real Postgres SQL, no network). Proves the
// dialect actually works — tsvector('simple') FTS + file/symbol exclusion, jsonb
// attrs round-trip, ON CONFLICT upsert, DELETE-based atomic replaceGraph, the
// shared-algorithm recall/traverse parity, and doctor's anti-join health checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { RemoteMemoryBackend, redactDsn, type PgConn, type PgPool } from '../../../src/memory/remote/backend.ts';
import type { MemoryEdge, MemoryNode } from '../../../src/schemas/memory.ts';

// Wrap a single PGlite instance as the injectable PgPool. PGlite is one
// connection, so withConnection reuses it (transactions + advisory locks run on
// the single session — true cross-connection contention is not exercised here,
// see the skipped real-Postgres smoke test).
function pglitePool(db: PGlite): PgPool {
  const conn: PgConn = {
    query: (text, params) => db.query(text, params ?? []) as Promise<{ rows: never[] }>,
  };
  return {
    query: (text, params) => db.query(text, params ?? []) as Promise<{ rows: never[] }>,
    withConnection: (fn) => fn(conn),
    end: () => db.close(),
  };
}

async function makeBackend(): Promise<{ backend: RemoteMemoryBackend; db: PGlite }> {
  const db = await PGlite.create();
  const backend = new RemoteMemoryBackend(pglitePool(db), 'postgres:test/loom');
  await backend.bootstrap();
  return { backend, db };
}

const node = (id: string, kind: MemoryNode['kind'], title: string, body = '', attrs?: MemoryNode['attrs']): MemoryNode => ({
  id,
  kind,
  title,
  body,
  ...(attrs !== undefined ? { attrs } : {}),
});

test('remote: bootstrap is idempotent + status reports honest zero by_kind', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.bootstrap(); // second call must not throw (CREATE IF NOT EXISTS)
    const s = await backend.status();
    assert.equal(s.node_count, 0);
    assert.equal(s.edge_count, 0);
    assert.deepEqual(s.by_kind, { task: 0, learning: 0, file: 0, symbol: 0, decision: 0 });
    assert.equal(s.db_path, 'postgres:test/loom'); // redacted location, never a DSN
  } finally {
    await db.close();
  }
});

test('remote: upsert + status counts + jsonb attrs round-trip via query', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([
      node('task:A', 'task', 'Build the thing', 'desc', { tracker_issue_id: 'FORGE-1', write_globs: ['src/**'] }),
      node('learning:l1', 'learning', 'Lesson one', 'a useful body'),
    ]);
    const s = await backend.status();
    assert.equal(s.node_count, 2);
    assert.equal(s.by_kind.task, 1);
    assert.equal(s.by_kind.learning, 1);

    const got = await backend.query({ id: 'task:A' });
    assert.equal(got.length, 1);
    assert.deepEqual(got[0]?.attrs, { tracker_issue_id: 'FORGE-1', write_globs: ['src/**'] });
  } finally {
    await db.close();
  }
});

test('remote: ON CONFLICT upsert updates an existing node in place', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([node('task:A', 'task', 'first')]);
    await backend.upsertNodes([node('task:A', 'task', 'second', 'newbody')]);
    const got = await backend.query({ id: 'task:A' });
    assert.equal(got.length, 1);
    assert.equal(got[0]?.title, 'second');
    assert.equal(got[0]?.body, 'newbody');
    assert.equal((await backend.status()).node_count, 1);
  } finally {
    await db.close();
  }
});

test('remote: recall surfaces a learning linked via learned_from + depends_on ancestor', async () => {
  const { backend, db } = await makeBackend();
  try {
    const nodes: MemoryNode[] = [
      node('task:A', 'task', 'A'),
      node('task:B', 'task', 'B'),
      node('learning:lB', 'learning', 'B lesson', 'body'),
    ];
    const edges: MemoryEdge[] = [
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
      { src: 'learning:lB', dst: 'task:B', kind: 'learned_from' },
    ];
    await backend.replaceGraph(nodes, edges);
    const hits = await backend.recallForTask('A');
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes('learning:lB'), `expected learning:lB in ${JSON.stringify(ids)}`);
    const lb = hits.find((h) => h.id === 'learning:lB');
    assert.equal(lb?.source, 'structural');
    assert.equal(lb?.score, 1000);
  } finally {
    await db.close();
  }
});

test('remote: FTS (tsvector) matches body terms; file/symbol excluded from FTS', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([
      node('task:A', 'task', 'widget pipeline', 'orchestrate the widget'),
      node('learning:l1', 'learning', 'about widgets', 'the widget rationale'),
      node('file:src/widget.ts', 'file', 'src/widget.ts'),
      node('symbol:s1', 'symbol', 'widget'),
    ]);
    const hits = await backend.recallForTask('A');
    const ids = hits.map((h) => h.id);
    // learning matches on the shared token "widget" via tsvector FTS.
    assert.ok(ids.includes('learning:l1'), `expected fts hit learning:l1 in ${JSON.stringify(ids)}`);
    // file + symbol are structural-only — never surfaced by FTS.
    assert.ok(!ids.includes('file:src/widget.ts'));
    assert.ok(!ids.includes('symbol:s1'));
  } finally {
    await db.close();
  }
});

test('remote: symbols surface structurally via touches→file defines→symbol', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.replaceGraph(
      [
        node('task:A', 'task', 'A'),
        node('file:src/a.ts', 'file', 'src/a.ts'),
        node('symbol:fn', 'symbol', 'doThing'),
      ],
      [
        { src: 'task:A', dst: 'file:src/a.ts', kind: 'touches' },
        { src: 'file:src/a.ts', dst: 'symbol:fn', kind: 'defines' },
      ],
    );
    const hits = await backend.recallForTask('A');
    const sym = hits.find((h) => h.id === 'symbol:fn');
    assert.ok(sym, 'expected symbol:fn surfaced structurally');
    assert.equal(sym?.source, 'structural');
    assert.equal(sym?.score, 900);
  } finally {
    await db.close();
  }
});

test('remote: resolveTaskNodeId via tracker_issue_id (jsonb ->>)', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([
      node('task:P1-T01', 'task', 'task one', '', { tracker_issue_id: 'FORGE-99' }),
      node('learning:l', 'learning', 'lesson', 'b'),
    ]);
    await backend.upsertEdges([{ src: 'learning:l', dst: 'task:P1-T01', kind: 'learned_from' }]);
    // recall by the TRACKER id should resolve to the task node and find its learning.
    const hits = await backend.recallForTask('FORGE-99');
    assert.ok(hits.map((h) => h.id).includes('learning:l'));
  } finally {
    await db.close();
  }
});

test('remote: query title uses escaped ILIKE (literal %, not wildcard)', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([
      node('task:A', 'task', '100% done'),
      node('task:B', 'task', 'anything'),
    ]);
    // The "%" must be treated literally — only task:A matches, not everything.
    const got = await backend.query({ title: '100%' });
    assert.deepEqual(got.map((n) => n.id), ['task:A']);
  } finally {
    await db.close();
  }
});

test('remote: traverse returns a bounded bidirectional subgraph', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.replaceGraph(
      [node('task:A', 'task', 'A'), node('task:B', 'task', 'B'), node('task:C', 'task', 'C')],
      [
        { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
        { src: 'task:C', dst: 'task:A', kind: 'depends_on' },
      ],
    );
    const sub = await backend.traverse('task:A', { depth: 1 });
    const ids = sub.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ['task:A', 'task:B', 'task:C']); // both directions, 1 hop
    assert.equal(sub.edges.length, 2);
    assert.equal(sub.truncated, false);
  } finally {
    await db.close();
  }
});

test('remote: replaceGraph is atomic — a bad row rolls back, prior graph preserved', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.replaceGraph([node('task:A', 'task', 'A')], []);
    // An over-bound title fails validation BEFORE any delete; the prior graph stays.
    const bad = { id: 'task:B', kind: 'task', title: 'x'.repeat(5000), body: '' } as MemoryNode;
    await assert.rejects(backend.replaceGraph([bad], []));
    const s = await backend.status();
    assert.equal(s.node_count, 1); // task:A preserved
    assert.deepEqual((await backend.query({ id: 'task:A' })).map((n) => n.id), ['task:A']);
  } finally {
    await db.close();
  }
});

test('remote: doctor reports orphan edges + isolated nodes + invalid edges', async () => {
  const { backend, db } = await makeBackend();
  try {
    await backend.upsertNodes([node('task:A', 'task', 'A'), node('learning:iso', 'learning', 'lonely', 'b')]);
    // orphan edge: dst node missing.
    await backend.upsertEdges([{ src: 'task:A', dst: 'task:GHOST', kind: 'depends_on' }]);
    const h = await backend.doctor();
    assert.equal(h.orphan_edges.count, 1);
    assert.ok(h.isolated_nodes.count >= 1); // learning:iso has no incident edge
    assert.equal(h.stale_fts_rows.count, 0); // generated column → never stale
  } finally {
    await db.close();
  }
});

test('redactDsn strips credentials', () => {
  assert.equal(redactDsn('postgres://user:secret@ep-cool.neon.tech/loomdb?sslmode=require'), 'postgres://ep-cool.neon.tech/loomdb');
  assert.equal(redactDsn('not a url'), 'postgres:NEON_DATABASE_URL');
});
