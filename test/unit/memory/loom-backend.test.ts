import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBackend } from '../../../src/memory/local/backend.ts';
import type { MemoryBackend } from '../../../src/memory/types.ts';
import { openDb } from '../../../src/memory/local/db.ts';

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'loom-backend-'));
  return { dbPath: join(dir, 'loom.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('upsert nodes/edges then status reports counts and by_kind', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend: MemoryBackend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'A', body: 'alpha body' },
      { id: 'task:B', kind: 'task', title: 'B', body: 'beta body' },
      { id: 'learning:l1', kind: 'learning', title: 'L1', body: 'lesson one' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
      { src: 'learning:l1', dst: 'task:B', kind: 'learned_from' },
    ]);
    const s = await backend.status();
    assert.equal(s.node_count, 3);
    assert.equal(s.edge_count, 2);
    assert.equal(s.by_kind.task, 2);
    assert.equal(s.by_kind.learning, 1);
    assert.equal(s.db_path, dbPath);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('recallForTask ranks structural above fts and carries why provenance', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // A depends_on B. learning:struct is learned_from B (ancestor of A) → structural.
    // learning:fts only shares a word with A's body → fts.
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Widget pipeline', body: 'build the widget pipeline' },
      { id: 'task:B', kind: 'task', title: 'B', body: 'base task' },
      { id: 'learning:struct', kind: 'learning', title: 'Structural lesson', body: 'unrelated text' },
      { id: 'learning:fts', kind: 'learning', title: 'Widget gotcha', body: 'widget pipeline caveat' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
      { src: 'learning:struct', dst: 'task:B', kind: 'learned_from' },
    ]);
    const hits = await backend.recallForTask('A');
    assert.ok(hits.length >= 2, `expected >=2 hits, got ${hits.length}`);
    // Structural first.
    assert.equal(hits[0]!.id, 'learning:struct');
    assert.equal(hits[0]!.source, 'structural');
    assert.match(hits[0]!.why, /depends_on→B learned_from/);
    // The fts hit appears and is ranked below the structural one.
    const fts = hits.find((h) => h.id === 'learning:fts');
    assert.ok(fts, 'expected the fts hit to be present');
    assert.equal(fts!.source, 'fts');
    assert.ok(hits[0]!.score > fts!.score, 'structural score must exceed fts score');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('recallForTask returns [] for an absent task', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([{ id: 'task:A', kind: 'task', title: 'A', body: 'a' }]);
    assert.deepEqual(await backend.recallForTask('NOPE'), []);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('recallForTask resolves a tracker_issue_id, not just the phases id (B1)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // The node id is the phases id; the tracker id lives in attrs (as ingest stores it).
    await backend.upsertNodes([
      {
        id: 'task:P1-T1',
        kind: 'task',
        title: 'Build loom',
        body: 'dependency-aware recall over phases',
        attrs: { tracker_issue_id: 'FORGE-200' },
      },
      { id: 'task:P1-T2', kind: 'task', title: 'Base', body: 'base task' },
      { id: 'learning:l1', kind: 'learning', title: 'Loom lesson', body: 'x' },
    ]);
    await backend.upsertEdges([
      { src: 'task:P1-T1', dst: 'task:P1-T2', kind: 'depends_on' },
      { src: 'learning:l1', dst: 'task:P1-T1', kind: 'learned_from' },
    ]);
    // /pickup-task passes the TRACKER id — it must resolve to the same node and
    // surface the structural learning hit (previously returned []).
    const byTracker = await backend.recallForTask('FORGE-200');
    assert.ok(byTracker.some((h) => h.id === 'learning:l1' && h.source === 'structural'),
      `tracker-id recall must find the structural hit, got ${JSON.stringify(byTracker)}`);
    // Same result via the phases id and the prefixed form.
    const byPhases = await backend.recallForTask('P1-T1');
    const byPrefixed = await backend.recallForTask('task:P1-T1');
    assert.deepEqual(byTracker, byPhases);
    assert.deepEqual(byTracker, byPrefixed);
    // An unknown tracker id still returns [].
    assert.deepEqual(await backend.recallForTask('FORGE-999'), []);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('replaceGraph is atomic: a malformed node throws WITHOUT wiping the prior graph (B3)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // Seed a good graph.
    await backend.replaceGraph(
      [
        { id: 'task:A', kind: 'task', title: 'A', body: 'alpha' },
        { id: 'task:B', kind: 'task', title: 'B', body: 'beta' },
      ],
      [{ src: 'task:A', dst: 'task:B', kind: 'depends_on' }],
    );
    assert.equal((await backend.status()).node_count, 2);
    assert.equal((await backend.status()).edge_count, 1);

    // A rebuild whose node set contains an over-long title must throw BEFORE any
    // delete — the previous graph survives intact (no data loss).
    const huge = 'x'.repeat(600);
    await assert.rejects(
      backend.replaceGraph(
        [{ id: 'task:C', kind: 'task', title: huge, body: 'c' }],
        [],
      ),
    );
    const after = await backend.status();
    assert.equal(after.node_count, 2, 'prior nodes must be preserved on a failed rebuild');
    assert.equal(after.edge_count, 1, 'prior edges must be preserved on a failed rebuild');
    // And recall still works against the preserved graph.
    assert.ok(await backend.recallForTask('A') !== undefined);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('upsertNodes is a fail-closed bounds gate: an over-long node throws (B2)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    const huge = 'x'.repeat(600); // > MAX_TITLE_LEN (512)
    await assert.rejects(
      backend.upsertNodes([{ id: 'task:big', kind: 'task', title: huge, body: 'b' }]),
      /title|512|too big|String must contain at most/i,
      'an unbounded title must be rejected, not written to SQLite/FTS',
    );
    // The rejected write left no row (transaction rolled back).
    assert.equal((await backend.status()).node_count, 0);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('status reports file by_kind explicitly even at 0 (FORGE-218)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    await backend.upsertNodes([{ id: 'task:A', kind: 'task', title: 'A', body: 'a' }]);
    assert.equal((await backend.status()).by_kind.file, 0);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('co-touch recall: a co-touching task’s learning surfaces structurally (FORGE-218 B1)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // Task A touches file F. Task B touches the SAME file F and has a learning L
    // (learned_from B). A and B are NOT depends_on related — the only link is the
    // shared file. recall(A) must surface L structurally with a co-touch `why`.
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Alpha work', body: 'unrelated alpha body' },
      { id: 'task:B', kind: 'task', title: 'Beta work', body: 'unrelated beta body' },
      { id: 'file:src/shared.ts', kind: 'file', title: 'src/shared.ts', body: '' },
      { id: 'learning:l1', kind: 'learning', title: 'Shared gotcha', body: 'a lesson from B' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'file:src/shared.ts', kind: 'touches' },
      { src: 'task:B', dst: 'file:src/shared.ts', kind: 'touches' },
      { src: 'learning:l1', dst: 'task:B', kind: 'learned_from' },
    ]);
    const hits = await backend.recallForTask('A');
    const l1 = hits.find((h) => h.id === 'learning:l1');
    assert.ok(l1, `expected the co-touching learning, got ${JSON.stringify(hits)}`);
    assert.equal(l1!.source, 'structural');
    assert.match(l1!.why, /co-touched file src\/shared\.ts with task B/);
    // File nodes are NEVER returned as hits.
    assert.ok(!hits.some((h) => h.id.startsWith('file:')), 'file nodes must not be hits');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('file nodes are excluded from FTS recall (FORGE-218)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // The task body shares the word "pipeline" with a file node's path-ish title.
    // A non-file FTS match would surface; the file node must NOT (excluded at index).
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Pipeline task', body: 'build the pipeline' },
      { id: 'file:src/pipeline.ts', kind: 'file', title: 'src/pipeline.ts', body: '' },
    ]);
    const hits = await backend.recallForTask('A');
    assert.ok(!hits.some((h) => h.id === 'file:src/pipeline.ts'), 'file node must not be an FTS hit');
  } finally {
    await backend.close();
    cleanup();
  }
});

test('a task with no touches still returns I1-style depends_on + fts results (FORGE-218)', async () => {
  const { dbPath, cleanup } = tmpDb();
  const backend = await openLocalBackend(dbPath);
  try {
    // No touches edges at all → behaves exactly like I1.
    await backend.upsertNodes([
      { id: 'task:A', kind: 'task', title: 'Widget pipeline', body: 'build the widget pipeline' },
      { id: 'task:B', kind: 'task', title: 'B', body: 'base task' },
      { id: 'learning:struct', kind: 'learning', title: 'Structural lesson', body: 'unrelated text' },
    ]);
    await backend.upsertEdges([
      { src: 'task:A', dst: 'task:B', kind: 'depends_on' },
      { src: 'learning:struct', dst: 'task:B', kind: 'learned_from' },
    ]);
    const hits = await backend.recallForTask('A');
    const struct = hits.find((h) => h.id === 'learning:struct');
    assert.ok(struct, 'depends_on-ancestor learning must still surface (I1 behavior)');
    assert.equal(struct!.source, 'structural');
    assert.match(struct!.why, /depends_on→B learned_from/);
  } finally {
    await backend.close();
    cleanup();
  }
});

test('BFS depth/visited guard: a cyclic depends_on row does not loop recall', async () => {
  const { dbPath, cleanup } = tmpDb();
  // Open the raw db to inject a CORRUPT cyclic edge that PhasesSchema would reject.
  const { db } = await openDb(dbPath);
  const insNode = db.prepare('INSERT OR REPLACE INTO nodes(id,kind,title,body,attrs) VALUES(?,?,?,?,?)');
  insNode.run('task:A', 'task', 'A', 'a body', null);
  insNode.run('task:B', 'task', 'B', 'b body', null);
  const insFtsA = db.prepare('INSERT INTO nodes_fts(id,title,body) VALUES(?,?,?)');
  insFtsA.run('task:A', 'A', 'a body');
  insFtsA.run('task:B', 'B', 'b body');
  const insEdge = db.prepare('INSERT OR REPLACE INTO edges(src,dst,kind) VALUES(?,?,?)');
  // A -> B -> A : a cycle.
  insEdge.run('task:A', 'task:B', 'depends_on');
  insEdge.run('task:B', 'task:A', 'depends_on');
  db.close();

  const backend = await openLocalBackend(dbPath);
  try {
    // If the visited-set guard were missing this would loop forever.
    const hits = await backend.recallForTask('A', { maxDepth: 50 });
    assert.ok(Array.isArray(hits), 'recall terminated and returned an array');
  } finally {
    await backend.close();
    cleanup();
  }
});
