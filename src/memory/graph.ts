// FORGE-228 (Loom I4): backend-agnostic graph algorithms + the read-primitive
// seam shared by every MemoryBackend.
//
// The intricate, parity-critical logic — recall (depends_on BFS + co-touch +
// structural learnings/decisions + symbol surfacing + FTS) and traverse (bounded
// bidirectional BFS) — lives here ONCE, expressed over a small async
// `GraphReadPrimitives` interface. The local SQLite backend and the remote
// Postgres backend each implement those primitives in their own dialect, then
// delegate recall/traverse here, so the two backends can never drift. The shipped
// local test suite (test/unit/memory/*) is the guard on this extraction.
//
// FTS parity (Codex): tokenization is shared (`tokenizeFtsTerms`); only the
// dialect query string differs (FTS5 quoted-OR vs Postgres `to_tsquery('simple')`).

import {
  MemoryEdgeSchema,
  MemoryNodeSchema,
  type EdgeKind,
  type MemoryEdge,
  type MemoryNode,
  type NodeKind,
  type RecallHit,
} from '../schemas/memory.ts';
import { matchAny, InvalidGlobError } from '../orchestrator/glob-match.ts';
import type { GraphSubgraph, RecallOptions, TraverseOptions } from './types.ts';

// ── shared constants (single source for both backends) ──────────────────────────
export const DEFAULT_RECALL_LIMIT = 20;
export const DEFAULT_MAX_DEPTH = 6;

// FORGE-227 (symbol recall): symbols rank BELOW learnings/decisions (1000), ABOVE
// fts (1). Bounded per-file and overall so one giant file cannot flood recall.
export const SYMBOL_RECALL_SCORE = 900;
export const MAX_SYMBOL_HITS_PER_FILE = 20;
export const MAX_SYMBOL_HITS_TOTAL = 100;

// FORGE-227 (query/traverse/doctor): hard bounds so a single inspection call on a
// huge/corrupt graph stays finite. Every limit is clamped to its MAX.
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;
export const DEFAULT_TRAVERSE_DEPTH = 2;
export const MAX_TRAVERSE_DEPTH = 6;
export const DEFAULT_TRAVERSE_MAX_NODES = 200;
export const MAX_TRAVERSE_EDGES = 2000;
// Per-node, per-direction expansion cap during BFS: a high-degree node cannot
// materialize an unbounded row set before the node cap kicks in.
export const MAX_EDGE_EXPANSION = 1000;
export const DOCTOR_SAMPLE_CAP = 50;
// Page size for doctor's row-validation scans (one bounded page in memory).
export const DOCTOR_SCAN_PAGE = 1000;

// A raw node row as read from either backend (attrs is the JSON-encoded TEXT/jsonb
// payload as a string, or null). The shared validators turn it into a MemoryNode.
export interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly attrs: string | null;
}

// ── shared pure helpers ─────────────────────────────────────────────────────────

// Clamp a caller-supplied limit to [1, max], defaulting when absent.
export function clampLimit(value: number | undefined, dflt: number, max: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return dflt;
  return Math.min(value, max);
}

// Escape LIKE/ILIKE wildcards so `--title` is a literal substring, never a
// pattern. Paired with `ESCAPE '\'` in the query.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Clip a sample value so a hand-edited DB with a megabyte id/kind cannot blow up
// doctor's output. Coerces non-string scalars (a corrupt row may carry a NULL or
// numeric id under the TEXT schema) so the diagnostic never throws on the very
// corruption it reports.
const SAMPLE_STR_MAX = 256;
export function clip(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  return s.length > SAMPLE_STR_MAX ? `${s.slice(0, SAMPLE_STR_MAX)}…` : s;
}

export function stripTaskPrefix(id: string): string {
  return id.startsWith('task:') ? id.slice('task:'.length) : id;
}

export function stripFilePrefix(id: string): string {
  return id.startsWith('file:') ? id.slice('file:'.length) : id;
}

