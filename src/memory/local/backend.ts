// FORGE-200 (Loom I1): the local SQLite memory backend.
//
// Implements MemoryBackend over db.ts. All writes are wrapped in explicit
// transactions (BEGIN/COMMIT with rollback on throw) so a partial reindex / a
// concurrent writer never leaves a torn graph. recallForTask composes:
//   1. BFS over depends_on ancestors from task:<id> (visited-set + depth cap).
//   2. STRUCTURAL hits: learning nodes linked via learned_from to {task ∪ ancestors}.
//   3. FTS hits: nodes_fts MATCH over a sanitized query built from the task's
//      title+description.
//   4. Rank structural ABOVE fts; dedup by node id; each hit carries `why`.

import {
  EDGE_KINDS,
  MemoryEdgeSchema,
  MemoryNodeSchema,
  NODE_KINDS,
  type MemoryEdge,
  type MemoryNode,
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
import { openDb, type OpenDb, type SqliteDatabase } from './db.ts';
import { matchAny, InvalidGlobError } from '../../orchestrator/glob-match.ts';

const DEFAULT_RECALL_LIMIT = 20;
const DEFAULT_MAX_DEPTH = 6;

// FORGE-227 (symbol recall): symbols defined in scope-touched files rank as
// structural hits BELOW learnings/decisions (1000) and ABOVE fts (1). Bounded
// per-file and overall so one giant file cannot flood recall.
const SYMBOL_RECALL_SCORE = 900;
const MAX_SYMBOL_HITS_PER_FILE = 20;
const MAX_SYMBOL_HITS_TOTAL = 100;

// FORGE-227 (query/traverse/doctor): hard bounds so a single inspection call on a
// huge/corrupt graph stays finite. Every limit is clamped to its MAX.
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_TRAVERSE_DEPTH = 2;
const MAX_TRAVERSE_DEPTH = 6;
const DEFAULT_TRAVERSE_MAX_NODES = 200;
const MAX_TRAVERSE_EDGES = 2000;
// Per-node, per-direction SQL LIMIT during BFS expansion: a high-degree node
// cannot materialize an unbounded row set before the node cap kicks in.
const MAX_EDGE_EXPANSION = 1000;
const DOCTOR_SAMPLE_CAP = 50;
// Page size for doctor's row-validation scans: schema validation cannot be done
// in SQL, so nodes/edges are scanned in bounded pages (never more than one page
// held in memory at a time) while counts stay exact.
const DOCTOR_SCAN_PAGE = 1000;

// Clamp a caller-supplied limit to [1, max], defaulting when absent. (The CLI
// already rejects non-positive ints, but the backend is the enforcement gate.)
function clampLimit(value: number | undefined, dflt: number, max: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return dflt;
  return Math.min(value, max);
}

// Escape LIKE wildcards so `--title` is a literal substring, never a pattern.
// Paired with `ESCAPE '\'` in the query. A bare `%` would otherwise match all.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Clip a sample value so a hand-edited DB with a megabyte id/kind cannot blow up
// doctor's output. Coerces non-string scalars (a corrupt row may carry a NULL or
// numeric id under the TEXT schema) so the diagnostic never throws on the very
// corruption it reports. Schema ids are bounded to 256, so a longer value is
// itself a corruption signal — keep enough to identify it, mark it clipped.
const SAMPLE_STR_MAX = 256;
function clip(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  return s.length > SAMPLE_STR_MAX ? `${s.slice(0, SAMPLE_STR_MAX)}…` : s;
}

// Build a SAFE FTS5 MATCH query from arbitrary task text (Codex blocking-ish).
// FTS5 treats `-`, `:`, `*`, `"`, `^`, `(`, `)`, and the bareword operators
// AND/OR/NOT/NEAR as query syntax — an unescaped task title like
// "FORGE-200: loom" would be a MATCH syntax error. Strategy: lowercase, split on
// any non-alphanumeric run into terms, drop the FTS bareword operators, wrap each
// surviving term in double-quotes (a quoted string is a literal phrase token),
// and OR-join. Returns '' when nothing usable remains (caller skips FTS).
const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near']);

export function buildFtsQuery(text: string): string {
  if (!text) return '';
  const terms = text
    .toLowerCase()
    // Split on anything that is not a letter or digit. This strips ALL FTS
    // special characters (- : * " ^ ( ) etc.) and punctuation in one pass.
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !FTS_OPERATORS.has(t));
  if (terms.length === 0) return '';
  // Wrap each term as a quoted literal token; OR-join so any term can match.
  return terms.map((t) => `"${t}"`).join(' OR ');
}

interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly attrs: string | null;
}

export class LocalMemoryBackend implements MemoryBackend {
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

  reset(): void {
    this.tx(() => {
      this.db.exec('DELETE FROM nodes;');
      this.db.exec('DELETE FROM edges;');
      this.db.exec('DELETE FROM nodes_fts;');
    });
  }

  upsertNodes(nodes: readonly MemoryNode[]): void {
    if (nodes.length === 0) return;
    const insNode = this.db.prepare(
      'INSERT OR REPLACE INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)',
    );
    const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE id = ?');
    const insFts = this.db.prepare('INSERT INTO nodes_fts(id, title, body) VALUES(?, ?, ?)');
    this.tx(() => {
      for (const node of nodes) {
        // Fail-closed enforcement gate (GPT-5.5 cross-review B2): re-validate
        // every node through MemoryNodeSchema (bounded id/title/body, strict
        // keys) before it touches SQLite/FTS. ingest caps source text to the
        // same bounds, so this never throws on legit data — it catches any
        // producer (now or future) that bypasses ingest with an over-long /
        // malformed node rather than letting it blow up the DB.
        const valid = assertValidNode(node);
        const attrs = valid.attrs !== undefined ? JSON.stringify(valid.attrs) : null;
        insNode.run(valid.id, valid.kind, valid.title, valid.body, attrs);
        // Keep the FTS shadow in sync: delete any prior row, then insert fresh.
        // FORGE-218: `file` nodes are structural-only — their title is a repo path
        // and would pollute FTS recall, so they are NEVER indexed into nodes_fts
        // (still always cleared, so a kind change file→non-file re-indexes cleanly).
        delFts.run(valid.id);
        // FORGE-219: `symbol` nodes are excluded from FTS like `file` nodes —
        // their title is a bare code identifier (e.g. `get`, `id`) that would
        // pollute full-text recall with name-token noise (symbols are structural-
        // only in I2b-1; recall does not surface them).
        // FORGE-226: `decision` nodes ARE indexed (searchable prose like
        // learnings) — they are NOT in this exclusion list.
        if (valid.kind !== 'file' && valid.kind !== 'symbol') {
          insFts.run(valid.id, valid.title, valid.body);
        }
      }
    });
  }

  upsertEdges(edges: readonly MemoryEdge[]): void {
    if (edges.length === 0) return;
    const insEdge = this.db.prepare(
      'INSERT OR REPLACE INTO edges(src, dst, kind) VALUES(?, ?, ?)',
    );
    this.tx(() => {
      for (const edge of edges) {
        const valid = assertValidEdge(edge);
        insEdge.run(valid.src, valid.dst, valid.kind);
      }
    });
  }

  // Atomic rebuild (GPT-5.5 re-review B3): VALIDATE every node+edge FIRST (before
  // touching the DB), then delete-all + insert-all inside ONE transaction. A
  // validation throw happens before any delete, and any later throw rolls the
  // whole tx back — so reindex can never wipe the prior graph and then fail.
  replaceGraph(nodes: readonly MemoryNode[], edges: readonly MemoryEdge[]): void {
    // Phase 1: validate everything up-front. Nothing is written yet, so a
    // malformed/over-bound row aborts with the DB untouched.
    const validNodes = nodes.map((n) => assertValidNode(n));
    const validEdges = edges.map((e) => assertValidEdge(e));

    // Phase 2: single transaction — wipe then re-insert. Any throw → ROLLBACK
    // restores the previous contents.
    const insNode = this.db.prepare(
      'INSERT OR REPLACE INTO nodes(id, kind, title, body, attrs) VALUES(?, ?, ?, ?, ?)',
    );
    const insFts = this.db.prepare('INSERT INTO nodes_fts(id, title, body) VALUES(?, ?, ?)');
    const insEdge = this.db.prepare(
      'INSERT OR REPLACE INTO edges(src, dst, kind) VALUES(?, ?, ?)',
    );
    this.tx(() => {
      this.db.exec('DELETE FROM nodes;');
      this.db.exec('DELETE FROM edges;');
      this.db.exec('DELETE FROM nodes_fts;');
      for (const node of validNodes) {
        const attrs = node.attrs !== undefined ? JSON.stringify(node.attrs) : null;
        insNode.run(node.id, node.kind, node.title, node.body, attrs);
        // FORGE-218: exclude `file` nodes from FTS (repo-path titles would
        // pollute full-text recall); they remain in `nodes` as structural-only.
        // FORGE-219: exclude `symbol` nodes too (bare identifier titles would add
        // name-token noise; symbols are structural-only in I2b-1).
        // FORGE-226: `decision` nodes ARE indexed (searchable prose) — not excluded.
        if (node.kind !== 'file' && node.kind !== 'symbol') {
          insFts.run(node.id, node.title, node.body);
        }
      }
      for (const edge of validEdges) {
        insEdge.run(edge.src, edge.dst, edge.kind);
      }
    });
  }

