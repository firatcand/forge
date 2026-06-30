// FORGE-228 (Loom I4): the opt-in remote Postgres (Neon) memory backend.
//
// A second MemoryBackend behind createBackend(), selected by `memory.backend:
// neon`. Local SQLite stays the default; this is for a team sharing ONE portable
// graph. The parity-critical recall + traverse algorithms are SHARED (graph.ts) —
// this file only implements the dialect primitives + the simple SQL (writes,
// status, query, doctor) in Postgres.
//
// Design (per the FORGE-228 plan + Codex plan review):
//   - Driver: standard `pg` (node-postgres), lazy-imported ONLY when this backend
//     is opened — local-default users never load it ("no new HARD runtime dep").
//   - Writes: every write runs on ONE checked-out connection inside a txn guarded
//     by a session/txn-scoped `pg_advisory_xact_lock` (serializes writers like
//     SQLite's single-writer; the lock auto-releases on COMMIT/ROLLBACK/disconnect).
//   - replaceGraph: validate-all FIRST, then DELETE (NOT truncate — MVCC-safe) +
//     re-insert in the same txn, mirroring the local atomic rebuild.
//   - FTS: a generated `tsvector('simple')` column + GIN index; queries use
//     `to_tsquery('simple', …)` over the SHARED tokenizer and exclude file/symbol
//     at query time (parity with local's index-time exclusion).
//   - attrs is jsonb but always read back `::text` so a row matches the shared
//     NodeRow shape (rowToNode JSON.parses it, same as local).
//   - The pool is injectable (tests pass a PGlite-backed pool); production lazy-
//     builds a `pg.Pool` from NEON_DATABASE_URL.

import {
  MemoryEdgeSchema,
  NODE_KINDS,
  EDGE_KINDS,
  type EdgeKind,
  type MemoryEdge,
  type MemoryNode,
  type NodeKind,
  type RecallHit,
} from '../../schemas/memory.ts';
import type { Memory } from '../../schemas/settings.ts';
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
  traverseGraph as sharedTraverse,
  type GraphReadPrimitives,
  type NodeRow,
  DEFAULT_QUERY_LIMIT,
  DOCTOR_SAMPLE_CAP,
  DOCTOR_SCAN_PAGE,
  MAX_QUERY_LIMIT,
} from '../graph.ts';
import { assertValidNode, assertValidEdge } from '../local/backend.ts';

// A fixed advisory-lock key for the loom write lock. Arbitrary but stable so every
// forge process contends on the SAME lock for this graph. (FORGE-228 → 0xF06E0228.)
const ADVISORY_LOCK_KEY = 0xf06e0228;
// Rows per multi-row INSERT (keeps well under Postgres' 65535 bound: 200×5=1000).
const INSERT_CHUNK = 200;

