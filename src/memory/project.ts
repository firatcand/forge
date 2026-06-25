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

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { isSafeRepoRelativePath } from '../schemas/audit.ts';
import {
  MemoryEdgeSchema,
  MemoryNodeSchema,
  MEMORY_BODY_MAX_LEN,
  MEMORY_ID_MAX_LEN,
  MEMORY_TITLE_MAX_LEN,
  MEMORY_ATTR_STRING_MAX_LEN,
  type MemoryEdge,
  type MemoryNode,
} from '../schemas/memory.ts';
import { AnswerSchema, QuestionSchema } from '../schemas/questions.ts';
import { ApplyJournalSchema } from '../schemas/apply-journal.ts';
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

  // Canonical real .forge root for symlink containment — a symlinked PARENT
  // component (e.g. `orchestrator/tasks` → external) would otherwise let the walk
  // enumerate + ingest events from outside the tree (FORGE-226 hardening; closes
  // the same gap in this shipped I2a projector). Absent .forge is the COMMON
  // adopter case → project nothing, no warning.
  const realRoot = realForgeRootOrNull(args.forgeDir, warnings, 'loom projector');
  if (realRoot === null) return { fileNodes: [], touchesEdges: [], warnings };

  // ── 1. enumerate orchestrator task dirs (regular dirs, not symlinks). ──
  const tasksRoot = tasksRootDir(args.forgeDir);
  // safeReaddir: lstat (skip symlink/non-dir) + realpath containment under
  // .forge, then readdir. Absent/escaping → [] → empty projection.
  const taskEntries = safeReaddir(tasksRoot, 'orchestrator/tasks', realRoot, warnings, 'loom projector');

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

    // safeReaddir: containment-checked (a symlinked `attempts` dir cannot escape
    // .forge). Absent (task never dispatched) → [] → nothing to project.
    const attemptEntries = safeReaddir(
      attemptsRoot,
      `${taskId}/attempts`,
      realRoot,
      warnings,
      'loom projector',
    );

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

// ─────────────────────────────────────────────────────────────────────────────
// FORGE-226 (Loom I3): the DECISION projector.
//
// Projects three durable sources into `decision` nodes + `decided_in`/`affects`
// edges, folded into the same atomic reindex rebuild as everything else:
//   1. ANSWERED questions — `tasks/<id>/attempts/<aid>/answers/<qid>.json` paired
//      with the sibling `questions/<qid>.json`. The answer has NO task_id, so the
//      on-disk path supplies the task; the question supplies decision_key +
//      classification. decision --decided_in--> task.
//   2. AUTONOMOUS decisions — `autonomous_decision` events on the same
//      `events.jsonl` the event projector already walks. decision --decided_in-->
//      task.
//   3. APPLIED ADRs — completed apply-journals under
//      `orchestrator/global/update-spec-apply-journal/completed/<slug>.json`.
//      decision --affects--> task for each id in journal.phases_tasks.
//
// CRITICAL (Codex): answered + autonomous decisions DEDUP by
// (canonicalTaskNodeId, decision_key), NOT per-attempt question_id — multiple
// attempts answer the same logical decision; we keep the LATEST by timestamp and
// warn on a conflicting historical answer. The node id is a pure fn of that
// logical key so reindex is idempotent.
//
// Like the event projector this is BEST-EFFORT and NEVER throws: a missing
// orchestrator/journal dir → empty + (for non-ENOENT) a warning; a malformed /
// oversize / symlinked file → warn + skip. Reads use the SAME fortress safety as
// symbols.ts (lstat regular-file, O_NOFOLLOW, fstat regular-file + byte cap
// BEFORE JSON.parse, skip symlinks) — we deliberately do NOT reuse
// questions/reader.ts, which statSync/readFileSync-FOLLOWS symlinks.

const MAX_DECISIONS = 50_000;
// A decision file is small JSON (a question/answer/journal). Cap reads well below
// anything legitimate so a hostile / runaway file cannot be parsed at all.
const MAX_DECISION_FILE_BYTES = 512 * 1024;

export interface ProjectDecisionsArgs {
  readonly forgeDir: string;
  readonly repoRoot: string;
  readonly resolveTaskNodeId: (rawId: string) => string | null;
}