  status(): MemoryStatus {
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
    const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
    const byKindRows = this.db
      .prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; c: number }>;
    // Honest zero output (Codex): always state every kind explicitly, even at 0
    // (FORGE-218 adds `file`; FORGE-219 adds `symbol`).
    const by_kind: Record<string, number> = { task: 0, learning: 0, file: 0, symbol: 0, decision: 0 };
    for (const row of byKindRows) by_kind[row.kind] = row.c;
    return {
      node_count: total.c,
      edge_count: edgeCount.c,
      by_kind,
      db_path: this.dbPath,
    };
  }

  // FORGE-227: ad-hoc node lookup. Filters (id / kind / title-substring) AND
  // together; at least one is required by the CLI. title uses an escaped LIKE so
  // wildcards are literal. Rows are validated on the way out (corrupt row throws).
  query(filter: QueryFilter): MemoryNode[] {
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
    return rows.map((r) => this.rowToNode(r));
  }

  // FORGE-227: bounded reachable subgraph from `nodeId`. BFS over edges in BOTH
  // directions up to `depth` hops, capped at a max node count; the visited-set is
  // the loop guard (a corrupt cycle cannot loop). Returns every edge whose BOTH
  // endpoints are in the returned node set (sorted, capped) — so dangling edges
  // never appear. `truncated` flags that a cap was hit.
  traverse(nodeId: string, opts?: TraverseOptions): GraphSubgraph {
    const depth = clampLimit(opts?.depth, DEFAULT_TRAVERSE_DEPTH, MAX_TRAVERSE_DEPTH);
    const maxNodes = clampLimit(opts?.limit, DEFAULT_TRAVERSE_MAX_NODES, DEFAULT_TRAVERSE_MAX_NODES);
    if (!this.getNode(nodeId)) {
      return { root: nodeId, nodes: [], edges: [], truncated: false };
    }

    const visited = new Set<string>([nodeId]);
    let truncated = false;
    // SELECT DISTINCT so the per-node LIMIT bounds DISTINCT NEIGHBORS, not raw
    // edge rows — otherwise many parallel edges (different kinds) between the same
    // endpoints would silently drop reachable nodes before the node cap applies.
    const selOut = this.db.prepare(
      'SELECT DISTINCT dst AS n FROM edges WHERE src = ? ORDER BY dst LIMIT ?',
    );
    const selIn = this.db.prepare(
      'SELECT DISTINCT src AS n FROM edges WHERE dst = ? ORDER BY src LIMIT ?',
    );
    let frontier: string[] = [nodeId];
    let d = 0;
    while (frontier.length > 0 && d < depth) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const stmt of [selOut, selIn]) {
          const rows = stmt.all(cur, MAX_EDGE_EXPANSION) as Array<{ n: string }>;
          // The neighbor read itself hit the cap → more may exist beyond it.
          if (rows.length >= MAX_EDGE_EXPANSION) truncated = true;
          for (const r of rows) {
            if (visited.has(r.n)) continue;
            if (visited.size >= maxNodes) {
              truncated = true;
              continue;
            }
            visited.add(r.n);
            next.push(r.n);
          }
        }
      }
      frontier = next;
      d += 1;
    }

    // Materialize only nodes that actually exist (a visited id that is purely a
    // dangling edge target has no node row → excluded). Validate each on the way
    // out. Deterministic order via sorted ids.
    const present = new Set<string>();
    const nodes: MemoryNode[] = [];
    for (const id of [...visited].sort()) {
      const row = this.getNode(id);
      if (!row) continue;
      nodes.push(this.rowToNode(row));
      present.add(id);
    }

    // Internal edges only: BOTH endpoints in the present node set. One bounded
    // query (`src IN (…) AND dst IN (…)`) over the ≤maxNodes present ids — no
    // wasted reads of edges to absent nodes, so a valid internal edge can never be
    // cut off by a per-node read cap. Fetch one past MAX_TRAVERSE_EDGES to detect
    // (and flag) genuine edge truncation.
    const edges: MemoryEdge[] = [];
    const presentIds = [...present].sort();
    if (presentIds.length > 0) {
      const placeholders = presentIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT src, dst, kind FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders}) ` +
            'ORDER BY src, dst, kind LIMIT ?',
        )
        .all(...presentIds, ...presentIds, MAX_TRAVERSE_EDGES + 1) as Array<{
        src: string;
        dst: string;
        kind: string;
      }>;
      if (rows.length > MAX_TRAVERSE_EDGES) truncated = true;
      for (const r of rows.slice(0, MAX_TRAVERSE_EDGES)) edges.push(MemoryEdgeSchema.parse(r));
    }
    return { root: nodeId, nodes, edges, truncated };
  }

  // FORGE-227: graph health report. Counts + structural-integrity checks (orphan
  // edges, isolated nodes, stale FTS rows) run as SET-BASED SQL so the whole graph
  // is never materialized in JS. Schema validation (invalid node/edge rows) cannot
  // be expressed in SQL, so those scans page through the tables (one bounded page
  // in memory at a time) while keeping exact counts. Every sample is capped.
  // Read-only; never mutates.
  doctor(): GraphHealth {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c;

    const node_count = count('SELECT COUNT(*) AS c FROM nodes');
    const edge_count = count('SELECT COUNT(*) AS c FROM edges');

    // Count only KNOWN kinds individually, lumping anything else into a single
    // `<unknown>` bucket. A GROUP BY kind on a hand-edited DB with a unique kind
    // per row would otherwise materialize an unbounded map; this is fixed-size.
    const nodes_by_kind = this.countByKind('nodes', NODE_KINDS);
    const edges_by_kind = this.countByKind('edges', EDGE_KINDS);

    // Orphan edges: a src or dst with no backing node. Count + capped sample, all
    // in SQL (anti-join), so a million-edge table never lands in JS at once.
    const orphanWhere =
      'NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.src) ' +
      'OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.dst)';
    const orphanCount = count(`SELECT COUNT(*) AS c FROM edges WHERE ${orphanWhere}`);
    // Normalize raw sqlite rows to plain objects (node:sqlite rows have a null
    // prototype, which would surprise deepStrictEqual / structured consumers).
    const orphanSample = (
      this.db
        .prepare(`SELECT src, dst, kind FROM edges WHERE ${orphanWhere} ORDER BY src, dst, kind LIMIT ?`)
        .all(DOCTOR_SAMPLE_CAP) as Array<{ src: string; dst: string; kind: string }>
    ).map((r) => ({ src: clip(r.src), dst: clip(r.dst), kind: clip(r.kind) }));

    // Isolated nodes: no incident edge in either direction.
    const isoWhere =
      'NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = nodes.id OR e.dst = nodes.id)';
    const isolatedCount = count(`SELECT COUNT(*) AS c FROM nodes WHERE ${isoWhere}`);
    const isolatedSample = (
      this.db
        .prepare(`SELECT id FROM nodes WHERE ${isoWhere} ORDER BY id LIMIT ?`)
        .all(DOCTOR_SAMPLE_CAP) as Array<{ id: string }>
    ).map((r) => clip(r.id));

    // Stale FTS rows: an FTS id with no backing node.
    const staleWhere = 'NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = nodes_fts.id)';
    const staleCount = count(`SELECT COUNT(*) AS c FROM nodes_fts WHERE ${staleWhere}`);
    const staleSample = (
      this.db
        .prepare(`SELECT id FROM nodes_fts WHERE ${staleWhere} ORDER BY id LIMIT ?`)
        .all(DOCTOR_SAMPLE_CAP) as Array<{ id: string }>
    ).map((r) => clip(r.id));

    // Invalid rows: schema validation is not expressible in SQL, so page through
    // both tables bounded. A bad edge between EXISTING nodes is not orphan/stale,
    // so without this scan doctor could report clean while traverse later throws
    // on MemoryEdgeSchema.parse — these checks predict that failure.
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

  // Paged scan: count + capped sample of node rows that fail schema validation
  // (corrupt attrs JSON / unknown kind / over-bound field). Holds at most one
  // page in memory.
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
          this.rowToNode(r);
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

  // Paged scan: count + capped sample of edge rows that fail schema validation
  // (e.g. an unknown edge kind). Holds at most one page in memory.
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
      const rows = sel.all(DOCTOR_SCAN_PAGE, offset) as Array<{
        src: string;
        dst: string;
        kind: string;
      }>;
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

  // Bounded kind histogram: count each KNOWN kind individually + lump every other
  // value into a single `<unknown>` bucket. The result map is fixed-size (known
  // kinds + 1) regardless of how many distinct kinds a corrupt DB invents. `table`
  // is a trusted literal ('nodes' | 'edges'); `kinds` are bound as parameters.
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

  recallForTask(taskId: string, opts?: RecallOptions): RecallHit[] {
    const limit = opts?.limit ?? DEFAULT_RECALL_LIMIT;
    const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;

    // Resolve the input to a task node id (GPT-5.5 cross-review B1). The pure-fn
    // node id is `task:<phasesId>`, but /pickup-task passes the TRACKER id (e.g.
    // `FORGE-200`), which is stashed in attrs.tracker_issue_id — so accept the
    // bare/prefixed phases id OR a tracker_issue_id and resolve all three forms.
    const taskNodeId = this.resolveTaskNodeId(taskId);
    if (!taskNodeId) return [];
    const taskRow = this.getNode(taskNodeId);
    if (!taskRow) return [];

    // ── 1. BFS over depends_on ancestors (visited-set + depth cap). ──
    // The visited-set is the primary loop guard: even a corrupt/cyclic DB row
    // (a depends_on edge that PhasesSchema would have rejected) cannot loop.
    const ancestors = this.bfsDependsOn(taskNodeId, maxDepth);
    const scope = new Set<string>([taskNodeId, ...ancestors]);

    const hits: RecallHit[] = [];
    const seen = new Set<string>();

    // ── 2. CO-TOUCH expansion (FORGE-218 / B1). ──
    // The `touches` edges are only useful via co-touch until learning→file lands
    // (I2b): there is NO learning→file edge yet, so "a learning referencing a file
    // an ancestor touched" is inert. Instead we find OTHER tasks that touched the
    // same files as the scope, and pull THEIR learnings structurally.
    //
    // candidate files = `touches` dsts of every scope node (concrete file ids) ∪
    //   (fallback, additive) file nodes whose path matches a scope node's
    //   write_globs — so a task that has not run yet (no touches) can still find
    //   co-touchers via its declared globs.
    const candidateFiles = new Set<string>();
    const selTouchesDst = this.db.prepare(
      'SELECT dst FROM edges WHERE kind = ? AND src = ?',
    );
    for (const member of scope) {
      const rows = selTouchesDst.all('touches', member) as Array<{ dst: string }>;
      for (const r of rows) candidateFiles.add(r.dst);
    }
    // FORGE-227: capture the files the scope ACTUALLY touched (pre-glob), sorted
    // for deterministic symbol-hit order. The glob expansion below only widens
    // `candidateFiles` to find co-touching tasks — it must NOT pull symbols from
    // files the scope never touched, so symbol surfacing uses this subset.
    const scopeTouchedFiles = [...candidateFiles].sort();
    const scopeGlobs = this.collectScopeWriteGlobs(scope);
    if (scopeGlobs.length > 0) {
      // Glob-match file node paths (file:<relpath>) against the scope's globs.
      const fileRows = this.db
        .prepare("SELECT id FROM nodes WHERE kind = 'file'")
        .all() as Array<{ id: string }>;
      for (const fr of fileRows) {
        const relpath = fr.id.startsWith('file:') ? fr.id.slice('file:'.length) : fr.id;
        // Reuse the repo's canonical glob engine (GPT-5.5 B1) — the hand-rolled
        // matcher had globstar false negatives (`src/**/*.ts` missed `src/foo.ts`).
        // matchAny throws InvalidGlobError on a malformed write_glob; treat that as
        // no co-touch match (never throw recall on bad phases.yaml glob data).
        try {
          if (matchAny(relpath, scopeGlobs).matched) candidateFiles.add(fr.id);
        } catch (e) {
          if (!(e instanceof InvalidGlobError)) throw e;
        }
      }
    }

    // co-touching tasks = src of `touches` edges whose dst ∈ candidate files,
    // EXCLUDING the scope tasks themselves (they are not "other" tasks).
    const selTouchesSrc = this.db.prepare(
      'SELECT src FROM edges WHERE kind = ? AND dst = ?',
    );
    // coTouchVia: co-touching task node id → one shared file (for the `why` string).
    const coTouchVia = new Map<string, string>();
    for (const file of candidateFiles) {
      const rows = selTouchesSrc.all('touches', file) as Array<{ src: string }>;
      for (const r of rows) {
        if (scope.has(r.src)) continue; // not a co-toucher — it's in scope
        if (!coTouchVia.has(r.src)) coTouchVia.set(r.src, file);
      }
    }

    // ── 3. STRUCTURAL hits: learning nodes via learned_from → an expanded source
    // set = depends_on scope (I1) ∪ co-touching tasks (new). Edge direction
    // (ingest): learning --learned_from--> task. `why` distinguishes the two
    // provenance kinds. File nodes are NEVER returned as hits (they are
    // structural intermediaries, not recall results).
    const selLearnedFrom = this.db.prepare(
      'SELECT src FROM edges WHERE kind = ? AND dst = ?',
    );
    // FORGE-226: decisions link to their task the OPPOSITE direction
    // (`decision --decided_in--> task`, `decision --affects--> task`) — so a
    // scope task is the EDGE DST. Pull every decision whose decided_in/affects
    // dst is in scope; rank 1000 alongside learnings (Codex CRITICAL: the I1
    // structural logic was learning-only; this generalizes it to admit
    // `decision` nodes too).
    const selDecidedIn = this.db.prepare('SELECT src FROM edges WHERE kind = ? AND dst = ?');
    const addStructuralLearnings = (target: string, via: string): void => {
      const rows = selLearnedFrom.all('learned_from', target) as Array<{ src: string }>;
      for (const r of rows) {
        if (seen.has(r.src)) continue;
        const node = this.getValidNode(r.src);
        if (!node || node.kind !== 'learning') continue;
        seen.add(r.src);
        hits.push({
          id: node.id,
          kind: 'learning',
          title: node.title,
          // Structural hits rank ABOVE fts: give them a high, stable score.
          score: 1000,
          why: via,
          source: 'structural',
        });
      }
    };
    const addStructuralDecisions = (target: string, viaPrefix: string): void => {
      for (const edgeKind of ['decided_in', 'affects'] as const) {
        const rows = selDecidedIn.all(edgeKind, target) as Array<{ src: string }>;
        for (const r of rows) {
          if (seen.has(r.src)) continue;
          const node = this.getValidNode(r.src);
          if (!node || node.kind !== 'decision') continue;
          seen.add(r.src);
          hits.push({
            id: node.id,
            kind: 'decision',
            title: node.title,
            score: 1000,
            why: `${viaPrefix} (${edgeKind})`,
            source: 'structural',
          });
        }
      }
    };
    // Scope (depends_on) learnings first — these are the I1 hits, kept verbatim.
    for (const target of scope) {
      const via =
        target === taskNodeId
          ? `linked via learned_from→${stripTaskPrefix(target)}`
          : `linked via depends_on→${stripTaskPrefix(target)} learned_from`;
      addStructuralLearnings(target, via);
      // FORGE-226: decisions decided_in / affecting the scope task (∪ depends_on
      // ancestors) surface alongside learnings as structural hits.
      const decisionVia =
        target === taskNodeId
          ? `decided in ${stripTaskPrefix(target)}`
          : `decided in depends_on ancestor ${stripTaskPrefix(target)}`;
      addStructuralDecisions(target, decisionVia);
    }
    // Then co-touching tasks' learnings (new in I2a).
    for (const [coTask, sharedFile] of coTouchVia) {
      const via = `co-touched file ${stripFilePrefix(sharedFile)} with task ${stripTaskPrefix(coTask)}; its learning`;
      addStructuralLearnings(coTask, via);
    }

    // ── 3b. STRUCTURAL symbol hits (FORGE-227). Symbols DEFINED in files the
    // scope (task ∪ depends_on ancestors) touched: file --defines--> symbol.
    // Ranked below learnings/decisions (1000), above fts (1). Deterministic via
    // sorted files + ORDER BY dst; bounded per-file and overall so a giant file
    // cannot flood recall. Symbols are excluded from FTS, so this is the only
    // path that surfaces them.
    const selDefines = this.db.prepare(
      'SELECT dst FROM edges WHERE kind = ? AND src = ? ORDER BY dst LIMIT ?',
    );
    let symbolHitCount = 0;
    for (const file of scopeTouchedFiles) {
      if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
      const rows = selDefines.all('defines', file, MAX_SYMBOL_HITS_PER_FILE) as Array<{
        dst: string;
      }>;
      for (const r of rows) {
        if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
        if (seen.has(r.dst)) continue;
        const node = this.getValidNode(r.dst);
        if (!node || node.kind !== 'symbol') continue;
        seen.add(r.dst);
        symbolHitCount += 1;
        hits.push({
          id: node.id,
          kind: 'symbol',
          title: node.title,
          score: SYMBOL_RECALL_SCORE,
          why: `linked via touches→${stripFilePrefix(file)} defines`,
          source: 'structural',
        });
      }
    }

    // ── 4. FTS hits over title+body using the task's title+description. ──
    const queryText = `${taskRow.title} ${taskRow.body}`;
    const ftsQuery = buildFtsQuery(queryText);
    if (ftsQuery.length > 0) {
      let ftsRows: Array<{ id: string }> = [];
      try {
        ftsRows = this.db
          .prepare('SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank')
          .all(ftsQuery) as Array<{ id: string }>;
      } catch (err) {
        // A MATCH syntax error here would mean buildFtsQuery let something
        // through — fail loudly rather than silently returning no fts hits.
        throw new Error(
          `loom: FTS query failed for task ${taskNodeId} (query: ${ftsQuery}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const r of ftsRows) {
        // Never surface the task itself as its own fts hit.
        if (r.id === taskNodeId) continue;
        if (seen.has(r.id)) continue;
        const node = this.getValidNode(r.id);
        if (!node) continue;
        // Belt (FORGE-218): file nodes are excluded from FTS at index time, but
        // never surface one as a hit even if a stale row slipped through.
        if (node.kind === 'file') continue;
        seen.add(r.id);
        // FORGE-226 (Codex CRITICAL): surface the ACTUAL node kind. The prior
        // logic mapped every non-learning FTS hit to `task`, so a `decision` FTS
        // hit was mislabelled `task`. Trust the indexed kind (validated on write);
        // fall back to `task` only for an unexpected/legacy value.
        const ftsKind =
          node.kind === 'learning' || node.kind === 'decision' || node.kind === 'task'
            ? node.kind
            : 'task';
        hits.push({
          id: node.id,
          kind: ftsKind,
          title: node.title,
          score: 1,
          why: `FTS match on task title/description`,
          source: 'fts',
        });
      }
    }

    // Structural-before-fts is already the insertion order; sort by score desc as
    // a stable belt-and-suspenders, then cap.
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  // ── internals ──────────────────────────────────────────────────────────────
  // Resolve an arbitrary task reference to its node id. Order: an already-prefixed
  // `task:<id>`, then the bare phases id `task:<input>`, then a tracker_issue_id
  // match in attrs (json_extract). Returns undefined when nothing matches.
  private resolveTaskNodeId(input: string): string | undefined {
    if (input.startsWith('task:')) {
      return this.getNode(input) ? input : undefined;
    }
    const direct = `task:${input}`;
    if (this.getNode(direct)) return direct;
    // Fall back to a tracker_issue_id lookup (e.g. `FORGE-200`). attrs is stored
    // as JSON in a TEXT column; json_extract is bundled with node:sqlite's SQLite.
    const row = this.db
      .prepare(
        "SELECT id FROM nodes WHERE kind = 'task' AND json_extract(attrs, '$.tracker_issue_id') = ? LIMIT 1",
      )
      .get(input) as { id: string } | undefined;
    return row?.id;
  }

  // Collect the union of write_globs across a set of task nodes (FORGE-218 fallback
  // for co-touch candidate files). attrs is JSON in a TEXT column; a corrupt /
  // non-array value is tolerated (skipped) rather than throwing recall.
  private collectScopeWriteGlobs(scope: Set<string>): string[] {
    const out = new Set<string>();
    for (const id of scope) {
      const node = this.getNode(id);
      if (!node || node.kind !== 'task' || !node.attrs) continue;
      try {
        const attrs = JSON.parse(node.attrs) as Record<string, unknown>;
        const globs = attrs.write_globs;
        if (Array.isArray(globs)) {
          for (const g of globs) if (typeof g === 'string' && g.length > 0) out.add(g);
        }
      } catch {
        // Corrupt attrs JSON — skip this node's globs, do not throw recall.
      }
    }
    return Array.from(out);
  }

  private getNode(id: string): NodeRow | undefined {
    const row = this.db
      .prepare('SELECT id, kind, title, body, attrs FROM nodes WHERE id = ?')
      .get(id) as NodeRow | undefined;
    return row ?? undefined;
  }

  // FORGE-227: convert a raw DB row into a VALIDATED MemoryNode. attrs is stored
  // as a JSON TEXT column; parse it and re-validate the whole node through
  // MemoryNodeSchema (bounded fields, known kind, strict keys). Throws on a
  // corrupt row — query/traverse fail loud; doctor catches per-row and reports it.
  // FORGE-227: best-effort validated read for the RECALL path. recall feeds
  // /pickup-task and must never crash on one corrupt row, so a row that fails the
  // schema boundary is DROPPED (not surfaced, not thrown) — unlike query/traverse,
  // which fail loud. `forge loom doctor` is the tool that surfaces such rows.
  private getValidNode(id: string): MemoryNode | undefined {
    const row = this.getNode(id);
    if (!row) return undefined;
    try {
      return this.rowToNode(row);
    } catch {
      return undefined;
    }
  }

  private rowToNode(row: NodeRow): MemoryNode {
    let attrs: unknown;
    if (row.attrs !== null) {
      // JSON.parse throws on a corrupt attrs blob — that is a corrupt-row signal,
      // surfaced to the caller (fail-loud for query/traverse; counted by doctor).
      attrs = JSON.parse(row.attrs);
    }
    return MemoryNodeSchema.parse({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      ...(attrs !== undefined ? { attrs } : {}),
    });
  }

  // BFS over depends_on edges (src --depends_on--> dst). Returns the set of
  // ancestor node ids reachable from `start`, excluding `start`. Bounded by both
  // the visited-set (loop guard) and maxDepth.
  private bfsDependsOn(start: string, maxDepth: number): Set<string> {
    const out = new Set<string>();
    const visited = new Set<string>([start]);
    const selDeps = this.db.prepare('SELECT dst FROM edges WHERE kind = ? AND src = ?');
    let frontier: string[] = [start];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const node of frontier) {
        const rows = selDeps.all('depends_on', node) as Array<{ dst: string }>;
        for (const r of rows) {
          if (visited.has(r.dst)) continue; // visited-set: corrupt cycle cannot loop
          visited.add(r.dst);
          out.add(r.dst);
          next.push(r.dst);
        }
      }
      frontier = next;
      depth += 1;
    }
    return out;
  }
}

function stripTaskPrefix(id: string): string {
  return id.startsWith('task:') ? id.slice('task:'.length) : id;
}

function stripFilePrefix(id: string): string {
  return id.startsWith('file:') ? id.slice('file:'.length) : id;
}

// Async factory: opens the DB (lazy sqlite import) and returns a ready backend.
export async function openLocalBackend(dbPath: string): Promise<MemoryBackend> {
  const open = await openDb(dbPath);
  return new LocalMemoryBackend(open);
}

// Exported for tests: validate a node/edge before write (the upsert/replaceGraph
// paths call these so a malformed source row fails loudly rather than corrupting
// the graph — or, via replaceGraph, before any delete so it cannot wipe the DB).
export function assertValidNode(node: unknown): MemoryNode {
  return MemoryNodeSchema.parse(node);
}

export function assertValidEdge(edge: unknown): MemoryEdge {
  return MemoryEdgeSchema.parse(edge);
}
