// FORGE-200 (Loom I1): the pluggable memory backend interface.
//
// I1 ships ONE implementation (local SQLite WAL+FTS5, src/memory/local/). The
// interface is deliberately minimal — only what `reindex`/`recall`/`status`
// need. No traversal/prune/bulkUnlink: those arrive with later increments.
// Athena (a remote backend) is a future variant behind createBackend().

import type { MemoryEdge, MemoryNode, NodeKind, RecallHit } from '../schemas/memory.ts';

export interface RecallOptions {
  // Cap on returned hits (structural-first, then fts).
  readonly limit?: number;
  // BFS depth cap over depends_on ancestors (bounds traversal even on a
  // corrupt/cyclic DB; the visited-set is the primary loop guard).
  readonly maxDepth?: number;
}

export interface MemoryStatus {
  readonly node_count: number;
  readonly edge_count: number;
  readonly by_kind: Record<string, number>;
  readonly db_path: string;
}

// FORGE-227: ad-hoc node lookup filter for `forge loom query`. At least one of
// id/kind/title is required (enforced by the CLI layer). Filters AND together.
export interface QueryFilter {
  readonly id?: string;
  readonly kind?: NodeKind;
  // Case-insensitive substring on title; LIKE wildcards (% _) are escaped so
  // the input is a literal substring, never a pattern.
  readonly title?: string;
  // Cap on returned nodes (clamped to a hard max in the backend).
  readonly limit?: number;
}

// FORGE-227: options for `forge loom traverse`. Both are bounded in the backend.
export interface TraverseOptions {
  // Max hops out from the root (both edge directions). Default 2.
  readonly depth?: number;
  // Max nodes in the returned subgraph (clamped to a hard max).
  readonly limit?: number;
}

// FORGE-227: the reachable subgraph from a root node, validated on the way out.
// `edges` only ever reference nodes present in `nodes`. `truncated` is true when
// a node/edge cap was hit (the subgraph is a bounded sample, not the whole reach).
export interface GraphSubgraph {
  readonly root: string;
  readonly nodes: readonly MemoryNode[];
  readonly edges: readonly MemoryEdge[];
  readonly truncated: boolean;
}

// FORGE-227: a bounded sample of ids/edges + a total count, used by the doctor
// report so a deeply-broken DB yields a finite report (never a megabyte dump).
export interface HealthSample<T> {
  readonly count: number;
  readonly sample: readonly T[];
}

// FORGE-227: graph health report for `forge loom doctor`. A computed snapshot
// (like MemoryStatus) — never persisted, so no zod boundary. `orphan_edges` =
// edges with a missing endpoint; `isolated_nodes` = no incident edge;
// `stale_fts_rows` = FTS rows with no backing node; `invalid_rows` = node rows
// that fail schema validation (unknown kind, corrupt attrs, over-bound field);
// `invalid_edges` = edge rows that fail schema validation (e.g. unknown kind) —
// these would later make traverse throw, so doctor surfaces them up front.
export interface GraphHealth {
  readonly node_count: number;
  readonly edge_count: number;
  readonly nodes_by_kind: Record<string, number>;
  readonly edges_by_kind: Record<string, number>;
  readonly orphan_edges: HealthSample<{ src: string; dst: string; kind: string }>;
  readonly isolated_nodes: HealthSample<string>;
  readonly stale_fts_rows: HealthSample<string>;
  readonly invalid_rows: HealthSample<string>;
  readonly invalid_edges: HealthSample<{ src: string; dst: string; kind: string }>;
  readonly db_path: string;
}

// FORGE-228 (Loom I4): the method surface is async. A remote/serverless backend
// (Neon Postgres) cannot be synchronous; the local SQLite backend wraps its sync
// bodies in async methods (zero behaviour change). Every caller awaits.
export interface MemoryBackend {
  // Delete every node + edge (in one txn). Keeps the schema/FTS table stable so
  // a rebuild re-inserts into the same shape — reindex is reset()+upsert.
  reset(): Promise<void>;
  upsertNodes(nodes: readonly MemoryNode[]): Promise<void>;
  upsertEdges(edges: readonly MemoryEdge[]): Promise<void>;
  // Atomic rebuild: validate ALL nodes/edges, then delete-all + insert-all inside
  // ONE transaction. This is what reindex uses so a validation failure (or any
  // throw) can NEVER leave a wiped DB — the prior graph is preserved on error
  // (GPT-5.5 re-review B3: reset()-then-upsert as two txns could delete the DB
  // and then throw on a malformed source row, losing the previous graph).
  replaceGraph(nodes: readonly MemoryNode[], edges: readonly MemoryEdge[]): Promise<void>;
  // Dependency-aware recall for a task node. Returns [] when the task is absent.
  recallForTask(taskId: string, opts?: RecallOptions): Promise<RecallHit[]>;
  status(): Promise<MemoryStatus>;
  // FORGE-227: ad-hoc graph inspection. query = node lookup; traverse = bounded
  // reachable subgraph from a node; doctor = graph health report. All three
  // validate rows on the way out (a corrupt DB fails loud for query/traverse and
  // is reported by doctor rather than crashing).
  query(filter: QueryFilter): Promise<MemoryNode[]>;
  traverse(nodeId: string, opts?: TraverseOptions): Promise<GraphSubgraph>;
  doctor(): Promise<GraphHealth>;
  close(): Promise<void>;
}