export interface ProjectDecisionsResult {
  readonly decisionNodes: MemoryNode[];
  readonly decidedInEdges: MemoryEdge[];
  readonly affectsEdges: MemoryEdge[];
  readonly warnings: string[];
}

// True when `abs` resolves (via realpath, following any parent-dir symlinks) to a
// location INSIDE `realRoot`. realRoot must already be a canonical (realpath'd)
// path. A parent-directory symlink that escapes .forge is rejected here even
// though the LEAF passes the lstat/O_NOFOLLOW checks. Mirrors symbols.ts:
// safeReadSource step 3. Returns false on any realpath failure (caller skips).
function isWithinRealRoot(abs: string, realRoot: string): boolean {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Read a JSON file ONLY through a symlink-safe path: lstat (reject non-regular /
// symlink), realpath-containment of the PARENT dir (reject a symlinked parent
// component that escapes .forge), O_NOFOLLOW open (TOCTOU: reject a symlink
// swapped in after lstat), fstat regular-file + byte cap BEFORE JSON.parse.
// Returns the parsed value, or null when the path is unsafe / oversize / absent /
// unparseable (caller warns). NEVER throws. Mirrors symbols.ts:safeReadSource,
// narrowed to JSON.
function safeReadJson(
  abs: string,
  label: string,
  realRoot: string,
  warnings: string[],
): unknown | null {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`loom decisions: could not lstat ${label}: ${(err as Error).message} — skipped`);
    }
    return null;
  }
  if (st.isSymbolicLink()) {
    warnings.push(`loom decisions: ${label} is a symlink — skipped`);
    return null;
  }
  if (!st.isFile()) return null;
  // realpath-containment of the parent dir: a symlinked parent component (answers/,
  // questions/, completed/, any orchestrator/... segment) could otherwise let abs
  // escape .forge despite the leaf's own O_NOFOLLOW open.
  if (!isWithinRealRoot(dirname(abs), realRoot)) {
    warnings.push(`loom decisions: ${label} resolves outside .forge — skipped`);
    return null;
  }
  if (st.size > MAX_DECISION_FILE_BYTES) {
    warnings.push(`loom decisions: ${label} is ${st.size} bytes (> ${MAX_DECISION_FILE_BYTES} cap) — skipped`);
    return null;
  }

  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      warnings.push(`loom decisions: ${label} became a symlink (O_NOFOLLOW) — skipped`);
    } else if (code !== 'ENOENT') {
      warnings.push(`loom decisions: could not open ${label}: ${(err as Error).message} — skipped`);
    }
    return null;
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      warnings.push(`loom decisions: ${label} is not a regular file — skipped`);
      return null;
    }
    // FORGE-226 post-open TOCTOU re-check (mirror symbols.ts / readAttemptEvents):
    // O_NOFOLLOW guards only the LEAF, so a PARENT swapped to a symlink between the
    // containment check above and this open could redirect the fd OUTSIDE .forge.
    // Re-resolve post-open and require (a) it is still contained, (b) the fd is
    // that same inode (dev+ino). Either failing → a swap happened mid-flight → skip.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      warnings.push(`loom decisions: ${label} vanished between checks — skipped`);
      return null;
    }
    const relReal = relative(realRoot, real);
    if (relReal === '' || relReal.startsWith('..') || isAbsolute(relReal)) {
      warnings.push(`loom decisions: ${label} resolves outside .forge (TOCTOU) — skipped`);
      return null;
    }
    try {
      const realStat = statSync(real);
      if (fst.dev !== realStat.dev || fst.ino !== realStat.ino) {
        warnings.push(`loom decisions: ${label} changed between checks (TOCTOU) — skipped`);
        return null;
      }
    } catch {
      warnings.push(`loom decisions: ${label} vanished between checks — skipped`);
      return null;
    }
    if (fst.size > MAX_DECISION_FILE_BYTES) {
      warnings.push(`loom decisions: ${label} is ${fst.size} bytes (> ${MAX_DECISION_FILE_BYTES} cap) — skipped`);
      return null;
    }
    const buf = Buffer.allocUnsafe(fst.size);
    let offset = 0;
    while (offset < fst.size) {
      const n = readSync(fd, buf, offset, fst.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const text = buf.subarray(0, offset).toString('utf8');
    try {
      return JSON.parse(text);
    } catch (err) {
      warnings.push(`loom decisions: ${label} is not valid JSON: ${(err as Error).message} — skipped`);
      return null;
    }
  } catch (err) {
    warnings.push(`loom decisions: could not read ${label}: ${(err as Error).message} — skipped`);
    return null;
  } finally {
    closeSync(fd);
  }
}

