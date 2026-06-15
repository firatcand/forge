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
  MemoryEdgeSchema,
  MemoryNodeSchema,
  type MemoryEdge,
  type MemoryNode,
  type RecallHit,
} from '../../schemas/memory.ts';
import type { MemoryBackend, MemoryStatus, RecallOptions } from '../types.ts';
import { openDb, type OpenDb, type SqliteDatabase } from './db.ts';

const DEFAULT_RECALL_LIMIT = 20;
const DEFAULT_MAX_DEPTH = 6;

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
        delFts.run(valid.id);
        insFts.run(valid.id, valid.title, valid.body);
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
        insFts.run(node.id, node.title, node.body);
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
    // Honest zero output (Codex): always state both kinds explicitly, even at 0.
    const by_kind: Record<string, number> = { task: 0, learning: 0 };
    for (const row of byKindRows) by_kind[row.kind] = row.c;
    return {
      node_count: total.c,
      edge_count: edgeCount.c,
      by_kind,
      db_path: this.dbPath,
    };
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

    // ── 2. STRUCTURAL hits: learning nodes linked via learned_from → scope. ──
    // Edge direction (ingest): learning --learned_from--> task. So a learning is
    // structural for this task when it has a learned_from edge whose dst ∈ scope.
    const selLearnedFrom = this.db.prepare(
      'SELECT src FROM edges WHERE kind = ? AND dst = ?',
    );
    for (const target of scope) {
      const rows = selLearnedFrom.all('learned_from', target) as Array<{ src: string }>;
      for (const r of rows) {
        if (seen.has(r.src)) continue;
        const node = this.getNode(r.src);
        if (!node || node.kind !== 'learning') continue;
        seen.add(r.src);
        const via =
          target === taskNodeId
            ? `linked via learned_from→${stripTaskPrefix(target)}`
            : `linked via depends_on→${stripTaskPrefix(target)} learned_from`;
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
    }

    // ── 3. FTS hits over title+body using the task's title+description. ──
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
        const node = this.getNode(r.id);
        if (!node) continue;
        seen.add(r.id);
        hits.push({
          id: node.id,
          kind: node.kind === 'learning' ? 'learning' : 'task',
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

  private getNode(id: string): NodeRow | undefined {
    const row = this.db
      .prepare('SELECT id, kind, title, body, attrs FROM nodes WHERE id = ?')
      .get(id) as NodeRow | undefined;
    return row ?? undefined;
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
