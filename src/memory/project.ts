// FORGE-218 (Loom I2a): the event projector.
//
// Walks the orchestrator attempt history (<forgeDir>/orchestrator/tasks/<id>/
// attempts/<aid>/events.jsonl) and projects every `files_modified` event into
// the Loom graph: one `file:<repo-relative-posix-path>` node per distinct touched
// path, plus a `touches` edge `task:<canonical> → file:<relpath>` per (task,file)
// pair. reindex folds these into the same atomic rebuild as task/learning nodes,
// so the projection is idempotent (pure-fn ids + dedup + sort).
//
// This is BEST-EFFORT and NEVER throws (the common adopter repo has zero
// orchestrator history, and a hand-corrupted tree must not crash reindex):
//   - missing orchestrator/tasks dir → empty result, no warning.
//   - a malformed task/attempt dir name (validateOrchestratorId throws) → warn +
//     skip that entry (B3 — mirrors readiness.ts:collectTasksByState).
//   - an unreadable / malformed events.jsonl → warn + skip that attempt.
//   - `files_modified.files` are UNTRUSTED worker self-reports (attempt.ts allows
//     any non-empty string) → each path must pass isSafeRepoRelativePath (B2,
//     the audit grammar: rejects absolute posix+win32, `../`, backslash, NUL/
//     control, empty/./.. segments); unsafe → warn + skip that path.
//   - a taskId that resolves to no known task node → warn + skip ALL its touches
//     (dangling-edge guard: never emit an edge to a non-existent node).

import { readdirSync, type Dirent } from 'node:fs';

import { isSafeRepoRelativePath } from '../schemas/audit.ts';
import {
  MEMORY_ID_MAX_LEN,
  type MemoryEdge,
  type MemoryNode,
} from '../schemas/memory.ts';
import { readAttemptEvents } from '../orchestrator/attempt-events.ts';
import { attemptsDir, tasksRootDir } from '../orchestrator/questions/paths.ts';

// Bound the total number of distinct touched paths the projector will mint into
// file nodes. A runaway/hostile history must not be able to balloon the graph;
// once the cap is hit we stop collecting new paths and warn (truncation). The
// bound is generous — real repos touch far fewer files across all attempts.
const MAX_TOUCHED_PATHS = 50_000;

export interface ProjectEventsArgs {
  readonly forgeDir: string;
  readonly repoRoot: string;
  // Resolve an on-disk taskId (a phases id OR a tracker id) to a canonical task
  // NODE id (`task:<phasesId>`), or null when no task node matches (dangling
  // guard). Built by ingest from the task nodes it just constructed.
  readonly resolveTaskNodeId: (rawId: string) => string | null;
}

export interface ProjectEventsResult {
  readonly fileNodes: MemoryNode[];
  readonly touchesEdges: MemoryEdge[];
  readonly warnings: string[];
}

