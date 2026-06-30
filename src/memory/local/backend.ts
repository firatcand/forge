// FORGE-200 (Loom I1): the local SQLite memory backend.
//
// Implements MemoryBackend over db.ts. All writes are wrapped in explicit
// transactions (BEGIN/COMMIT with rollback on throw) so a partial reindex / a
// concurrent writer never leaves a torn graph.
//
// FORGE-228 (Loom I4): the parity-critical recall + traverse ALGORITHMS moved to
// src/memory/graph.ts (shared with the Postgres backend) and run over the
// GraphReadPrimitives this class implements. The MemoryBackend method surface is
// async (a remote/serverless backend cannot be synchronous); the SQLite bodies
// stay synchronous and are simply wrapped by async methods.

import {
  EDGE_KINDS,
  MemoryEdgeSchema,
  MemoryNodeSchema,
  NODE_KINDS,
  type EdgeKind,
  type MemoryEdge,
  type MemoryNode,
  type NodeKind,
  type RecallHit,
} from '../../schemas/memory.ts';
import type {
  GraphHealth,
  GraphSubgraph,
  MemoryBackend,
  MemoryStatus,
  QueryFilter,
  RecallOptions,
  TraverseOptions,
} from '../types.ts';
import {
  clampLimit,
  clip,
  escapeLike,
  recallForTask as sharedRecall,
  rowToNode,
  tokenizeFtsTerms,
  traverseGraph as sharedTraverse,
  type GraphReadPrimitives,
  type NodeRow,
  DEFAULT_QUERY_LIMIT,
  DOCTOR_SAMPLE_CAP,
  DOCTOR_SCAN_PAGE,
  MAX_QUERY_LIMIT,
} from '../graph.ts';
import { openDb, type OpenDb, type SqliteDatabase } from './db.ts';

// Build a SAFE FTS5 MATCH query from arbitrary text. The tokenization is shared
// (graph.tokenizeFtsTerms — lowercase, split on non-alnum, drop bareword
// operators); here each surviving term is wrapped as a quoted literal token and
// OR-joined. Returns '' when nothing usable remains (caller skips FTS). Exported
// for the FTS-escape test.
export function buildFtsQuery(text: string): string {
  const terms = tokenizeFtsTerms(text);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"`).join(' OR ');
}

export class LocalMemoryBackend implements MemoryBackend, GraphReadPrimitives {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;

  constructor(open: OpenDb) {
    this.db = open.db;
    this.dbPath = open.dbPath;
  }

