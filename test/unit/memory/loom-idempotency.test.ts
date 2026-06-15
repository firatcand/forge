import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openLocalBackend } from '../../../src/memory/local/backend.ts';
import { openDb } from '../../../src/memory/local/db.ts';
import { reindex } from '../../../src/memory/ingest.ts';

const FIXTURE_PHASES = `project: idem-fixture
phases:
  - id: phase-1
    name: Phase one
    status: active
    goal: build things
    gate_criteria:
      - it works
    tasks:
      - id: P1-T01
        tracker_issue_id: FX-1
        title: First task
        description: do the first thing
        type: backend
        priority: P1
        estimate: M
        owner_type: backend-dev
        acceptance:
          - done
        write_globs:
          - src/a/**
      - id: P1-T02
        title: Second task
        description: depends on first
        type: backend
        priority: P1
        estimate: S
        owner_type: backend-dev
        depends_on:
          - P1-T01
        acceptance:
          - done
`;

// Snapshot the LOGICAL rows (nodes + edges), NOT FTS shadow tables / rowids.
function snapshot(dbPath: string): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  return openDb(dbPath).then(({ db }) => {
    const nodes = db
      .prepare('SELECT id, kind, title, body, attrs FROM nodes ORDER BY id')
      .all();
    const edges = db
      .prepare('SELECT src, dst, kind FROM edges ORDER BY src, dst, kind')
      .all();
    db.close();
    return { nodes, edges };
  });
}

test('reindex is idempotent: two runs produce identical logical nodes+edges', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'loom-idem-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), FIXTURE_PHASES);
  const dbPath = join(repoRoot, '.forge', 'loom.db');

  try {
    const b1 = await openLocalBackend(dbPath);
    const r1 = await reindex({ repoRoot, backend: b1 });
    b1.close();
    const snap1 = await snapshot(dbPath);

    const b2 = await openLocalBackend(dbPath);
    const r2 = await reindex({ repoRoot, backend: b2 });
    b2.close();
    const snap2 = await snapshot(dbPath);

    assert.deepEqual(snap2, snap1, 'logical graph must be identical across reindex runs');
    assert.equal(r1.nodes, r2.nodes);
    assert.equal(r1.edges, r2.edges);
    // 2 task nodes, 1 depends_on edge, 0 learnings (no docs/learnings dir).
    assert.equal(r1.nodes, 2);
    assert.equal(r1.edges, 1);
    assert.equal(r1.learning_nodes, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reindex caps over-long source text instead of throwing (B2 ingest side)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'loom-cap-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  // A description far larger than MAX_BODY_LEN (100_000) — ingest must truncate
  // so the upsertNodes bounds gate accepts it, not crash the whole reindex.
  const hugeDesc = 'z'.repeat(250_000);
  const phases = `project: cap-fixture
phases:
  - id: phase-1
    name: P
    status: active
    goal: g
    gate_criteria:
      - c
    tasks:
      - id: P1-T01
        title: Big task
        description: ${hugeDesc}
        type: backend
        priority: P1
        estimate: M
        owner_type: backend-dev
        acceptance:
          - done
`;
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), phases);
  const dbPath = join(repoRoot, '.forge', 'loom.db');
  try {
    const b = await openLocalBackend(dbPath);
    const r = await reindex({ repoRoot, backend: b }); // must NOT throw
    assert.equal(r.nodes, 1);
    const snap = await snapshot(dbPath);
    const node = snap.nodes[0] as { body: string };
    assert.ok(node.body.length <= 100_000, `body must be capped, got ${node.body.length}`);
    b.close();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('reindex links learned_from edges by phases id and tracker id, tolerating unknown refs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'loom-idem2-'));
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), FIXTURE_PHASES);
  mkdirSync(join(repoRoot, 'docs', 'learnings', '2026-Q2'), { recursive: true });
  // Frontmatter references one phases id, one tracker id, and one unknown.
  writeFileSync(
    join(repoRoot, 'docs', 'learnings', '2026-Q2', 'lesson.md'),
    `---\ntitle: A lesson\ntasks:\n  - P1-T01\n  - FX-1\n  - NOPE-9\n---\n# A lesson\nbody text\n`,
  );
  const dbPath = join(repoRoot, '.forge', 'loom.db');
  try {
    const b = await openLocalBackend(dbPath);
    const r = await reindex({ repoRoot, backend: b });
    // learning node present; learned_from edges: P1-T01 (direct) + FX-1 (tracker→P1-T01).
    // NOPE-9 is unknown → no edge + a warning.
    assert.equal(r.learning_nodes, 1);
    const hits = b.recallForTask('P1-T01');
    b.close();
    assert.ok(hits.some((h) => h.id === 'learning:docs/learnings/2026-Q2/lesson.md'));
    assert.ok(r.warnings.some((w) => /NOPE-9/.test(w)), 'expected a warning about the unknown ref');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
