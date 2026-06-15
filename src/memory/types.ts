// FORGE-200 (Loom I1): the pluggable memory backend interface.
//
// I1 ships ONE implementation (local SQLite WAL+FTS5, src/memory/local/). The
// interface is deliberately minimal — only what `reindex`/`recall`/`status`
// need. No traversal/prune/bulkUnlink: those arrive with later increments.
// Athena (a remote backend) is a future variant behind createBackend().

import type { MemoryEdge, MemoryNode, RecallHit } from '../schemas/memory.ts';

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

export interface MemoryBackend {
  // Delete every node + edge (in one txn). Keeps the schema/FTS table stable so
  // a rebuild re-inserts into the same shape — reindex is reset()+upsert.
  reset(): void;
  upsertNodes(nodes: readonly MemoryNode[]): void;
  upsertEdges(edges: readonly MemoryEdge[]): void;
  // Atomic rebuild: validate ALL nodes/edges, then delete-all + insert-all inside
  // ONE transaction. This is what reindex uses so a validation failure (or any
  // throw) can NEVER leave a wiped DB — the prior graph is preserved on error
  // (GPT-5.5 re-review B3: reset()-then-upsert as two txns could delete the DB
  // and then throw on a malformed source row, losing the previous graph).
  replaceGraph(nodes: readonly MemoryNode[], edges: readonly MemoryEdge[]): void;
  // Dependency-aware recall for a task node. Returns [] when the task is absent.
  recallForTask(taskId: string, opts?: RecallOptions): RecallHit[];
  status(): MemoryStatus;
  close(): void;
}