  // ── transaction helper ─────────────────────────────────────────────────────
  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The rollback itself failed (e.g. no active txn); surface the original.
      }
      throw err;
    }
  }

  async reset(): Promise<void> {
    this.tx(() => {
      this.db.exec('DELETE FROM nodes;');
      this.db.exec('DELETE FROM edges;');
      this.db.exec('DELETE FROM nodes_fts;');
    });
  }

  async upsertNodes(nodes: readonly MemoryNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const insNode = this.db.prepare(
      'INSERT OR REPLACE INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)',
    );
    const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE id = ?');
    const insFts = this.db.prepare('INSERT INTO nodes_fts(id, title, body) VALUES(?, ?, ?)');
    this.tx(() => {
      for (const node of nodes) {
        // Fail-closed enforcement gate: re-validate every node before it touches
        // SQLite/FTS (bounded id/title/body, strict keys).
        const valid = assertValidNode(node);
        const attrs = valid.attrs !== undefined ? JSON.stringify(valid.attrs) : null;
        insNode.run(valid.id, valid.kind, valid.title, valid.body, attrs);
        // Keep the FTS shadow in sync: delete any prior row, then insert fresh.
        // file + symbol nodes are structural-only (path / bare-identifier titles
        // would pollute full-text recall) — never indexed, always cleared.
        delFts.run(valid.id);
        if (valid.kind !== 'file' && valid.kind !== 'symbol') {
          insFts.run(valid.id, valid.title, valid.body);
        }
      }
    });
  }

  async upsertEdges(edges: readonly MemoryEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const insEdge = this.db.prepare('INSERT OR REPLACE INTO edges(src, dst, kind) VALUES(?, ?, ?)');
    this.tx(() => {
      for (const edge of edges) {
        const valid = assertValidEdge(edge);
        insEdge.run(valid.src, valid.dst, valid.kind);
      }
    });
  }

  // Atomic rebuild: VALIDATE every node+edge FIRST (before touching the DB), then
  // delete-all + insert-all inside ONE transaction. A validation throw happens
  // before any delete, and any later throw rolls back — so reindex can never wipe
  // the prior graph and then fail.
  async replaceGraph(nodes: readonly MemoryNode[], edges: readonly MemoryEdge[]): Promise<void> {
    const validNodes = nodes.map((n) => assertValidNode(n));
    const validEdges = edges.map((e) => assertValidEdge(e));

    const insNode = this.db.prepare(
      'INSERT OR REPLACE INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)',
    );
    const insFts = this.db.prepare('INSERT INTO nodes_fts(id, title, body) VALUES(?, ?, ?)');
    const insEdge = this.db.prepare('INSERT OR REPLACE INTO edges(src, dst, kind) VALUES(?, ?, ?)');
    this.tx(() => {
      this.db.exec('DELETE FROM nodes;');
      this.db.exec('DELETE FROM edges;');
      this.db.exec('DELETE FROM nodes_fts;');
      for (const node of validNodes) {
        const attrs = node.attrs !== undefined ? JSON.stringify(node.attrs) : null;
        insNode.run(node.id, node.kind, node.title, node.body, attrs);
        if (node.kind !== 'file' && node.kind !== 'symbol') {
          insFts.run(node.id, node.title, node.body);
        }
      }
      for (const edge of validEdges) {
        insEdge.run(edge.src, edge.dst, edge.kind);
      }
    });
  }

  async status(): Promise<MemoryStatus> {
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
    const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
    const byKindRows = this.db
      .prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; c: number }>;
    const by_kind: Record<string, number> = { task: 0, learning: 0, file: 0, symbol: 0, decision: 0 };
    for (const row of byKindRows) by_kind[row.kind] = row.c;
    return { node_count: total.c, edge_count: edgeCount.c, by_kind, db_path: this.dbPath };
  }

  // FORGE-227: ad-hoc node lookup. Filters (id / kind / title-substring) AND
  // together; title uses an escaped LIKE so wildcards are literal. Rows are
  // validated on the way out (corrupt row throws).
  async query(filter: QueryFilter): Promise<MemoryNode[]> {
    const limit = clampLimit(filter.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.id !== undefined) {
      where.push('id = ?');
      params.push(filter.id);
    }
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.title !== undefined) {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filter.title)}%`);
    }
    const sql =
      'SELECT id, kind, title, body, attrs FROM nodes' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY id LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((r) => rowToNode(r));
  }

  async recallForTask(taskId: string, opts?: RecallOptions): Promise<RecallHit[]> {
    return sharedRecall(this, taskId, opts);
  }

  async traverse(nodeId: string, opts?: TraverseOptions): Promise<GraphSubgraph> {
    return sharedTraverse(this, nodeId, opts);
  }

  // FORGE-227: graph health report. Counts + structural-integrity checks run as
  // SET-BASED SQL so the whole graph is never materialized in JS; schema-validation
  // scans page through the tables. Every sample is capped. Read-only.
  async doctor(): Promise<GraphHealth> {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;

    const node_count = count('SELECT COUNT(*) AS c FROM nodes');
    const edge_count = count('SELECT COUNT(*) AS c FROM edges');
    const nodes_by_kind = this.countByKind('nodes', NODE_KINDS);
    const edges_by_kind = this.countByKind('edges', EDGE_KINDS);

    const orphanWhere =
      'NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.src) ' +
      'OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.dst)';
    const orphanCount = count(`SELECT COUNT(*) AS c FROM edges WHERE ${orphanWhere}`);
    const orphanSample = (
      this.db
        .prepare(`SELECT src, dst, kind FROM edges WHERE ${orphanWhere} ORDER BY src, dst, kind LIMIT ?`)
        .all(DOCTOR_SAMPLE_CAP) as Array<{ src: string; dst: string; kind: string }>
    ).map((r) => ({ src: clip(r.src), dst: clip(r.dst), kind: clip(r.kind) }));

    const isoWhere = 'NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = nodes.id OR e.dst = nodes.id)';
    const isolatedCount = count(`SELECT COUNT(*) AS c FROM nodes WHERE ${isoWhere}`);
    const isolatedSample = (
      this.db.prepare(`SELECT id FROM nodes WHERE ${isoWhere} ORDER BY id LIMIT ?`).all(DOCTOR_SAMPLE_CAP) as Array<{
        id: string;
      }>
    ).map((r) => clip(r.id));

    const staleWhere = 'NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = nodes_fts.id)';
    const staleCount = count(`SELECT COUNT(*) AS c FROM nodes_fts WHERE ${staleWhere}`);
    const staleSample = (
      this.db
        .prepare(`SELECT id FROM nodes_fts WHERE ${staleWhere} ORDER BY id LIMIT ?`)
        .all(DOCTOR_SAMPLE_CAP) as Array<{ id: string }>
    ).map((r) => clip(r.id));

    const invalidNodes = this.scanInvalidNodes();
    const invalidEdges = this.scanInvalidEdges();

    return {
      node_count,
      edge_count,
      nodes_by_kind,
      edges_by_kind,
      orphan_edges: { count: orphanCount, sample: orphanSample },
      isolated_nodes: { count: isolatedCount, sample: isolatedSample },
      stale_fts_rows: { count: staleCount, sample: staleSample },
      invalid_rows: { count: invalidNodes.count, sample: invalidNodes.sample },
      invalid_edges: { count: invalidEdges.count, sample: invalidEdges.sample },
      db_path: this.dbPath,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ── GraphReadPrimitives (the dialect surface recall/traverse run over) ──────────

  async getNode(id: string): Promise<NodeRow | undefined> {
    const row = this.db
      .prepare('SELECT id, kind, title, body, attrs FROM nodes WHERE id = ?')
      .get(id) as NodeRow | undefined;
    return row ?? undefined;
  }

  async edgesFrom(kind: EdgeKind, src: string, limit?: number): Promise<string[]> {
    const sql =
      'SELECT dst FROM edges WHERE kind = ? AND src = ? ORDER BY dst' +
      (limit !== undefined ? ' LIMIT ?' : '');
    const rows = (
      limit !== undefined
        ? this.db.prepare(sql).all(kind, src, limit)
        : this.db.prepare(sql).all(kind, src)
    ) as Array<{ dst: string }>;
    return rows.map((r) => r.dst);
  }

  async edgesTo(kind: EdgeKind, dst: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT src FROM edges WHERE kind = ? AND dst = ? ORDER BY src')
      .all(kind, dst) as Array<{ src: string }>;
    return rows.map((r) => r.src);
  }

  async nodeIdsByKind(kind: NodeKind): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM nodes WHERE kind = ? ORDER BY id')
      .all(kind) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // Resolve a task reference to its node id. Order: already-prefixed `task:<id>`,
  // bare phases id `task:<input>`, then a tracker_issue_id match (json_extract).
  async resolveTaskNodeId(input: string): Promise<string | undefined> {
    if (input.startsWith('task:')) {
      const row = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(input) as
        | { id: string }
        | undefined;
      return row ? input : undefined;
    }
    const direct = `task:${input}`;
    const directRow = this.db.prepare('SELECT id FROM nodes WHERE id = ?').get(direct) as
      | { id: string }
      | undefined;
    if (directRow) return direct;
    const row = this.db
      .prepare(
        "SELECT id FROM nodes WHERE kind = 'task' AND json_extract(attrs, '$.tracker_issue_id') = ? LIMIT 1",
      )
      .get(input) as { id: string } | undefined;
    return row?.id;
  }

  async ftsSearch(terms: string[]): Promise<string[]> {
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare('SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank')
        .all(ftsQuery) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch (err) {
      // A MATCH syntax error means tokenization let something through — fail loud.
      throw new Error(
        `loom: FTS query failed (query: ${ftsQuery}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async distinctOutNeighbors(id: string, cap: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT dst AS n FROM edges WHERE src = ? ORDER BY dst LIMIT ?')
      .all(id, cap) as Array<{ n: string }>;
    return rows.map((r) => r.n);
  }

  async distinctInNeighbors(id: string, cap: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT DISTINCT src AS n FROM edges WHERE dst = ? ORDER BY src LIMIT ?')
      .all(id, cap) as Array<{ n: string }>;
    return rows.map((r) => r.n);
  }

  async internalEdges(
    ids: string[],
    limit: number,
  ): Promise<Array<{ src: string; dst: string; kind: string }>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT src, dst, kind FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders}) ` +
          'ORDER BY src, dst, kind LIMIT ?',
      )
      .all(...ids, ...ids, limit) as Array<{ src: string; dst: string; kind: string }>;
  }

  // ── doctor internals ───────────────────────────────────────────────────────────
  private scanInvalidNodes(): { count: number; sample: string[] } {
    const sel = this.db.prepare(
      'SELECT id, kind, title, body, attrs FROM nodes ORDER BY id LIMIT ? OFFSET ?',
    );
    let count = 0;
    const sample: string[] = [];
    let offset = 0;
    for (;;) {
      const rows = sel.all(DOCTOR_SCAN_PAGE, offset) as NodeRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        try {
          rowToNode(r);
        } catch {
          count += 1;
          if (sample.length < DOCTOR_SAMPLE_CAP) sample.push(clip(r.id));
        }
      }
      if (rows.length < DOCTOR_SCAN_PAGE) break;
      offset += DOCTOR_SCAN_PAGE;
    }
    return { count, sample };
  }

  private scanInvalidEdges(): {
    count: number;
    sample: Array<{ src: string; dst: string; kind: string }>;
  } {
    const sel = this.db.prepare(
      'SELECT src, dst, kind FROM edges ORDER BY src, dst, kind LIMIT ? OFFSET ?',
    );
    let count = 0;
    const sample: Array<{ src: string; dst: string; kind: string }> = [];
    let offset = 0;
    for (;;) {
      const rows = sel.all(DOCTOR_SCAN_PAGE, offset) as Array<{ src: string; dst: string; kind: string }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!MemoryEdgeSchema.safeParse(r).success) {
          count += 1;
          if (sample.length < DOCTOR_SAMPLE_CAP) {
            sample.push({ src: clip(r.src), dst: clip(r.dst), kind: clip(r.kind) });
          }
        }
      }
      if (rows.length < DOCTOR_SCAN_PAGE) break;
      offset += DOCTOR_SCAN_PAGE;
    }
    return { count, sample };
  }

  private countByKind(table: 'nodes' | 'edges', kinds: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const one = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE kind = ?`);
    for (const k of kinds) out[k] = (one.get(k) as { c: number }).c;
    const placeholders = kinds.map(() => '?').join(', ');
    const unknown = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE kind NOT IN (${placeholders})`)
        .get(...kinds) as { c: number }
    ).c;
    if (unknown > 0) out['<unknown>'] = unknown;
    return out;
  }
}

// Async factory: opens the DB (lazy sqlite import) and returns a ready backend.
export async function openLocalBackend(dbPath: string): Promise<MemoryBackend> {
  const open = await openDb(dbPath);
  return new LocalMemoryBackend(open);
}

// Exported for tests + the write paths: validate a node/edge before write so a
// malformed source row fails loudly rather than corrupting the graph.
export function assertValidNode(node: unknown): MemoryNode {
  return MemoryNodeSchema.parse(node);
}

export function assertValidEdge(edge: unknown): MemoryEdge {
  return MemoryEdgeSchema.parse(edge);
}
