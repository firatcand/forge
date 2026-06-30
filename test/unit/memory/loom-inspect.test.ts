// FORGE-227: symbol recall surfacing + the query/traverse/doctor backend methods.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBackend, LocalMemoryBackend } from '../../../src/memory/local/backend.ts';
import { openDb } from '../../../src/memory/local/db.ts';
import type { MemoryEdge, MemoryNode } from '../../../src/schemas/memory.ts';

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'loom-inspect-'));
  return { dbPath: join(dir, 'loom.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── symbol recall (item 1) ────────────────────────────────────────────────────

test('recall surfaces symbols defined in scope-touched files, ranked below learnings', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: 'alpha' },
      { id: 'file:src/a.ts', kind: 'file', title: 'src/a.ts', body: '' },
      { id: 'file:src/other.ts', kind: 'file', title: 'src/other.ts', body: '' },
      { id: 'symbol:s1', kind: 'symbol', title: 'doThing', body: '' },
      { id: 'symbol:s2', kind: 'symbol', title: 'untouchedFn', body: '' },
      { id: 'learning:l1', kind: 'learning', title: 'Lesson', body: 'wisdom' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'file:src/a.ts', kind: 'touches' },
      { src: 'file:src/a.ts', dst: 'symbol:s1', kind: 'defines' },
      // s2 is defined in a file the scope never touched → must NOT surface.
      { src: 'file:src/other.ts', dst: 'symbol:s2', kind: 'defines' },
      { src: 'learning:l1', dst: 'task:A', kind: 'learned_from' },
    ]);
    const hits = await backend.recallForTask('A');
    const sym = hits.find((h) => h.id === 'symbol:s1');
    assert.ok(sym, 'symbol from the touched file should surface');
    assert.equal(sym!.kind, 'symbol');
    assert.equal(sym!.source, 'structural');
    assert.match(sym!.why, /touches→src\/a\.ts defines/);
    // Ranked below the learning.
    const learn = hits.find((h) => h.id === 'learning:l1');
    assert.ok(learn && learn.score > sym!.score, 'learning must rank above symbol');
    // The untouched-file symbol is absent.
    assert.equal(hits.find((h) => h.id === 'symbol:s2'), undefined);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('recall caps symbols per touched file', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    const nodes: MemoryNode[] = [
      { id: 'task:A', kind: 'task', title: 'A', body: 'alpha' },
      { id: 'file:src/big.ts', kind: 'file', title: 'src/big.ts', body: '' },
    ];
    const edges: MemoryEdge[] = [{ src: 'task:A', dst: 'file:src/big.ts', kind: 'touches' }];
    for (let i = 0; i < 30; i += 1) {
      const id = `symbol:big${String(i).padStart(2, '0')}`;
      nodes.push({ id, kind: 'symbol', title: `fn${i}`, body: '' });
      edges.push({ src: 'file:src/big.ts', dst: id, kind: 'defines' });
    }
    await backend.upsertNodes(nodes);
    await backend.upsertEdges(edges);
    const hits = await backend.recallForTask('A', { limit: 1000 });
    const symHits = hits.filter((h) => h.kind === 'symbol');
    assert.equal(symHits.length, 20, 'per-file symbol cap is 20');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('recall drops a corrupt (over-bound) symbol row instead of surfacing it', async () => {
  const { dbPath, cleanup } = tmpDb();
  const open = await openDb(dbPath);
  const backend = new LocalMemoryBackend(open);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: 'alpha' },
      { id: 'file:src/a.ts', kind: 'file', title: 'src/a.ts', body: '' },
    ]);
    await backend.upsertEdges([{ src: 'task:A', dst: 'file:src/a.ts', kind: 'touches' }]);
    // Inject a symbol whose title exceeds the schema bound (512) directly, then
    // wire it as defined in the touched file. recall must NOT surface it.
    open.db
      .prepare('INSERT INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)')
      .run('symbol:bad', 'symbol', 'x'.repeat(600), '', null);
    open.db
      .prepare('INSERT INTO edges(src, dst, kind) VALUES(?, ?, ?)')
      .run('file:src/a.ts', 'symbol:bad', 'defines');
    const hits = await backend.recallForTask('A');
    assert.equal(hits.find((h) => h.id === 'symbol:bad'), undefined, 'corrupt row dropped, not surfaced');
  } finally {
    await backend.close();
    cleanup();
  }
});

// ── query (item 3) ────────────────────────────────────────────────────────────