// Symlink-safe readdir for INTERMEDIATE walk dirs (tasksRoot, attemptsRoot,
// answers/, journal completed/). lstat the dir (reject a symlinked dir — a
// symlinked parent could redirect the whole walk outside .forge), realpath-
// contain it under realRoot, then readdir withFileTypes. ENOENT is the common
// absent-dir case → silent []. Any other failure → warn + []. NEVER throws.
// Symlink/containment-safe readdir, shared by the decision AND event projectors.
// Rejects a symlinked or non-directory path AND any path whose realpath escapes
// the canonical `.forge` root (a symlinked PARENT dir — e.g. `orchestrator/tasks`
// → external — would otherwise let readdirSync enumerate outside the tree).
// `domain` prefixes the warnings ('loom decisions' | 'loom projector').
function safeReaddir(
  dirAbs: string,
  label: string,
  realRoot: string,
  warnings: string[],
  domain = 'loom decisions',
): Dirent[] {
  let st;
  try {
    st = lstatSync(dirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`${domain}: could not lstat ${label}: ${(err as Error).message} — skipped`);
    }
    return [];
  }
  if (st.isSymbolicLink()) {
    warnings.push(`${domain}: ${label} is a symlink — skipped`);
    return [];
  }
  if (!st.isDirectory()) {
    warnings.push(`${domain}: ${label} is not a directory — skipped`);
    return [];
  }
  if (!isWithinRealRoot(dirAbs, realRoot)) {
    warnings.push(`${domain}: ${label} resolves outside .forge — skipped`);
    return [];
  }
  try {
    return readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`${domain}: could not read ${label}: ${(err as Error).message} — skipped`);
    }
    return [];
  }
}

