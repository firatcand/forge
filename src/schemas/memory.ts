// FORGE-200 (Loom I1): zod schemas for the local memory graph.
//
// Loom INDEXES, never competes: every node id is a pure function of its source
// (`task:<id>`, `learning:<repo-relative-path>`), so `reindex` is idempotent and
// the DB is a fully-rebuildable derived cache. These schemas are the validation
// boundary on the way IN (ingest) and OUT (read from a possibly-stale DB): all
// `.strict()` (reject unexpected keys) with bounded strings so a corrupt row or
// runaway source file cannot blow up recall.

import { z } from 'zod';

// ── Node / edge kinds ────────────────────────────────────────────────────────
// I1 shipped two node kinds and two edge kinds. FORGE-218 (Loom I2a) adds the
// `file` node kind + `touches` edge kind — projected from `files_modified`
// attempt events (file:<repo-relative-posix-path> nodes; task→file touches
// edges). FORGE-219 (Loom I2b-1) adds the `symbol` node kind + `defines` edge
// kind — code symbols (functions/classes/methods/types) extracted from source
// files via bundled tree-sitter (symbol:<sha256(relpath#name@line)> nodes;
// file→symbol `defines` edges). The enums are additive so the I1/I2a graph stays
// valid; `references` edges (symbol mentions) arrive in I2b-2.
export const NODE_KINDS = ['task', 'learning', 'file', 'symbol'] as const;
export const EDGE_KINDS = ['depends_on', 'learned_from', 'touches', 'defines'] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

// Defensive bounds. Node ids are short (`task:<id>` / `learning:<relpath>`);
// titles are a heading; a learning body can be a long markdown file but never a
// megabyte. attrs values stash source metadata (tracker_issue_id, write_globs).
const MAX_ID_LEN = 256;
const MAX_TITLE_LEN = 512;
const MAX_BODY_LEN = 100_000;
const MAX_ATTR_STRING_LEN = 2048;
const MAX_ATTR_ARRAY_LEN = 512;

// A single attribute value: a bounded string, a bounded array of bounded
// strings, or null. attrs is stored JSON-encoded in a TEXT column and revalidated
// through this schema on read, so a hand-edited / corrupt DB row fails loudly.
const AttrValueSchema = z.union([
  z.string().max(MAX_ATTR_STRING_LEN),
  z.array(z.string().max(MAX_ATTR_STRING_LEN)).max(MAX_ATTR_ARRAY_LEN),
  z.null(),
]);

export const MemoryNodeSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN),
    kind: z.enum(NODE_KINDS),
    title: z.string().min(1).max(MAX_TITLE_LEN),
    body: z.string().max(MAX_BODY_LEN),
    // Optional bag of source metadata (e.g. tracker_issue_id, write_globs).
    attrs: z.record(z.string(), AttrValueSchema).optional(),
  })
  .strict();

export const MemoryEdgeSchema = z
  .object({
    src: z.string().min(1).max(MAX_ID_LEN),
    dst: z.string().min(1).max(MAX_ID_LEN),
    kind: z.enum(EDGE_KINDS),
  })
  .strict();

// A recall result. `source` records HOW the hit was found: `structural` =
// graph-linked (depends_on ancestors → learned_from), ranked ABOVE `fts` =
// full-text match on the task's title+description. `why` is a human provenance
// string surfaced to the implementer.
export const RECALL_SOURCES = ['structural', 'fts'] as const;
export type RecallSource = (typeof RECALL_SOURCES)[number];

export const RecallHitSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN),
    kind: z.enum(NODE_KINDS),
    title: z.string().min(1).max(MAX_TITLE_LEN),
    score: z.number(),
    why: z.string().min(1),
    source: z.enum(RECALL_SOURCES),
  })
  .strict();

export type MemoryNode = z.infer<typeof MemoryNodeSchema>;
export type MemoryEdge = z.infer<typeof MemoryEdgeSchema>;
export type RecallHit = z.infer<typeof RecallHitSchema>;

// Shared bounds so ingest can cap a node's title/body to the schema max BEFORE
// it constructs a node (avoids a validation throw on a huge file / long title).
// upsertNodes additionally re-validates every node through MemoryNodeSchema as a
// fail-closed enforcement gate, so these caps are the contract on BOTH paths.
export const MEMORY_BODY_MAX_LEN = MAX_BODY_LEN;
export const MEMORY_TITLE_MAX_LEN = MAX_TITLE_LEN;
export const MEMORY_ID_MAX_LEN = MAX_ID_LEN;
export const MEMORY_ATTR_STRING_MAX_LEN = MAX_ATTR_STRING_LEN;
export const MEMORY_ATTR_ARRAY_MAX_LEN = MAX_ATTR_ARRAY_LEN;