test('query filters by id, kind, and escaped title substring', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Plain title', body: '' },
      { id: 'task:B', kind: 'task', title: 'has a % literal', body: '' },
      { id: 'learning:l1', kind: 'learning', title: 'Lesson learned', body: '' },
    ]);
    // exact id
    assert.deepEqual((await backend.query({ id: 'task:A' })).map((n) => n.id), ['task:A']);
    // kind filter (sorted by id)
    assert.deepEqual((await backend.query({ kind: 'task' })).map((n) => n.id), ['task:A', 'task:B']);
    // title substring with a LIKE wildcard — must be treated literally, so `%`
    // matches ONLY the node whose title actually contains a percent sign.
    const pct = await backend.query({ title: '%' });
    assert.deepEqual(pct.map((n) => n.id), ['task:B'], 'wildcard % must be escaped to a literal');
    // case-insensitive
    assert.deepEqual((await backend.query({ title: 'lesson' })).map((n) => n.id), ['learning:l1']);
    // limit clamps
    assert.equal((await backend.query({ kind: 'task', limit: 1 })).length, 1);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('query fails loud on a corrupt node row', async () => {
  const { dbPath, cleanup } = tmpDb();
  const open = await openDb(dbPath);
  const backend = new LocalMemoryBackend(open);
  try {
    // Inject a row with an unknown kind directly (bypassing the write-time gate).
    open.db
      .prepare('INSERT INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)')
      .run('weird:1', 'bogus', 'x', '', null);
    await assert.rejects(backend.query({ id: 'weird:1' }), /invalid|enum|kind/i);
  } finally {
    await backend.close();
    cleanup();
  }
});

// ── traverse (item 3) ─────────────────────────────────────────────────────────

test('traverse returns a bounded subgraph honoring depth and excluding dangling edges', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: '' },
      { id: 'task:B', kind: 'task', title: 'B', body: '' },
      { id: 'task:C', kind: 'task', title: 'C', body: '' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
      { src: 'task:B', dst: 'task:C', kind: 'depends_on' },
      { src: 'task:C', dst: 'task:A', kind: 'depends_on' }, // cycle — must not loop
      { src: 'task:A', dst: 'task:ghost', kind: 'depends_on' }, // dangling
    ]);
    const d1 = await backend.traverse('task:A', { depth: 1 });
    assert.deepEqual(d1.nodes.map((n) => n.id).sort(), ['task:A', 'task:B', 'task:C']); // C is reachable inbound (C→A) at 1 hop
    // ghost never appears as a node; no edge references it.
    assert.ok(!d1.nodes.some((n) => n.id === 'task:ghost'));
    assert.ok(!d1.edges.some((e) => e.dst === 'task:ghost'), 'dangling edge excluded');
    // edges only connect present nodes.
    for (const e of d1.edges) {
      assert.ok(d1.nodes.some((n) => n.id === e.src) && d1.nodes.some((n) => n.id === e.dst));
    }
    // ALL internal edges are captured, including the back-edge of the cycle —
    // never silently dropped.
    assert.equal(d1.edges.length, 3);
    assert.ok(d1.edges.some((e) => e.src === 'task:C' && e.dst === 'task:A'), 'back-edge captured');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('traverse caps nodes and flags truncation', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    const nodes = [{ id: 'task:hub', kind: 'task' as const, title: 'hub', body: '' }];
    const edges: Array<{ src: string; dst: string; kind: 'touches' }> = [];
    for (let i = 0; i < 10; i += 1) {
      const id = `file:f${i}`;
      nodes.push({ id, kind: 'task', title: `f${i}`, body: '' });
      edges.push({ src: 'task:hub', dst: id, kind: 'touches' });
    }
    await backend.upsertNodes(nodes);
    await backend.upsertEdges(edges);
    const sub = await backend.traverse('task:hub', { depth: 1, limit: 3 });
    assert.ok(sub.nodes.length <= 3, 'node cap honored');
    assert.equal(sub.truncated, true, 'truncation flagged when cap hit');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('traverse counts DISTINCT neighbors, not raw edge rows (parallel edge kinds)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    const nodes: MemoryNode[] = [{ id: 'task:root', kind: 'task', title: 'root', body: '' }];
    const edges: MemoryEdge[] = [];
    const kinds: MemoryEdge['kind'][] = [
      'depends_on',
      'learned_from',
      'touches',
      'defines',
      'decided_in',
      'affects',
    ];
    // 50 distinct neighbors, each connected by all 6 edge kinds (300 raw rows).
    for (let i = 0; i < 50; i += 1) {
      const id = `task:n${String(i).padStart(2, '0')}`;
      nodes.push({ id, kind: 'task', title: id, body: '' });
      for (const kind of kinds) edges.push({ src: 'task:root', dst: id, kind });
    }
    await backend.upsertNodes(nodes);
    await backend.upsertEdges(edges);
    const sub = await backend.traverse('task:root', { depth: 1, limit: 200 });
    // All 50 neighbors + root must be present; the raw-row count (300) must not
    // truncate distinct-neighbor discovery.
    assert.equal(sub.nodes.length, 51);
    assert.equal(sub.truncated, false);
    assert.ok(sub.nodes.some((n) => n.id === 'task:n49'));
  } finally {
    await backend.close();
    cleanup();
  }
});

