// FORGE-200 (Loom I1): the reindex source-walkers.
//
// reindex() rebuilds the entire graph from two sources, deterministically:
//   - plans/phases.yaml → one `task` node per task (id `task:<id>`), with
//     depends_on edges between tasks.
//   - docs/learnings/**  → one `learning` node per REGULAR `.md` file (id
//     `learning:<repo-relative-posix-path>`), with learned_from edges to any
//     task ids referenced in the file's frontmatter.
//
// Node ids are pure functions of their source, so reindex is idempotent: drop
// the DB and rebuild → byte-identical logical graph. We backend.reset() then
// upsert sorted node/edge lists so the write order is deterministic too.

import { Dirent, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { loadPhases, resolvePhasesYaml } from '../core/phases.ts';
import { projectEvents } from './project.ts';
import {
  MEMORY_ATTR_ARRAY_MAX_LEN,
  MEMORY_ATTR_STRING_MAX_LEN,
  MEMORY_BODY_MAX_LEN,
  MEMORY_ID_MAX_LEN,
  MEMORY_TITLE_MAX_LEN,
  type MemoryEdge,
  type MemoryNode,
} from '../schemas/memory.ts';
import type { MemoryBackend } from './types.ts';

// Cap source-derived text to the schema bounds BEFORE constructing a node
// (GPT-5.5 cross-review B2): task title/description and learning titles come from
// unbounded sources (PhasesSchema title/description, frontmatter/H1), and
// upsertNodes re-validates through MemoryNodeSchema — so an over-long source
// string would otherwise throw mid-reindex. Truncate here so the write always
// fits; upsertNodes is the fail-closed gate for anything that still violates.
function capTitle(s: string): string {
  return s.length > MEMORY_TITLE_MAX_LEN ? s.slice(0, MEMORY_TITLE_MAX_LEN) : s;
}
function capBody(s: string): string {
  return s.length > MEMORY_BODY_MAX_LEN ? s.slice(0, MEMORY_BODY_MAX_LEN) : s;
}
// Cap write_globs into the attr bounds (count + per-string) so a task with many
// or very long globs does not trip the upsert validation gate (B3 reachability).
function capGlobs(globs: readonly string[]): string[] {
  return globs
    .slice(0, MEMORY_ATTR_ARRAY_MAX_LEN)
    .map((g) => (g.length > MEMORY_ATTR_STRING_MAX_LEN ? g.slice(0, MEMORY_ATTR_STRING_MAX_LEN) : g));
}

export interface ReindexArgs {
  readonly repoRoot: string;
  // FORGE-218: the orchestrator history root for the event projector. Loom has no
  // `--forge-dir` flag, so callers default this to <repoRoot>/.forge (matches the
  // loom context resolver). Defaulted here too so existing callers keep working.
  readonly forgeDir?: string;
  readonly backend: MemoryBackend;
}

export interface ReindexResult {
  readonly nodes: number;
  readonly edges: number;
  readonly learning_nodes: number;
  // FORGE-218: counts from the event projector (files_modified → file/touches).
  readonly file_nodes: number;
  readonly touches_edges: number;
  readonly warnings: string[];
}

const LEARNINGS_REL = path.join('docs', 'learnings');
// Bound the recursion so a pathological / symlink-looped tree cannot run away.
const MAX_LEARNINGS_DEPTH = 16;

export async function reindex(args: ReindexArgs): Promise<ReindexResult> {
  const warnings: string[] = [];
  const nodes: MemoryNode[] = [];
  const edges: MemoryEdge[] = [];

  // Track real task ids so learned_from edges only point at tasks that exist.
  const taskIds = new Set<string>();
  // Map tracker_issue_id → task node id so a learning may reference either form.
  const trackerToTask = new Map<string, string>();

  // ── 1. phases.yaml → task nodes + depends_on edges ──
  const phasesPath = resolvePhasesYaml(args.repoRoot);
  if (!phasesPath) {
    warnings.push(
      `no phases.yaml found under ${args.repoRoot} (looked for plans/phases.yaml, phases.yaml) — zero task nodes`,
    );
  } else {
    // loadPhases THROWS on parse/schema failure — let it surface loudly; an
    // unparseable roadmap is a real error the caller must see, not a silent skip.
    const { phases } = loadPhases(phasesPath);
    for (const phase of phases.phases) {
      for (const task of phase.tasks) {
        const nodeId = `task:${task.id}`;
        taskIds.add(nodeId);
        if (task.tracker_issue_id) trackerToTask.set(task.tracker_issue_id, nodeId);
        const attrs: Record<string, string | string[] | null> = {};
        if (task.tracker_issue_id) attrs.tracker_issue_id = task.tracker_issue_id;
        if (task.write_globs && task.write_globs.length > 0) {
          attrs.write_globs = capGlobs(task.write_globs);
        }
        nodes.push({
          id: nodeId,
          kind: 'task',
          title: capTitle(task.title),
          body: capBody(task.description),
          ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        });
      }
    }
    // depends_on edges: task:<id> → task:<dep>. PhasesSchema already validated
    // that every dep exists, but guard anyway (tolerant of an unexpected ref).
    for (const phase of phases.phases) {
      for (const task of phase.tasks) {
        for (const dep of task.depends_on) {
          const depNode = `task:${dep}`;
          if (!taskIds.has(depNode)) {
            warnings.push(`task ${task.id} depends_on unknown task ${dep} — edge skipped`);
            continue;
          }
          edges.push({ src: `task:${task.id}`, dst: depNode, kind: 'depends_on' });
        }
      }
    }
  }

  // ── 2. docs/learnings/** → learning nodes + learned_from edges ──
  const learningsDir = path.join(args.repoRoot, LEARNINGS_REL);
  const learningFiles = walkMarkdown(learningsDir, warnings);
  let learningCount = 0;
  for (const absFile of learningFiles) {
    let raw: string;
    try {
      raw = readFileSync(absFile, 'utf8');
    } catch (err) {
      warnings.push(
        `could not read learning ${absFile}: ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }
    // id = learning:<repo-relative posix path>.
    const relPosix = path.relative(args.repoRoot, absFile).split(path.sep).join('/');
    const nodeId = `learning:${relPosix}`;
    // A pathologically deep path could exceed the node-id bound. Skip it with a
    // warning rather than letting the upsert gate throw the whole reindex (B3).
    if (nodeId.length > MEMORY_ID_MAX_LEN) {
      warnings.push(
        `learning path too long for a node id (${nodeId.length} > ${MEMORY_ID_MAX_LEN}): ${relPosix} — skipped`,
      );
      continue;
    }
    const parsed = parseLearning(raw, path.basename(absFile));
    nodes.push({
      id: nodeId,
      kind: 'learning',
      title: capTitle(parsed.title),
      body: capBody(raw),
    });
    learningCount += 1;

    // learned_from edges: learning → task (tolerant — unknown ref → no edge).
    for (const ref of parsed.taskRefs) {
      const direct = `task:${ref}`;
      const resolved = taskIds.has(direct)
        ? direct
        : trackerToTask.get(ref) ?? null;
      if (!resolved) {
        warnings.push(`learning ${relPosix} references unknown task '${ref}' — edge skipped`);
        continue;
      }
      edges.push({ src: nodeId, dst: resolved, kind: 'learned_from' });
    }
  }

  // ── 3. event projection → file nodes + touches edges (FORGE-218) ──
  // Resolve an on-disk taskId (a phases id OR a tracker id — claim/dispatch write
  // whichever the caller passed) to its canonical task node id. Mirrors
  // backend.resolveTaskNodeId: prefixed `task:<id>` if known, else `task:<rawId>`
  // if known, else a task whose attrs.tracker_issue_id === rawId, else null
  // (dangling-edge guard — never emit a touches edge to a non-existent node).
  const resolveTaskNodeId = (rawId: string): string | null => {
    if (rawId.startsWith('task:')) return taskIds.has(rawId) ? rawId : null;
    const direct = `task:${rawId}`;
    if (taskIds.has(direct)) return direct;
    return trackerToTask.get(rawId) ?? null;
  };
  // Default forgeDir to <repoRoot>/.forge (loom has no --forge-dir flag). The
  // projector is best-effort: it NEVER throws — a missing/corrupt orchestrator
  // tree degrades to warnings + an empty projection so reindex still succeeds on
  // a repo with zero orchestrator history (the common adopter case).
  const forgeDir = args.forgeDir ?? path.join(args.repoRoot, '.forge');
  const projection = projectEvents({
    forgeDir,
    repoRoot: args.repoRoot,
    resolveTaskNodeId,
  });
  for (const fileNode of projection.fileNodes) nodes.push(fileNode);
  for (const touchEdge of projection.touchesEdges) edges.push(touchEdge);
  for (const w of projection.warnings) warnings.push(w);

  // ── 4. deterministic write: reset, then upsert sorted lists ──
  // Sort so repeated reindex produces an identical write order (idempotency).
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => {
    if (a.src !== b.src) return a.src < b.src ? -1 : 1;
    if (a.dst !== b.dst) return a.dst < b.dst ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  // Atomic rebuild: validate-all + delete-all + insert-all in ONE transaction so
  // a malformed source row can never wipe the prior graph and then fail (B3).
  args.backend.replaceGraph(nodes, edges);

  return {
    nodes: nodes.length,
    edges: edges.length,
    learning_nodes: learningCount,
    file_nodes: projection.fileNodes.length,
    touches_edges: projection.touchesEdges.length,
    warnings,
  };
}

// ── learning frontmatter / title parsing ───────────────────────────────────────
interface ParsedLearning {
  readonly title: string;
  readonly taskRefs: string[];
}

// Tolerant parse: title from YAML frontmatter `title:`, else the first `# `
// heading, else the filename. Task refs from frontmatter `tasks:` (array or
// scalar) and/or `task:` (scalar). Missing → no refs (no edge).
function parseLearning(raw: string, filename: string): ParsedLearning {
  let frontTitle: string | undefined;
  const taskRefs: string[] = [];

  // YAML frontmatter is a leading `---\n ... \n---` block.
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (fm && fm[1] !== undefined) {
    try {
      const meta = parseYaml(fm[1]) as unknown;
      if (meta && typeof meta === 'object') {
        const m = meta as Record<string, unknown>;
        if (typeof m.title === 'string' && m.title.trim().length > 0) {
          frontTitle = m.title.trim();
        }
        collectRefs(m.tasks, taskRefs);
        collectRefs(m.task, taskRefs);
      }
    } catch {
      // Malformed frontmatter is tolerated: fall back to h1/filename, no refs.
    }
  }

  // First markdown h1 heading (after any frontmatter).
  let h1Title: string | undefined;
  const body = fm ? raw.slice(fm[0].length) : raw;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1 && h1[1] !== undefined) h1Title = h1[1].trim();

  const title = frontTitle ?? h1Title ?? filename;
  return { title: title.length > 0 ? title : filename, taskRefs };
}

function collectRefs(value: unknown, out: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.length > 0) out.push(t);
    return;
  }
  if (typeof value === 'number') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  }
}

// ── recursive markdown walk (regular files only; skip symlinks) ────────────────
// Uses withFileTypes so we can skip symlinks WITHOUT following them — a symlinked
// directory could escape the tree or loop. Only regular `.md` files are emitted.
function walkMarkdown(dir: string, warnings: string[]): string[] {
  const out: string[] = [];
  const recur = (current: string, depth: number): void => {
    if (depth > MAX_LEARNINGS_DEPTH) {
      warnings.push(`learnings walk hit max depth at ${current} — stopped descending`);
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // An absent learnings dir is fine (empty → zero learning nodes); any other
      // read error is surfaced as a warning rather than crashing the reindex.
      if (code !== 'ENOENT') {
        warnings.push(
          `could not read directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      if (entry.isDirectory()) {
        recur(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  recur(dir, 0);
  return out;
}