// Convert a raw row into a VALIDATED MemoryNode. attrs is JSON-encoded; parse it
// and re-validate the whole node through MemoryNodeSchema (bounded fields, known
// kind, strict keys). Throws on a corrupt row — query/traverse fail loud; doctor
// catches per-row; recall drops via getValidNode.
export function rowToNode(row: NodeRow): MemoryNode {
  let attrs: unknown;
  if (row.attrs !== null) {
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

// FORGE-228: shared FTS tokenization (was buildFtsQuery's front half). Lowercase,
// split on any non-alphanumeric run, drop the FTS bareword operators, keep
// non-empty. Each backend turns these tokens into its dialect query (FTS5 quoted
// OR-join; Postgres `to_tsquery('simple', terms.join(' | '))`) so recall matches
// the SAME token set regardless of backend.
const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near']);
export function tokenizeFtsTerms(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !FTS_OPERATORS.has(t));
}

// ── the read-primitive seam ─────────────────────────────────────────────────────
// The minimal dialect-specific surface recall + traverse need. Each backend
// implements these (sqlite / postgres); the algorithms below consume them.
export interface GraphReadPrimitives {
  // Single node row by id (undefined when absent).
  getNode(id: string): Promise<NodeRow | undefined>;
  // dst ids of edges (kind, src=?), ordered by dst; optional row cap.
  edgesFrom(kind: EdgeKind, src: string, limit?: number): Promise<string[]>;
  // src ids of edges (kind, dst=?).
  edgesTo(kind: EdgeKind, dst: string): Promise<string[]>;
  // ids of all nodes of a given kind.
  nodeIdsByKind(kind: NodeKind): Promise<string[]>;
  // Resolve an arbitrary task reference (task:<id> | <phasesId> | tracker_issue_id)
  // to its node id (dialect-specific JSON lookup).
  resolveTaskNodeId(input: string): Promise<string | undefined>;
  // Ranked node ids for an FTS search over the given tokens. Excludes file/symbol
  // nodes (they are structural-only). Returns [] for empty tokens.
  ftsSearch(terms: string[]): Promise<string[]>;
  // DISTINCT out-neighbours (dst) of a node, ordered by dst, capped.
  distinctOutNeighbors(id: string, cap: number): Promise<string[]>;
  // DISTINCT in-neighbours (src) of a node, ordered by src, capped.
  distinctInNeighbors(id: string, cap: number): Promise<string[]>;
  // Edges with BOTH endpoints in `ids` (ordered src,dst,kind), up to `limit` rows.
  internalEdges(ids: string[], limit: number): Promise<Array<{ src: string; dst: string; kind: string }>>;
}

// Best-effort validated read for the RECALL path: a row that fails the schema
// boundary is DROPPED (recall feeds /pickup-task and must never crash on one
// corrupt row). doctor surfaces such rows instead.
async function getValidNode(prims: GraphReadPrimitives, id: string): Promise<MemoryNode | undefined> {
  const row = await prims.getNode(id);
  if (!row) return undefined;
  try {
    return rowToNode(row);
  } catch {
    return undefined;
  }
}

// BFS over depends_on edges (src --depends_on--> dst). Returns the ancestor ids
// reachable from `start`, excluding `start`. Bounded by the visited-set (loop
// guard) and maxDepth.
async function bfsDependsOn(
  prims: GraphReadPrimitives,
  start: string,
  maxDepth: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  const visited = new Set<string>([start]);
  let frontier: string[] = [start];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const node of frontier) {
      const dsts = await prims.edgesFrom('depends_on', node);
      for (const dst of dsts) {
        if (visited.has(dst)) continue; // visited-set: a corrupt cycle cannot loop
        visited.add(dst);
        out.add(dst);
        next.push(dst);
      }
    }
    frontier = next;
    depth += 1;
  }
  return out;
}