test('traverse returns empty for an absent node', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([{ id: 'task:A', kind: 'task', title: 'A', body: '' }]);
    const sub = await backend.traverse('task:nope');
    assert.deepEqual(sub.nodes, []);
    assert.deepEqual(sub.edges, []);
  } finally {
    await backend.close();
    cleanup();
  }
});

// ── doctor (item 3) ───────────────────────────────────────────────────────────

test('doctor reports orphan edges, isolated nodes, stale fts rows, and invalid rows', async () => {
  const { dbPath, cleanup } = tmpDb();
  const open = await openDb(dbPath);
  const backend = new LocalMemoryBackend(open);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: 'body' },
      { id: 'task:B', kind: 'task', title: 'B', body: 'body' },
      { id: 'learning:iso', kind: 'learning', title: 'Lonely', body: 'no edges' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' }, // valid
      { src: 'task:A', dst: 'task:ghost', kind: 'depends_on' }, // orphan (missing dst)
    ]);
    // Inject directly (bypassing the write-time gate): a stale FTS row (no backing
    // node), an invalid node row (unknown kind), and an invalid edge between two
    // EXISTING nodes (unknown kind — would later make traverse throw).
    open.db.prepare('INSERT INTO nodes_fts(id, title, body) VALUES(?, ?, ?)').run('ghostfts:1', 't', 'b');
    open.db
      .prepare('INSERT INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)')
      .run('weird:1', 'bogus', 'x', '', null);
    open.db
      .prepare('INSERT INTO edges(src, dst, kind) VALUES(?, ?, ?)')
      .run('task:A', 'task:B', 'bogus_kind');

    const health = await backend.doctor();
    assert.equal(health.orphan_edges.count, 1);
    assert.deepEqual(health.orphan_edges.sample[0], {
      src: 'task:A',
      dst: 'task:ghost',
      kind: 'depends_on',
    });
    // learning:iso and weird:1 have no edges → isolated.
    assert.ok(health.isolated_nodes.sample.includes('learning:iso'));
    assert.equal(health.stale_fts_rows.count, 1);
    assert.equal(health.stale_fts_rows.sample[0], 'ghostfts:1');
    assert.equal(health.invalid_rows.count, 1);
    assert.equal(health.invalid_rows.sample[0], 'weird:1');
    assert.equal(health.invalid_edges.count, 1);
    assert.deepEqual(health.invalid_edges.sample[0], {
      src: 'task:A',
      dst: 'task:B',
      kind: 'bogus_kind',
    });
    assert.equal(health.nodes_by_kind.task, 2);
    // The unknown-kind node falls into the bounded `<unknown>` bucket; the bad
    // edge kind into the edge `<unknown>` bucket. Known kinds stay fixed-size.
    assert.equal(health.nodes_by_kind['<unknown>'], 1);
    assert.equal(health.edges_by_kind['<unknown>'], 1);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('doctor does not throw on a row with a NULL id (reports it instead)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const open = await openDb(dbPath);
  const backend = new LocalMemoryBackend(open);
  try {
    // SQLite permits a NULL in a TEXT PRIMARY KEY column. doctor must report this
    // as an invalid row, never crash on the corruption it exists to diagnose.
    open.db
      .prepare('INSERT INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)')
      .run(null, 'task', 't', 'b', null);
    const health = await backend.doctor();
    assert.ok(health.invalid_rows.count >= 1, 'NULL-id row reported as invalid');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('doctor on a clean graph reports no problems', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: 'b' },
      { id: 'task:B', kind: 'task', title: 'B', body: 'b' },
    ]);
    await backend.upsertEdges([{ src: 'task:A', dst: 'task:B', kind: 'depends_on' }]);
    const health = await backend.doctor();
    assert.equal(health.orphan_edges.count, 0);
    assert.equal(health.isolated_nodes.count, 0);
    assert.equal(health.stale_fts_rows.count, 0);
    assert.equal(health.invalid_rows.count, 0);
    assert.equal(health.invalid_edges.count, 0);
  } finally {
    await backend.close();
    cleanup();
  }
});