// Realpath of the `.forge` root for containment checks. Returns null when the
// dir does not exist (the common adopter case) → the caller projects nothing.
function realForgeRootOrNull(forgeDir: string, warnings: string[], domain: string): string | null {
  try {
    return realpathSync(forgeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`${domain}: could not resolve .forge root: ${(err as Error).message} — nothing projected`);
    }
    return null;
  }
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Pure-fn decision node id (CRITICAL — keyed on the LOGICAL decision, not the
// per-attempt question_id): `decision:question:<sha256(taskNodeId \0 key)>`.
function questionDecisionId(taskNodeId: string, decisionKey: string): string {
  const hex = createHash('sha256').update(`${taskNodeId}\0${decisionKey}`).digest('hex');
  return `decision:question:${hex}`;
}

// A staged answered/autonomous decision before it becomes a node. Keyed by
// (taskNodeId, decision_key); we keep the latest by `decidedAt`.
interface StagedDecision {
  readonly nodeId: string;
  readonly taskNodeId: string;
  readonly decisionKey: string;
  readonly source: 'question' | 'autonomous';
  readonly sourceQuestionId: string;
  readonly decidedAt: string;
  readonly chosen: string | null;
  readonly title: string;
  readonly body: string;
  readonly attrs: Record<string, string | null>;
}

export function projectDecisions(args: ProjectDecisionsArgs): ProjectDecisionsResult {
  const warnings: string[] = [];
  // Dedup map: (taskNodeId\0decisionKey) → latest staged decision.
  const staged = new Map<string, StagedDecision>();
  let truncated = false;

  // Canonical real .forge root — computed ONCE. Every decision read/walk is
  // realpath-contained under this so a symlinked parent component cannot let a
  // read escape .forge. If forgeDir itself does not resolve, treat the whole
  // projection as empty (best-effort, never throws).
  let realRoot: string;
  try {
    realRoot = realpathSync(args.forgeDir);
  } catch (err) {
    warnings.push(
      `loom decisions: could not realpath .forge root (${args.forgeDir}): ${err instanceof Error ? err.message : String(err)} — no decisions`,
    );
    return { decisionNodes: [], decidedInEdges: [], affectsEdges: [], warnings };
  }

  const stage = (d: StagedDecision): boolean => {
    const key = `${d.taskNodeId}\0${d.decisionKey}`;
    const prior = staged.get(key);
    if (prior) {
      // Conflicting historical answer for the same logical decision: keep the
      // LATEST by timestamp; warn when the chosen option differs.
      const priorMs = Date.parse(prior.decidedAt);
      const curMs = Date.parse(d.decidedAt);
      const newer = Number.isNaN(curMs) ? false : Number.isNaN(priorMs) ? true : curMs >= priorMs;
      if (prior.chosen !== d.chosen) {
        warnings.push(
          `loom decisions: conflicting answers for decision '${d.decisionKey}' on ${d.taskNodeId} (kept ${newer ? d.chosen : prior.chosen})`,
        );
      }
      if (newer) staged.set(key, d);
      return true;
    }
    if (staged.size >= MAX_DECISIONS) {
      truncated = true;
      return false;
    }
    staged.set(key, d);
    return true;
  };

  // ── enumerate orchestrator task dirs (regular dirs, not symlinks). ──
  const tasksRoot = tasksRootDir(args.forgeDir);
  const taskEntries = safeReaddir(tasksRoot, `tasks root ${tasksRoot}`, realRoot, warnings);
  taskEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  outer: for (const taskEnt of taskEntries) {
    if (taskEnt.isSymbolicLink()) {
      warnings.push(`loom decisions: task dir '${taskEnt.name}' is a symlink — skipped`);
      continue;
    }
    if (!taskEnt.isDirectory()) continue;
    const taskId = taskEnt.name;

    let canonicalTaskNodeId: string | null;
    try {
      canonicalTaskNodeId = args.resolveTaskNodeId(taskId);
    } catch (err) {
      warnings.push(
        `loom decisions: failed to resolve task '${taskId}': ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }
    if (canonicalTaskNodeId === null) {
      warnings.push(
        `loom decisions: task dir '${taskId}' matches no task node — decisions skipped (dangling-edge guard)`,
      );
      continue;
    }

    let attemptsRoot: string;
    try {
      attemptsRoot = attemptsDir(args.forgeDir, taskId);
    } catch (err) {
      warnings.push(
        `loom decisions: invalid task dir name '${taskId}': ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }

    const attemptEntries = safeReaddir(
      attemptsRoot,
      `attempts root ${taskId}`,
      realRoot,
      warnings,
    );
    attemptEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const attemptEnt of attemptEntries) {
      if (attemptEnt.isSymbolicLink()) {
        warnings.push(`loom decisions: attempt dir '${taskId}/${attemptEnt.name}' is a symlink — skipped`);
        continue;
      }
      if (!attemptEnt.isDirectory()) continue;
      const attemptId = attemptEnt.name;
      const aDir = join(attemptsRoot, attemptId);

      // ── Source 1: answered questions ──────────────────────────────────────
      // Walk answers/*.json; join the sibling questions/<qid>.json by path.
      const answersDirAbs = join(aDir, 'answers');
      const answerEntries = safeReaddir(
        answersDirAbs,
        `answers dir ${taskId}/${attemptId}`,
        realRoot,
        warnings,
      );
      answerEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const ansEnt of answerEntries) {
        if (ansEnt.isSymbolicLink()) {
          warnings.push(`loom decisions: answer '${taskId}/${attemptId}/${ansEnt.name}' is a symlink — skipped`);
          continue;
        }
        if (!ansEnt.isFile() || !ansEnt.name.toLowerCase().endsWith('.json')) continue;

        const ansRaw = safeReadJson(join(answersDirAbs, ansEnt.name), `answer ${taskId}/${attemptId}/${ansEnt.name}`, realRoot, warnings);
        if (ansRaw === null) continue;
        const ansParsed = AnswerSchema.safeParse(ansRaw);
        if (!ansParsed.success) {
          warnings.push(`loom decisions: answer ${taskId}/${attemptId}/${ansEnt.name} failed schema — skipped`);
          continue;
        }
        const answer = ansParsed.data;
        // The sibling question holds decision_key + classification + options.
        const qRaw = safeReadJson(
          join(aDir, 'questions', `${answer.question_id}.json`),
          `question ${taskId}/${attemptId}/${answer.question_id}.json`,
          realRoot,
          warnings,
        );
        if (qRaw === null) {
          warnings.push(
            `loom decisions: answer ${answer.question_id} has no readable sibling question — skipped`,
          );
          continue;
        }
        const qParsed = QuestionSchema.safeParse(qRaw);
        if (!qParsed.success) {
          warnings.push(`loom decisions: question ${answer.question_id} failed schema — skipped`);
          continue;
        }
        const question = qParsed.data;
        const chosenLabel = question.options.find((o) => o.id === answer.option_id)?.label ?? answer.option_id;
        const bodyParts = [question.question, `chosen: ${chosenLabel}`];
        if (answer.note) bodyParts.push(`note: ${answer.note}`);
        if (!stage({
          nodeId: questionDecisionId(canonicalTaskNodeId, question.decision_key),
          taskNodeId: canonicalTaskNodeId,
          decisionKey: question.decision_key,
          source: 'question',
          sourceQuestionId: question.question_id,
          decidedAt: answer.answered_at,
          chosen: answer.option_id,
          title: cap(question.decision_key, MEMORY_TITLE_MAX_LEN),
          body: cap(bodyParts.join('\n'), MEMORY_BODY_MAX_LEN),
          attrs: {
            source: 'question',
            decision_key: cap(question.decision_key, MEMORY_ATTR_STRING_MAX_LEN),
            source_question_id: cap(question.question_id, MEMORY_ATTR_STRING_MAX_LEN),
            decision_type: question.classification.decision_type,
            category: question.classification.category,
            reversibility: question.classification.reversibility,
            blast_radius: question.classification.blast_radius,
            decided_at: answer.answered_at,
            chosen: cap(answer.option_id, MEMORY_ATTR_STRING_MAX_LEN),
          },
        })) break outer;
      }

      // ── Source 2: autonomous_decision events ──────────────────────────────
      let lines: ReturnType<typeof readAttemptEvents>;
      try {
        lines = readAttemptEvents({ forgeDir: args.forgeDir, taskId, attemptId });
      } catch (err) {
        warnings.push(
          `loom decisions: could not read events for ${taskId}/${attemptId}: ${err instanceof Error ? err.message : String(err)} — skipped`,
        );
        lines = [];
      }
      for (const line of lines) {
        if (!line.ok) continue;
        if (line.event.type !== 'autonomous_decision') continue;
        const ev = line.event;
        const chosen = ev.chosen_option_id;
        const bodyParts = [ev.reason];
        bodyParts.push(`chosen: ${chosen ?? '(default action)'}`);
        if (!stage({
          nodeId: questionDecisionId(canonicalTaskNodeId, ev.decision_key),
          taskNodeId: canonicalTaskNodeId,
          decisionKey: ev.decision_key,
          source: 'autonomous',
          sourceQuestionId: '',
          decidedAt: ev.ts,
          chosen,
          title: cap(ev.decision_key, MEMORY_TITLE_MAX_LEN),
          body: cap(bodyParts.join('\n'), MEMORY_BODY_MAX_LEN),
          attrs: {
            source: 'autonomous',
            decision_key: cap(ev.decision_key, MEMORY_ATTR_STRING_MAX_LEN),
            source_question_id: null,
            decided_at: ev.ts,
            chosen: chosen === null ? null : cap(chosen, MEMORY_ATTR_STRING_MAX_LEN),
          },
        })) break outer;
      }
    }
  }

  // ── build task-keyed decision nodes + decided_in edges (deterministic). ──
  const decisionNodes: MemoryNode[] = [];
  const decidedInEdges: MemoryEdge[] = [];
  const stagedList = Array.from(staged.values()).sort((a, b) =>
    a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
  );
  for (const d of stagedList) {
    if (d.nodeId.length > MEMORY_ID_MAX_LEN) {
      warnings.push(`loom decisions: node id too long (${d.nodeId.length} > ${MEMORY_ID_MAX_LEN}) — skipped`);
      continue;
    }
    const node = MemoryNodeSchema.safeParse({
      id: d.nodeId,
      kind: 'decision',
      title: d.title.length > 0 ? d.title : d.decisionKey,
      body: d.body,
      attrs: d.attrs,
    });
    if (!node.success) {
      warnings.push(`loom decisions: decision '${d.decisionKey}' failed node schema — skipped`);
      continue;
    }
    const edge = MemoryEdgeSchema.safeParse({ src: d.nodeId, dst: d.taskNodeId, kind: 'decided_in' });
    if (!edge.success) {
      warnings.push(`loom decisions: decided_in edge for '${d.decisionKey}' failed schema — skipped`);
      continue;
    }
    decisionNodes.push(node.data);
    decidedInEdges.push(edge.data);
  }

  // ── Source 3: applied ADRs (completed apply-journals) → affects edges. ──
  const affectsEdges: MemoryEdge[] = [];
  if (!truncated) {
    const completedDir = join(args.forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal', 'completed');
    const journalEntries = safeReaddir(
      completedDir,
      `journal completed dir`,
      realRoot,
      warnings,
    );
    journalEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const jEnt of journalEntries) {
      if (decisionNodes.length >= MAX_DECISIONS) {
        truncated = true;
        break;
      }
      if (jEnt.isSymbolicLink()) {
        warnings.push(`loom decisions: journal '${jEnt.name}' is a symlink — skipped`);
        continue;
      }
      if (!jEnt.isFile() || !jEnt.name.toLowerCase().endsWith('.json')) continue;

      const raw = safeReadJson(join(completedDir, jEnt.name), `journal ${jEnt.name}`, realRoot, warnings);
      if (raw === null) continue;
      const parsed = ApplyJournalSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`loom decisions: journal ${jEnt.name} failed schema — skipped`);
        continue;
      }
      const journal = parsed.data;
      const adrId = `decision:adr:${journal.slug}`;
      if (adrId.length > MEMORY_ID_MAX_LEN) {
        warnings.push(`loom decisions: ADR id too long for '${journal.slug}' — skipped`);
        continue;
      }
      // Resolve each affected phases task id; skip dangling.
      const affectedNodeIds: string[] = [];
      for (const t of journal.phases_tasks) {
        let resolved: string | null;
        try {
          resolved = args.resolveTaskNodeId(t.id);
        } catch {
          resolved = null;
        }
        if (resolved === null) {
          warnings.push(`loom decisions: ADR '${journal.slug}' affects unknown task '${t.id}' — edge skipped`);
          continue;
        }
        if (!affectedNodeIds.includes(resolved)) affectedNodeIds.push(resolved);
      }
      const counts = `spec:${journal.spec_sections.length} prd:${journal.prd_sections.length} phases:${journal.phases_tasks.length} tracker:${journal.tracker_issues.length}`;
      const completedAt = journal.completed_at ?? journal.started_at;
      const node = MemoryNodeSchema.safeParse({
        id: adrId,
        kind: 'decision',
        title: cap(journal.slug, MEMORY_TITLE_MAX_LEN),
        body: cap(`ADR ${journal.slug} applied (${counts})`, MEMORY_BODY_MAX_LEN),
        attrs: {
          source: 'adr',
          decision_key: cap(journal.slug, MEMORY_ATTR_STRING_MAX_LEN),
          source_question_id: null,
          slug: cap(journal.slug, MEMORY_ATTR_STRING_MAX_LEN),
          completed_at: completedAt,
          affected_counts: cap(counts, MEMORY_ATTR_STRING_MAX_LEN),
        },
      });
      if (!node.success) {
        warnings.push(`loom decisions: ADR '${journal.slug}' failed node schema — skipped`);
        continue;
      }
      decisionNodes.push(node.data);
      for (const dst of affectedNodeIds) {
        const edge = MemoryEdgeSchema.safeParse({ src: adrId, dst, kind: 'affects' });
        if (!edge.success) {
          warnings.push(`loom decisions: affects edge ${adrId}→${dst} failed schema — skipped`);
          continue;
        }
        affectsEdges.push(edge.data);
      }
    }
  }

  if (truncated) {
    warnings.push(`loom decisions: decision cap (${MAX_DECISIONS}) reached — projection truncated`);
  }

  // Deterministic sort of all outputs.
  decisionNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortEdges = (e: MemoryEdge[]): void => {
    e.sort((a, b) => {
      if (a.src !== b.src) return a.src < b.src ? -1 : 1;
      if (a.dst !== b.dst) return a.dst < b.dst ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
  };
  sortEdges(decidedInEdges);
  sortEdges(affectsEdges);

  return { decisionNodes, decidedInEdges, affectsEdges, warnings };
}