// ── injectable pool abstraction ─────────────────────────────────────────────────
// Minimal surface the backend needs. Reads go through query(); writes check out a
// dedicated connection via withConnection() so BEGIN/advisory-lock/COMMIT all run
// on the SAME connection (Codex: pool.query() per-statement would use different
// connections and break the txn + advisory lock).
export interface PgConn {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
export interface PgPool extends PgConn {
  withConnection<T>(fn: (conn: PgConn) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export class RemoteMemoryBackend implements MemoryBackend, GraphReadPrimitives {
  constructor(
    private readonly pool: PgPool,
    private readonly location: string,
  ) {}

  // Idempotent schema bootstrap. Runs on open (NOT in the existence probe, which
  // must not create anything). The tsv column indexes ALL nodes; ftsSearch
  // excludes file/symbol at query time for parity with local.
  async bootstrap(): Promise<void> {
    await this.runWrite(async (conn) => {
      // All tables/indexes are schema-qualified `public.*` (Codex security): a
      // non-default search_path must never split bootstrap from queries or let the
      // existence probe (to_regclass('public.nodes')) check a different table than
      // reads/writes use, nor resolve a shadow table earlier in the path.
      await conn.query(`
        CREATE TABLE IF NOT EXISTS public.nodes (
          id    text PRIMARY KEY,
          kind  text NOT NULL,
          title text NOT NULL,
          body  text NOT NULL,
          attrs jsonb,
          tsv   tsvector GENERATED ALWAYS AS
                  (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED
        );
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS public.edges (
          src  text NOT NULL,
          dst  text NOT NULL,
          kind text NOT NULL,
          PRIMARY KEY (src, dst, kind)
        );
      `);
      await conn.query('CREATE INDEX IF NOT EXISTS idx_nodes_tsv ON public.nodes USING GIN (tsv);');
      await conn.query('CREATE INDEX IF NOT EXISTS idx_edges_src ON public.edges (src, kind);');
      await conn.query('CREATE INDEX IF NOT EXISTS idx_edges_dst ON public.edges (dst, kind);');
    });
  }

  // Run a write on a dedicated connection inside a txn guarded by the advisory
  // lock. Serializes all writers (parity with SQLite's single-writer); the
  // txn-scoped lock auto-releases on COMMIT/ROLLBACK/disconnect.
  private async runWrite(fn: (conn: PgConn) => Promise<void>): Promise<void> {
    await this.pool.withConnection(async (conn) => {
      await conn.query('BEGIN');
      try {
        await conn.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
        await fn(conn);
        await conn.query('COMMIT');
      } catch (err) {
        try {
          await conn.query('ROLLBACK');
        } catch {
          // rollback itself failed (e.g. broken conn); surface the original error.
        }
        throw err;
      }
    });
  }

  async reset(): Promise<void> {
    await this.runWrite(async (conn) => {
      await conn.query('DELETE FROM public.edges;');
      await conn.query('DELETE FROM public.nodes;');
    });
  }

  async upsertNodes(nodes: readonly MemoryNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const valid = nodes.map((n) => assertValidNode(n));
    await this.runWrite((conn) => insertNodes(conn, valid));
  }

  async upsertEdges(edges: readonly MemoryEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const valid = edges.map((e) => assertValidEdge(e));
    await this.runWrite((conn) => insertEdges(conn, valid));
  }

  // Atomic rebuild: validate everything FIRST (nothing written on a bad row), then
  // DELETE-all + insert-all in one txn under the advisory lock. DELETE (not
  // TRUNCATE) is MVCC-safe and matches local semantics.
  async replaceGraph(nodes: readonly MemoryNode[], edges: readonly MemoryEdge[]): Promise<void> {
    const validNodes = nodes.map((n) => assertValidNode(n));
    const validEdges = edges.map((e) => assertValidEdge(e));
    await this.runWrite(async (conn) => {
      await conn.query('DELETE FROM public.edges;');
      await conn.query('DELETE FROM public.nodes;');
      await insertNodes(conn, validNodes);
      await insertEdges(conn, validEdges);
    });
  }

  async status(): Promise<MemoryStatus> {
    const node_count = await this.count('SELECT COUNT(*)::int AS c FROM public.nodes');
    const edge_count = await this.count('SELECT COUNT(*)::int AS c FROM public.edges');
    const { rows } = await this.pool.query<{ kind: string; c: number }>(
      'SELECT kind, COUNT(*)::int AS c FROM public.nodes GROUP BY kind',
    );
    const by_kind: Record<string, number> = { task: 0, learning: 0, file: 0, symbol: 0, decision: 0 };
    for (const row of rows) by_kind[row.kind] = row.c;
    return { node_count, edge_count, by_kind, db_path: this.location };
  }

  async query(filter: QueryFilter): Promise<MemoryNode[]> {
    const limit = clampLimit(filter.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.id !== undefined) {
      params.push(filter.id);
      where.push(`id = $${params.length}`);
    }
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      where.push(`kind = $${params.length}`);
    }
    if (filter.title !== undefined) {
      params.push(`%${escapeLike(filter.title)}%`);
      where.push(`title ILIKE $${params.length} ESCAPE '\\'`);
    }
    params.push(limit);
    const sql =
      'SELECT id, kind, title, body, attrs::text AS attrs FROM public.nodes' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id LIMIT $${params.length}`;
    const { rows } = await this.pool.query<NodeRow>(sql, params);
    return rows.map((r) => rowToNode(r));
  }

  async recallForTask(taskId: string, opts?: RecallOptions): Promise<RecallHit[]> {
    return sharedRecall(this, taskId, opts);
  }

  async traverse(nodeId: string, opts?: TraverseOptions): Promise<GraphSubgraph> {
    return sharedTraverse(this, nodeId, opts);
  }

  async doctor(): Promise<GraphHealth> {
    const node_count = await this.count('SELECT COUNT(*)::int AS c FROM public.nodes');
    const edge_count = await this.count('SELECT COUNT(*)::int AS c FROM public.edges');
    const nodes_by_kind = await this.countByKind('nodes', NODE_KINDS);
    const edges_by_kind = await this.countByKind('edges', EDGE_KINDS);

    const orphanWhere =
      'NOT EXISTS (SELECT 1 FROM public.nodes n WHERE n.id = edges.src) ' +
      'OR NOT EXISTS (SELECT 1 FROM public.nodes n WHERE n.id = edges.dst)';
    const orphanCount = await this.count(`SELECT COUNT(*)::int AS c FROM public.edges WHERE ${orphanWhere}`);
    const orphanSample = (
      await this.pool.query<{ src: string; dst: string; kind: string }>(
        `SELECT src, dst, kind FROM public.edges WHERE ${orphanWhere} ORDER BY src, dst, kind LIMIT $1`,
        [DOCTOR_SAMPLE_CAP],
      )
    ).rows.map((r) => ({ src: clip(r.src), dst: clip(r.dst), kind: clip(r.kind) }));

    const isoWhere = 'NOT EXISTS (SELECT 1 FROM public.edges e WHERE e.src = nodes.id OR e.dst = nodes.id)';
    const isolatedCount = await this.count(`SELECT COUNT(*)::int AS c FROM public.nodes WHERE ${isoWhere}`);
    const isolatedSample = (
      await this.pool.query<{ id: string }>(
        `SELECT id FROM public.nodes WHERE ${isoWhere} ORDER BY id LIMIT $1`,
        [DOCTOR_SAMPLE_CAP],
      )
    ).rows.map((r) => clip(r.id));

    const invalidNodes = await this.scanInvalidNodes();
    const invalidEdges = await this.scanInvalidEdges();

    return {
      node_count,
      edge_count,
      nodes_by_kind,
      edges_by_kind,
      orphan_edges: { count: orphanCount, sample: orphanSample },
      isolated_nodes: { count: isolatedCount, sample: isolatedSample },
      // No separate FTS table (tsv is a generated column) → nothing can go stale.
      stale_fts_rows: { count: 0, sample: [] },
      invalid_rows: { count: invalidNodes.count, sample: invalidNodes.sample },
      invalid_edges: { count: invalidEdges.count, sample: invalidEdges.sample },
      db_path: this.location,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── GraphReadPrimitives (the dialect surface recall/traverse run over) ──────────

  async getNode(id: string): Promise<NodeRow | undefined> {
    const { rows } = await this.pool.query<NodeRow>(
      'SELECT id, kind, title, body, attrs::text AS attrs FROM public.nodes WHERE id = $1',
      [id],
    );
    return rows[0] ?? undefined;
  }

  async edgesFrom(kind: EdgeKind, src: string, limit?: number): Promise<string[]> {
    const sql =
      'SELECT dst FROM public.edges WHERE kind = $1 AND src = $2 ORDER BY dst' +
      (limit !== undefined ? ' LIMIT $3' : '');
    const params = limit !== undefined ? [kind, src, limit] : [kind, src];
    const { rows } = await this.pool.query<{ dst: string }>(sql, params);
    return rows.map((r) => r.dst);
  }

  async edgesTo(kind: EdgeKind, dst: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ src: string }>(
      'SELECT src FROM public.edges WHERE kind = $1 AND dst = $2 ORDER BY src',
      [kind, dst],
    );
    return rows.map((r) => r.src);
  }

  async nodeIdsByKind(kind: NodeKind): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM public.nodes WHERE kind = $1 ORDER BY id',
      [kind],
    );
    return rows.map((r) => r.id);
  }

  async resolveTaskNodeId(input: string): Promise<string | undefined> {
    if (input.startsWith('task:')) {
      const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM public.nodes WHERE id = $1', [input]);
      return rows[0] ? input : undefined;
    }
    const direct = `task:${input}`;
    const directRes = await this.pool.query<{ id: string }>('SELECT id FROM public.nodes WHERE id = $1', [direct]);
    if (directRes.rows[0]) return direct;
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM public.nodes WHERE kind = 'task' AND attrs->>'tracker_issue_id' = $1 LIMIT 1",
      [input],
    );
    return rows[0]?.id;
  }

  async ftsSearch(terms: string[]): Promise<string[]> {
    if (terms.length === 0) return [];
    // tokens are alnum-only (shared tokenizer) → safe to OR-join into a tsquery.
    const q = terms.join(' | ');
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM public.nodes WHERE kind NOT IN ('file', 'symbol') " +
        "AND tsv @@ to_tsquery('simple', $1) " +
        "ORDER BY ts_rank(tsv, to_tsquery('simple', $1)) DESC, id",
      [q],
    );
    return rows.map((r) => r.id);
  }

  async distinctOutNeighbors(id: string, cap: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT DISTINCT dst AS n FROM public.edges WHERE src = $1 ORDER BY dst LIMIT $2',
      [id, cap],
    );
    return rows.map((r) => r.n);
  }

  async distinctInNeighbors(id: string, cap: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT DISTINCT src AS n FROM public.edges WHERE dst = $1 ORDER BY src LIMIT $2',
      [id, cap],
    );
    return rows.map((r) => r.n);
  }

  async internalEdges(
    ids: string[],
    limit: number,
  ): Promise<Array<{ src: string; dst: string; kind: string }>> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ src: string; dst: string; kind: string }>(
      'SELECT src, dst, kind FROM public.edges WHERE src = ANY($1::text[]) AND dst = ANY($1::text[]) ' +
        'ORDER BY src, dst, kind LIMIT $2',
      [ids, limit],
    );
    return rows;
  }

  // ── doctor internals (paged schema-validation scans) ────────────────────────────
  private async count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await this.pool.query<{ c: number }>(sql, params);
    return rows[0]?.c ?? 0;
  }

  private async countByKind(
    table: 'nodes' | 'edges',
    kinds: readonly string[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const k of kinds) {
      out[k] = await this.count(`SELECT COUNT(*)::int AS c FROM public.${table} WHERE kind = $1`, [k]);
    }
    const unknown = await this.count(
      `SELECT COUNT(*)::int AS c FROM public.${table} WHERE kind <> ALL($1::text[])`,
      [kinds],
    );
    if (unknown > 0) out['<unknown>'] = unknown;
    return out;
  }

  private async scanInvalidNodes(): Promise<{ count: number; sample: string[] }> {
    let count = 0;
    const sample: string[] = [];
    let offset = 0;
    for (;;) {
      const { rows } = await this.pool.query<NodeRow>(
        'SELECT id, kind, title, body, attrs::text AS attrs FROM public.nodes ORDER BY id LIMIT $1 OFFSET $2',
        [DOCTOR_SCAN_PAGE, offset],
      );
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

  private async scanInvalidEdges(): Promise<{
    count: number;
    sample: Array<{ src: string; dst: string; kind: string }>;
  }> {
    let count = 0;
    const sample: Array<{ src: string; dst: string; kind: string }> = [];
    let offset = 0;
    for (;;) {
      const { rows } = await this.pool.query<{ src: string; dst: string; kind: string }>(
        'SELECT src, dst, kind FROM public.edges ORDER BY src, dst, kind LIMIT $1 OFFSET $2',
        [DOCTOR_SCAN_PAGE, offset],
      );
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
}

// ── chunked multi-row inserts (ON CONFLICT upsert) ──────────────────────────────
async function insertNodes(conn: PgConn, nodes: readonly MemoryNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i += INSERT_CHUNK) {
    const chunk = nodes.slice(i, i + INSERT_CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((n, j) => {
      const b = j * 5;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`);
      params.push(n.id, n.kind, n.title, n.body, n.attrs !== undefined ? JSON.stringify(n.attrs) : null);
    });
    await conn.query(
      `INSERT INTO public.nodes(id, kind, title, body, attrs) VALUES ${values.join(', ')} ` +
        'ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, title = excluded.title, ' +
        'body = excluded.body, attrs = excluded.attrs',
      params,
    );
  }
}