// Collect the union of write_globs across a set of task nodes (co-touch fallback).
// A corrupt / non-array attrs value is tolerated (skipped), never throws recall.
async function collectScopeWriteGlobs(
  prims: GraphReadPrimitives,
  scope: Set<string>,
): Promise<string[]> {
  const out = new Set<string>();
  for (const id of scope) {
    const node = await prims.getNode(id);
    if (!node || node.kind !== 'task' || node.attrs === null) continue;
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

// FORGE-228: dependency-aware recall, shared across backends. Verbatim port of the
// I1→I3 local algorithm, re-expressed over GraphReadPrimitives. Returns [] when
// the task is absent.
export async function recallForTask(
  prims: GraphReadPrimitives,
  taskId: string,
  opts?: RecallOptions,
): Promise<RecallHit[]> {
  const limit = opts?.limit ?? DEFAULT_RECALL_LIMIT;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;

  const taskNodeId = await prims.resolveTaskNodeId(taskId);
  if (!taskNodeId) return [];
  const taskRow = await prims.getNode(taskNodeId);
  if (!taskRow) return [];

  // 1. BFS over depends_on ancestors.
  const ancestors = await bfsDependsOn(prims, taskNodeId, maxDepth);
  const scope = new Set<string>([taskNodeId, ...ancestors]);

  const hits: RecallHit[] = [];
  const seen = new Set<string>();

  // 2. CO-TOUCH expansion: candidate files = `touches` dsts of scope ∪ file nodes
  // whose path matches a scope node's write_globs.
  const candidateFiles = new Set<string>();
  for (const member of scope) {
    for (const dst of await prims.edgesFrom('touches', member)) candidateFiles.add(dst);
  }
  // Files the scope ACTUALLY touched (pre-glob), sorted — symbol surfacing uses
  // this subset (the glob expansion only widens co-toucher discovery).
  const scopeTouchedFiles = [...candidateFiles].sort();
  const scopeGlobs = await collectScopeWriteGlobs(prims, scope);
  if (scopeGlobs.length > 0) {
    for (const fileId of await prims.nodeIdsByKind('file')) {
      const relpath = fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
      try {
        if (matchAny(relpath, scopeGlobs).matched) candidateFiles.add(fileId);
      } catch (e) {
        if (!(e instanceof InvalidGlobError)) throw e;
      }
    }
  }

  // co-touching tasks = src of `touches` edges to candidate files, excluding scope.
  const coTouchVia = new Map<string, string>();
  for (const file of candidateFiles) {
    for (const src of await prims.edgesTo('touches', file)) {
      if (scope.has(src)) continue;
      if (!coTouchVia.has(src)) coTouchVia.set(src, file);
    }
  }

  // 3. STRUCTURAL learning + decision hits.
  const addStructuralLearnings = async (target: string, via: string): Promise<void> => {
    for (const src of await prims.edgesTo('learned_from', target)) {
      if (seen.has(src)) continue;
      const node = await getValidNode(prims, src);
      if (!node || node.kind !== 'learning') continue;
      seen.add(src);
      hits.push({ id: node.id, kind: 'learning', title: node.title, score: 1000, why: via, source: 'structural' });
    }
  };
  const addStructuralDecisions = async (target: string, viaPrefix: string): Promise<void> => {
    for (const edgeKind of ['decided_in', 'affects'] as const) {
      for (const src of await prims.edgesTo(edgeKind, target)) {
        if (seen.has(src)) continue;
        const node = await getValidNode(prims, src);
        if (!node || node.kind !== 'decision') continue;
        seen.add(src);
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
  for (const target of scope) {
    const via =
      target === taskNodeId
        ? `linked via learned_from→${stripTaskPrefix(target)}`
        : `linked via depends_on→${stripTaskPrefix(target)} learned_from`;
    await addStructuralLearnings(target, via);
    const decisionVia =
      target === taskNodeId
        ? `decided in ${stripTaskPrefix(target)}`
        : `decided in depends_on ancestor ${stripTaskPrefix(target)}`;
    await addStructuralDecisions(target, decisionVia);
  }
  for (const [coTask, sharedFile] of coTouchVia) {
    const via = `co-touched file ${stripFilePrefix(sharedFile)} with task ${stripTaskPrefix(coTask)}; its learning`;
    await addStructuralLearnings(coTask, via);
  }

  // 3b. STRUCTURAL symbol hits: symbols DEFINED in files the scope touched.
  let symbolHitCount = 0;
  for (const file of scopeTouchedFiles) {
    if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
    for (const dst of await prims.edgesFrom('defines', file, MAX_SYMBOL_HITS_PER_FILE)) {
      if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
      if (seen.has(dst)) continue;
      const node = await getValidNode(prims, dst);
      if (!node || node.kind !== 'symbol') continue;
      seen.add(dst);
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

  // 3c. STRUCTURAL symbol hits via `mentions` (FORGE-229): symbols NAMED in a
  // scope task's text or in a learning/decision already surfaced above. Shares the
  // symbol budget (symbolHitCount) with 3b so recall can never exceed the cap.
  // `references` (symbol→symbol) is deliberately NOT walked here — recall is
  // task-anchored, so call-graph edges serve `traverse`, not recall.
  const mentionSources: Array<{ id: string; label: string }> = [];
  for (const t of scope) {
    mentionSources.push({ id: t, label: `mentioned in ${stripTaskPrefix(t)}` });
  }
  for (const h of [...hits]) {
    if (h.kind === 'learning' || h.kind === 'decision') {
      mentionSources.push({ id: h.id, label: `mentioned in ${h.kind} ${h.id}` });
    }
  }
  for (const srcNode of mentionSources) {
    if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
    for (const dst of await prims.edgesFrom('mentions', srcNode.id, MAX_SYMBOL_HITS_PER_FILE)) {
      if (symbolHitCount >= MAX_SYMBOL_HITS_TOTAL) break;
      if (seen.has(dst)) continue;
      const node = await getValidNode(prims, dst);
      if (!node || node.kind !== 'symbol') continue;
      seen.add(dst);
      symbolHitCount += 1;
      hits.push({
        id: node.id,
        kind: 'symbol',
        title: node.title,
        score: SYMBOL_RECALL_SCORE,
        why: srcNode.label,
        source: 'structural',
      });
    }
  }

  // 4. FTS hits over title+body using the task's title+description.
  const terms = tokenizeFtsTerms(`${taskRow.title} ${taskRow.body}`);
  if (terms.length > 0) {
    for (const id of await prims.ftsSearch(terms)) {
      if (id === taskNodeId) continue;
      if (seen.has(id)) continue;
      const node = await getValidNode(prims, id);
      if (!node) continue;
      if (node.kind === 'file') continue; // belt: never surface a file as a hit
      seen.add(id);
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

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// FORGE-228: bounded reachable subgraph from `nodeId`, shared across backends.
// BFS over edges in BOTH directions up to `depth` hops, capped at a max node
// count; the visited-set is the loop guard. Returns every edge whose BOTH
// endpoints are in the returned node set (sorted, capped) — dangling edges never
// appear. `truncated` flags that a cap was hit.
export async function traverseGraph(
  prims: GraphReadPrimitives,
  nodeId: string,
  opts?: TraverseOptions,
): Promise<GraphSubgraph> {
  const depth = clampLimit(opts?.depth, DEFAULT_TRAVERSE_DEPTH, MAX_TRAVERSE_DEPTH);
  const maxNodes = clampLimit(opts?.limit, DEFAULT_TRAVERSE_MAX_NODES, DEFAULT_TRAVERSE_MAX_NODES);
  if (!(await prims.getNode(nodeId))) {
    return { root: nodeId, nodes: [], edges: [], truncated: false };
  }

  const visited = new Set<string>([nodeId]);
  let truncated = false;
  let frontier: string[] = [nodeId];
  let d = 0;
  while (frontier.length > 0 && d < depth) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const neighbours of [
        await prims.distinctOutNeighbors(cur, MAX_EDGE_EXPANSION),
        await prims.distinctInNeighbors(cur, MAX_EDGE_EXPANSION),
      ]) {
        // The neighbour read itself hit the cap → more may exist beyond it.
        if (neighbours.length >= MAX_EDGE_EXPANSION) truncated = true;
        for (const n of neighbours) {
          if (visited.has(n)) continue;
          if (visited.size >= maxNodes) {
            truncated = true;
            continue;
          }
          visited.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
    d += 1;
  }

  // Materialize only nodes that actually exist; validate each on the way out.
  const present = new Set<string>();
  const nodes: MemoryNode[] = [];
  for (const id of [...visited].sort()) {
    const row = await prims.getNode(id);
    if (!row) continue;
    nodes.push(rowToNode(row));
    present.add(id);
  }

  // Internal edges only: BOTH endpoints present. Fetch one past the cap to detect
  // (and flag) genuine edge truncation.
  const edges: MemoryEdge[] = [];
  const presentIds = [...present].sort();
  if (presentIds.length > 0) {
    const rows = await prims.internalEdges(presentIds, MAX_TRAVERSE_EDGES + 1);
    if (rows.length > MAX_TRAVERSE_EDGES) truncated = true;
    for (const r of rows.slice(0, MAX_TRAVERSE_EDGES)) edges.push(MemoryEdgeSchema.parse(r));
  }
  return { root: nodeId, nodes, edges, truncated };
}