export function projectEvents(args: ProjectEventsArgs): ProjectEventsResult {
  const warnings: string[] = [];
  // Distinct file paths → ensures one `file:` node per path (dedup).
  const filePaths = new Set<string>();
  // Distinct (canonicalTaskNodeId, fileNodeId) pairs → one touches edge each.
  const touchPairs = new Set<string>();
  const touchesEdges: MemoryEdge[] = [];
  let truncated = false;

  // ── 1. enumerate orchestrator task dirs (regular dirs, not symlinks). ──
  const tasksRoot = tasksRootDir(args.forgeDir);
  let taskEntries: Dirent[];
  try {
    taskEntries = readdirSync(tasksRoot, { withFileTypes: true });
  } catch (err) {
    // Absent orchestrator/tasks is the COMMON case (most adopter repos have no
    // orchestrator history) → empty projection, no warning. Any other read error
    // degrades to a warning but never throws.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(
        `loom projector: could not read ${tasksRoot}: ${err instanceof Error ? err.message : String(err)} — no file nodes`,
      );
    }
    return { fileNodes: [], touchesEdges: [], warnings };
  }

  // Deterministic traversal (GPT-5.5 B2): sort dir entries so that when the
  // MAX_TOUCHED_PATHS cap is hit, WHICH paths survive does not depend on
  // filesystem readdir order — otherwise a capped history yields a
  // non-deterministic graph across reindex runs.
  taskEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  outer: for (const taskEnt of taskEntries) {
    // Only real directories: a symlinked task dir could escape the tree.
    if (taskEnt.isSymbolicLink()) {
      warnings.push(`loom projector: task dir '${taskEnt.name}' is a symlink — skipped`);
      continue;
    }
    if (!taskEnt.isDirectory()) continue;
    const taskId = taskEnt.name;

    // Resolve the on-disk id to a canonical task node id up-front. A taskId that
    // matches no task node → skip ALL of its touches (dangling-edge guard).
    let canonicalTaskNodeId: string | null;
    try {
      canonicalTaskNodeId = args.resolveTaskNodeId(taskId);
    } catch (err) {
      warnings.push(
        `loom projector: failed to resolve task '${taskId}': ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }
    if (canonicalTaskNodeId === null) {
      warnings.push(
        `loom projector: task dir '${taskId}' matches no task node — touches skipped (dangling-edge guard)`,
      );
      continue;
    }

    // attemptsDir() validates the id segment and THROWS on a malformed dir name.
    // Wrap it (B3) so a hand-corrupted task dir name warns + skips, never throws.
    let attemptsRoot: string;
    try {
      attemptsRoot = attemptsDir(args.forgeDir, taskId);
    } catch (err) {
      warnings.push(
        `loom projector: invalid task dir name '${taskId}': ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }

    let attemptEntries: Dirent[];
    try {
      attemptEntries = readdirSync(attemptsRoot, { withFileTypes: true });
    } catch (err) {
      // No attempts dir (task never dispatched) → nothing to project; skip.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(
          `loom projector: could not read ${attemptsRoot}: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
      }
      continue;
    }

    attemptEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const attemptEnt of attemptEntries) {
      if (attemptEnt.isSymbolicLink()) {
        warnings.push(`loom projector: attempt dir '${taskId}/${attemptEnt.name}' is a symlink — skipped`);
        continue;
      }
      if (!attemptEnt.isDirectory()) continue;
      const attemptId = attemptEnt.name;

      // readAttemptEvents validates the id segments (throws on a bad name) and
      // throws OrchestratorError IO_ERROR on a non-ENOENT read failure. Catch
      // per-attempt: a single unreadable attempt warns + skips, never throws.
      let lines: ReturnType<typeof readAttemptEvents>;
      try {
        lines = readAttemptEvents({
          forgeDir: args.forgeDir,
          taskId,
          attemptId,
        });
      } catch (err) {
        warnings.push(
          `loom projector: could not read events for ${taskId}/${attemptId}: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
        continue;
      }

      for (const line of lines) {
        // Malformed lines are returned as { ok: false } by readAttemptEvents —
        // skip them silently (they are already-tolerated junk, not our concern).
        if (!line.ok) continue;
        if (line.event.type !== 'files_modified') continue;

        for (const rawFile of line.event.files) {
          // B2: files are untrusted worker self-reports. Reject anything that is
          // not a safe repo-relative path (absolute, `../` escape, backslash,
          // NUL/control, empty/./.. segment) — warn + skip the path.
          if (!isSafeRepoRelativePath(rawFile)) {
            warnings.push(
              `loom projector: unsafe file path '${rawFile}' from ${taskId}/${attemptId} — skipped`,
            );
            continue;
          }
          // Survivors are already forward-slash, segment-clean (the grammar
          // rejects backslashes), so they are posix-normalized as-is.
          const relPosix = rawFile;
          const fileNodeId = `file:${relPosix}`;

          // A pathologically long path would overflow the node-id bound and trip
          // the upsert gate — skip + warn (mirrors ingest's learning-id guard).
          if (fileNodeId.length > MEMORY_ID_MAX_LEN) {
            warnings.push(
              `loom projector: file path too long for a node id (${fileNodeId.length} > ${MEMORY_ID_MAX_LEN}): ${relPosix} — skipped`,
            );
            continue;
          }

          if (!filePaths.has(relPosix)) {
            if (filePaths.size >= MAX_TOUCHED_PATHS) {
              // Cap reached: stop collecting NEW paths (existing ones still get
              // edges below). Warn once, then bail the whole walk.
              truncated = true;
              break outer;
            }
            filePaths.add(relPosix);
          }

          // One touches edge per (canonical task, file) pair.
          const pairKey = `${canonicalTaskNodeId} ${fileNodeId}`;
          if (!touchPairs.has(pairKey)) {
            touchPairs.add(pairKey);
            touchesEdges.push({
              src: canonicalTaskNodeId,
              dst: fileNodeId,
              kind: 'touches',
            });
          }
        }
      }
    }
  }

  if (truncated) {
    warnings.push(
      `loom projector: touched-path cap (${MAX_TOUCHED_PATHS}) reached — projection truncated`,
    );
  }

  // ── 2. build deterministic, sorted outputs. ──
  // File nodes: title = the repo-relative path, body = '' (files are structural
  // intermediaries, NOT FTS content — the backend excludes kind:'file' from FTS).
  const fileNodes: MemoryNode[] = Array.from(filePaths)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((relPosix) => ({
      id: `file:${relPosix}`,
      kind: 'file' as const,
      title: relPosix,
      body: '',
    }));

  touchesEdges.sort((a, b) => {
    if (a.src !== b.src) return a.src < b.src ? -1 : 1;
    if (a.dst !== b.dst) return a.dst < b.dst ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  return { fileNodes, touchesEdges, warnings };
}