async function insertEdges(conn: PgConn, edges: readonly MemoryEdge[]): Promise<void> {
  for (let i = 0; i < edges.length; i += INSERT_CHUNK) {
    const chunk = edges.slice(i, i + INSERT_CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((e, j) => {
      const b = j * 3;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
      params.push(e.src, e.dst, e.kind);
    });
    await conn.query(
      `INSERT INTO public.edges(src, dst, kind) VALUES ${values.join(', ')} ON CONFLICT (src, dst, kind) DO NOTHING`,
      params,
    );
  }
}

// ── connection-string redaction (never leak the DSN through db_path) ────────────
export function redactDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `postgres://${u.host}${u.pathname}`;
  } catch {
    return 'postgres:NEON_DATABASE_URL';
  }
}

// ── production pool: lazy-load `pg` and build a Pool from NEON_DATABASE_URL ───────
async function loadPgPool(connectionString: string): Promise<PgPool> {
  let pg: typeof import('pg');
  try {
    pg = (await import('pg')) as unknown as typeof import('pg');
  } catch {
    throw new Error(
      "loom: the 'neon' memory backend needs the 'pg' package — run: npm i pg",
    );
  }
  // pg is CJS; the Pool ctor may be on the module or its default export.
  const PoolCtor = (pg as { Pool?: unknown }).Pool ?? (pg as { default?: { Pool?: unknown } }).default?.Pool;
  if (typeof PoolCtor !== 'function') {
    throw new Error("loom: could not resolve pg.Pool from the 'pg' package");
  }
  const pool = new (PoolCtor as new (config: { connectionString: string }) => {
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    connect(): Promise<{
      query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
      release(): void;
    }>;
    end(): Promise<void>;
  })({ connectionString });
  return {
    query: (text, params) => pool.query(text, params) as Promise<{ rows: never[] }>,
    withConnection: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn({ query: (text, params) => client.query(text, params) as Promise<{ rows: never[] }> });
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

// Factory used by createBackend() for `memory.backend: neon`. Resolves the
// connection string from the allowlisted env var (loaded from .forge/.env by the
// loom context for the resolved repo root), lazy-builds the pool, bootstraps the
// schema, and returns a ready backend.
export async function openRemoteBackend(_memory: Memory, _dbPath: string): Promise<MemoryBackend> {
  const dsn = process.env.NEON_DATABASE_URL;
  if (!dsn || dsn.trim() === '') {
    throw new Error(
      "loom: memory.backend 'neon' requires the NEON_DATABASE_URL connection string " +
        '(set it in .forge/.env or the environment)',
    );
  }
  const pool = await loadPgPool(dsn);
  const backend = new RemoteMemoryBackend(pool, redactDsn(dsn));
  try {
    await backend.bootstrap();
  } catch (err) {
    // Bootstrap failed (DDL / permission / unreachable) — close the pool so we do
    // not leak sockets or keep the CLI process alive, then surface the error.
    await pool.end().catch(() => {});
    throw err;
  }
  return backend;
}

// Existence probe for `memory.backend: neon`: connect read-only and check the
// schema is present WITHOUT creating it (the soft-fail check must not bootstrap).
// A missing credential / unreachable DB throws (opt-in misconfig is loud, not a
// silent empty graph).
export async function remoteExists(): Promise<boolean> {
  const dsn = process.env.NEON_DATABASE_URL;
  if (!dsn || dsn.trim() === '') {
    throw new Error(
      "loom: memory.backend 'neon' requires the NEON_DATABASE_URL connection string " +
        '(set it in .forge/.env or the environment)',
    );
  }
  const pool = await loadPgPool(dsn);
  try {
    const { rows } = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.nodes') IS NOT NULL AS present",
    );
    return rows[0]?.present === true;
  } finally {
    await pool.end();
  }
}
