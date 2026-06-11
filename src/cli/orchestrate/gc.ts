import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isNodeFsError,
  legacyAnswersDir,
  legacyArchiveSession,
  legacyQuestionsDir,
  QuestionChannelError,
} from '../../orchestrator/questions/index.ts';
import {
  assertNeverGcRow,
  planGc,
  type GcPlan,
  type GcPlanRow,
  type OrchestratorSnapshot,
  type TaskSnapshot,
  type LeaseAtPath,
  type AttemptSnapshot,
} from '../../orchestrator/gc.ts';
import {
  adminReleaseLeaseByIdentity,
  release,
  type AdminReleaseReason,
} from '../../orchestrator/leases.ts';
import {
  readTaskState,
  writeTaskState,
  type StateCaller,
} from '../../orchestrator/state-machine.ts';
import {
  attemptDir,
  attemptsDir,
  leaseFilePath,
  tasksRootDir,
  validateIdSegment,
} from '../../orchestrator/questions/paths.ts';
import { LeaseSchema } from '../../schemas/lease.ts';
import {
  TaskStateSchema,
  type TaskState,
  type TaskStateRecord,
} from '../../schemas/task-state.ts';
import type { Phases } from '../../schemas/phases.ts';
import { VerdictSchema } from '../../schemas/verdict.ts';
import type { Issue } from '../../trackers/types.ts';
import { cleanup, TASK_MARKER_RELPATH } from '../../core/workspace.ts';
import { WorkspaceError } from '../../core/errors.ts';
import { classifyLeaseHealth } from '../../orchestrator/leases.ts';
import { ACTIVE_STATES } from '../../orchestrator/readiness.ts';

// ── Task-id validation for --remove-worktrees mode (FORGE-116, fix 1) ─────────
//
// Two valid shapes come from two different ID namespaces:
//   • Tracker IDs (Linear / GitHub): /^[A-Z][A-Z0-9]*-\d+$/   e.g. FORGE-116, WT-1
//   • Phases-shape IDs:              /^P\d+(\.\d+)?-T\d+[a-z]?$/  e.g. P1-T3, P2.1-T5b
//
// Any other value MUST be rejected with INVALID_ARGS before any path is
// constructed, to prevent path-traversal attacks (e.g. `--task ../..`).
// Marker taskIds read from disk are validated with the same predicate before
// they participate in any path join — see readWorktreeMarker().
const TASK_ID_TRACKER_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const TASK_ID_PHASES_RE = /^P\d+(\.\d+)?-T\d+[a-z]?$/;

function isValidTaskId(id: string): boolean {
  return TASK_ID_TRACKER_RE.test(id) || TASK_ID_PHASES_RE.test(id);
}

// `forge orchestrate gc` is the deterministic reconciler defined by
// spec/ORCHESTRATOR.md §"gc reconciliation rules". Two-phase execution:
//
//   Phase 0 — legacy v1 question-tree migration (FORGE-73): any v1-style flat
//   .forge/{questions,answers}/<id>.json tree from before the v2 task-keyed
//   rewrite is moved under .forge/orchestrator/legacy/<utc-timestamp>/. Files
//   are MOVED via link+unlink (never deleted in place) so failures leave
//   originals intact for retry.
//
//   Phase 1 — 14-row divergence reconciler (FORGE-22): src/orchestrator/gc.ts
//   plans the full divergence table; this shim builds the local-only snapshot,
//   invokes the planner, and either formats the plan (--dry-run) or executes
//   it. Tracker-dependent rows (1, 3, 4, 6, 7) currently run with an empty
//   tracker snapshot — tracker.listActiveIssues integration lands as follow-up.
//
// The verb surface is `forge orchestrate gc [--dry-run]`. No --apply flag
// (spec is the source of truth on the CLI shape — Codex 1st-pass Q3).

export interface OrchestrateGcOptions {
  readonly forgeDir: string;
  readonly dryRun?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injectable clock — tests use a fixed timestamp so the archive directory
  // path is deterministic.
  readonly now?: () => Date;
  // ── `--remove-worktrees` mode (FORGE-116) ──
  // When set, gc runs the worktree-removal planner/executor as a MUTUALLY
  // EXCLUSIVE early mode (it never falls through to the legacy migration or the
  // 14-row divergence reconciler). `removeWorktreesTask` scopes to a single
  // task id (the `--task` flag); when undefined the mode iterates every
  // terminal-state worktree (batch mode).
  readonly removeWorktrees?: boolean;
  readonly removeWorktreesTask?: string;
  // Emit the JSON envelope the /wrap-up SKILL consumes instead of human text.
  readonly json?: boolean;
}

export interface OrchestrateGcResult {
  readonly exitCode: number;
  // Sibling files moved (or planned to move under --dry-run). One entry per
  // source path, ordered as discovered.
  readonly migrated: readonly { from: string; to: string }[];
  // Reconciler plan rows produced by planGc (empty in pre-FORGE-22 scope).
  // On --dry-run: rows from the plan (no mutations applied).
  // On apply: rows that were successfully executed.
  readonly reconcilerRows?: readonly GcPlanRow[];
  // Rows whose action paths are deferred to a follow-up PR (mark_terminal,
  // mark_abandoned, mark_unclaimed, reverify_verdict, prune_branch). Planner
  // detected them; executor reported via stderr but did not mutate.
  // Programmatic callers use this field to distinguish "no divergence found"
  // (reconcilerRows: [], reconcilerDeferred: []) from "all detected rows
  // need follow-up infrastructure" (reconcilerRows: [], reconcilerDeferred:
  // [...]). (Codex 3rd-pass CONSIDER 4.)
  readonly reconcilerDeferred?: readonly GcPlanRow[];
  // Reconciler rows that failed during apply, with the error message.
  readonly reconcilerErrors?: readonly { row: GcPlanRow; message: string }[];
  // ── `--remove-worktrees` mode (FORGE-116) ──
  // The planner envelope the /wrap-up SKILL consumes. Present only in this mode.
  // On --dry-run this is the plan (eligible/refused). On a non-dry run the
  // `results` field carries the per-task removal outcome.
  readonly removeWorktrees?: RemoveWorktreesEnvelope;
}

// ── `--remove-worktrees` planner / executor types (FORGE-116) ──

export interface RemoveWorktreesEligible {
  readonly task_id: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly state: TaskState;
}

export interface RemoveWorktreesRefused {
  readonly task_id: string;
  readonly reason: string;
  readonly state?: TaskState;
}

export interface RemoveWorktreesResult {
  readonly task_id: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly state: TaskState;
  // 'removed' — worktree directory gone; 'noop' — worktree already absent
  // (NOT_FOUND, per delta 8); 'refused' — gate refused at re-check time;
  // 'error' — cleanup() threw something other than NOT_FOUND/GITIGNORED_LOSS.
  readonly outcome: 'removed' | 'noop' | 'refused' | 'error';
  readonly reason?: string;
}

export interface RemoveWorktreesAbsent {
  readonly task_id: string;
}

export interface RemoveWorktreesEnvelope {
  readonly mode: 'remove-worktrees';
  readonly dryRun: boolean;
  // dry-run planner output (the SKILL's candidate list).
  readonly eligible: readonly RemoveWorktreesEligible[];
  readonly refused: readonly RemoveWorktreesRefused[];
  // Planner-detected absent worktrees (delta 8): the directory does not exist.
  // Chosen noop mechanism: planner emits a third `absent` list (rather than
  // placing the entry in `refused`) so callers can distinguish "nothing to
  // remove" (pure noop, exit 0) from "gate refused a real candidate". On a
  // non-dry-run the executor converts each absent entry to
  // `results[].outcome: "noop"`, which also keeps exit 0.
  readonly absent: readonly RemoveWorktreesAbsent[];
  // non-dry-run per-task outcomes (absent on dry-run).
  readonly results?: readonly RemoveWorktreesResult[];
}

interface PlannedMove {
  readonly from: string;
  readonly to: string;
}

function listLegacyFiles(dir: string): readonly string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return [];
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to read legacy directory ${dir}`,
      { path: dir, cause: err },
    );
  }
  // Only canonical .json regular files migrate. Subdirectories (none expected
  // in v1 layout, including any pathological `something.json` directory that
  // would otherwise trip linkSync mid-pass and abort the whole gc) are
  // skipped silently. .tmp residue from crashed v1 writers is left in place —
  // not data. Codex flagged the previous name-only filter in review.
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.includes('.tmp'))
    .map((e) => e.name);
}

function planMigration(
  forgeDir: string,
  archiveDir: string,
): readonly PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const file of listLegacyFiles(legacyQuestionsDir(forgeDir))) {
    moves.push({
      from: join(legacyQuestionsDir(forgeDir), file),
      to: join(archiveDir, 'questions', file),
    });
  }
  for (const file of listLegacyFiles(legacyAnswersDir(forgeDir))) {
    moves.push({
      from: join(legacyAnswersDir(forgeDir), file),
      to: join(archiveDir, 'answers', file),
    });
  }
  return moves;
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to create archive directory ${dir}`,
      { path: dir, cause: err },
    );
  }
}

function moveFile(from: string, to: string): void {
  // link+unlink: same never-overwrite atomic technique as writer.ts. EEXIST on
  // the target indicates either a name collision (shouldn't happen — archive
  // session is timestamp-scoped) or a re-run that already migrated this file.
  // Either way: do not silently overwrite an existing archive entry. Surface
  // it so the operator can investigate.
  ensureDir(join(to, '..'));
  try {
    linkSync(from, to);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'EEXIST') {
      throw new QuestionChannelError(
        'DUPLICATE_ID',
        `Archive target already exists (refusing to overwrite): ${to}`,
        { path: to, cause: err },
      );
    }
    throw new QuestionChannelError(
      'IO_ERROR',
      `Failed to link ${from} → ${to}`,
      { path: to, cause: err },
    );
  }
  try {
    unlinkSync(from);
  } catch (err) {
    // Source unlink failed AFTER successful link: target is the canonical
    // archive entry, source is now an orphan duplicate. Surface as IO_ERROR;
    // the operator can manually unlink the source. Do NOT roll back the link
    // — the archive entry is the safer state to preserve.
    throw new QuestionChannelError(
      'IO_ERROR',
      `Linked to archive but failed to unlink source ${from}`,
      { path: from, cause: err },
    );
  }
}

export async function runOrchestrateGc(
  opts: OrchestrateGcOptions,
): Promise<OrchestrateGcResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? (() => new Date());

  // ── `--remove-worktrees` — mutually exclusive early mode (FORGE-116) ──
  // This NEVER falls through to legacy migration or the divergence reconciler.
  if (opts.removeWorktrees) {
    return runRemoveWorktrees(opts, out, err, now());
  }

  // ── Phase 0: legacy v1 question-tree migration (FORGE-73, preserved) ──

  const archiveDir = legacyArchiveSession(opts.forgeDir, now().toISOString());
  let moves: readonly PlannedMove[];
  try {
    moves = planMigration(opts.forgeDir, archiveDir);
  } catch (e) {
    if (e instanceof QuestionChannelError) {
      err.write(`forge orchestrate gc: ${e.code}: ${e.message}\n`);
      return { exitCode: 1, migrated: [] };
    }
    err.write(
      `forge orchestrate gc: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1, migrated: [] };
  }

  const legacyCompleted: PlannedMove[] = [];

  if (moves.length === 0) {
    out.write('No legacy files to migrate.\n');
  } else if (dryRun) {
    out.write(`gc plan (no changes will be made):\n\n`);
    for (const m of moves) {
      out.write(`  ${m.from}\n    → ${m.to}\n`);
    }
    out.write(`\n${moves.length} file(s) would be migrated. Re-run without --dry-run to apply.\n`);
    // Fall through to reconciler — dry-run plan output is additive.
  } else {
    for (const m of moves) {
      try {
        moveFile(m.from, m.to);
        legacyCompleted.push(m);
      } catch (e) {
        const msg =
          e instanceof QuestionChannelError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        err.write(`forge orchestrate gc: aborted after ${legacyCompleted.length}/${moves.length} moves: ${msg}\n`);
        return { exitCode: 1, migrated: legacyCompleted };
      }
    }
    out.write(`Migrated ${legacyCompleted.length} legacy file(s) to ${archiveDir}.\n`);
  }

  // ── Phase 1: 14-row reconciler (FORGE-22) ──

  const migratedReport = dryRun ? moves : legacyCompleted;
  const snapshot = buildSnapshot(opts.forgeDir, now(), 'full');
  const plan = planGc(snapshot);

  if (dryRun) {
    formatPlanForDryRun(plan, out);
    return { exitCode: 0, migrated: migratedReport, reconcilerRows: plan.rows };
  }

  if (plan.rows.length === 0) {
    if (moves.length === 0) {
      // No legacy moves AND no divergences — clean tree.
      out.write('gc: no divergences found.\n');
    }
    return { exitCode: 0, migrated: migratedReport, reconcilerRows: [] };
  }

  // Execute the plan. Per-row failures (real errors — thrown exceptions) are
  // collected; we continue to subsequent rows so a transient row failure
  // doesn't strand other rows. Deferred-action rows (executor not yet wired)
  // are NOT errors — they emit a stderr warning and `applied: false`.
  const applied: GcPlanRow[] = [];
  const deferred: GcPlanRow[] = [];
  const errors: { row: GcPlanRow; message: string }[] = [];
  for (const row of plan.rows) {
    try {
      const outcome = executeRow(row, opts.forgeDir, out, err);
      if (outcome.applied) {
        applied.push(row);
      } else {
        deferred.push(row);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ row, message });
      err.write(
        `forge orchestrate gc: row ${row.rowId} (${row.action}) for task ${row.taskId} failed: ${message}\n`,
      );
    }
  }

  const summary =
    deferred.length > 0
      ? `gc: applied ${applied.length}/${plan.rows.length} divergence rows (${deferred.length} deferred — see warnings).\n`
      : `gc: applied ${applied.length}/${plan.rows.length} divergence rows.\n`;
  out.write(summary);
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    migrated: migratedReport,
    reconcilerRows: applied,
    reconcilerDeferred: deferred,
    reconcilerErrors: errors,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  `--remove-worktrees` mode (FORGE-116) — wraps workspace.cleanup() per task.
//
//  Two-pass design so dry-run and execute share ONE eligibility/gate path:
//    1. plan: classify every candidate worktree into eligible / refused.
//    2. execute (non-dry-run only): RE-CHECK the lease gate immediately before
//       each cleanup (delta 4), then call cleanup() with deleteBranch:false and
//       NO force flag (deltas 6, 2). The verb removes worktrees only; the SKILL
//       owns branch deletion + main ff.
//
//  Eligibility (delta 3):
//    --task : ready_for_review | reviewed | shipped | cancelled | failed
//    batch  : shipped | cancelled | failed (terminal only)
//    Both modes refuse unclaimed, ACTIVE states, and abandoned.
//  Lease gate (delta 4): refuse alive AND expiring_soon; allow stale; a
//  malformed lease refuses (never treated as absent); an absent lease allows.
// ────────────────────────────────────────────────────────────────────────────

const SINGLE_TASK_ELIGIBLE: ReadonlySet<TaskState> = new Set<TaskState>([
  'ready_for_review',
  'reviewed',
  'shipped',
  'cancelled',
  'failed',
]);

const BATCH_ELIGIBLE: ReadonlySet<TaskState> = new Set<TaskState>([
  'shipped',
  'cancelled',
  'failed',
]);

interface WorktreeCandidate {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
}

// Read + validate the worktree-task marker. Returns null if the marker is
// missing/unreadable/invalid OR its taskId does not match the directory name
// (delta 7 — never assume feat/<id>; validate marker.taskId === dirname).
//
// Fix 1 (FORGE-116): additionally validates that the marker's taskId passes the
// task-id format check (isValidTaskId) AND contains no path separators before
// it is returned to callers. This prevents a crafted marker from injecting a
// traversal component into any downstream path join.
function readWorktreeMarker(
  worktreePath: string,
  dirName: string,
): { taskId: string; branch: string } | null {
  const markerPath = join(worktreePath, TASK_MARKER_RELPATH);
  let raw: string;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.taskId !== 'string' || typeof m.branch !== 'string') return null;
  // Reject marker taskIds that fail the canonical format or contain path separators.
  if (!isValidTaskId(m.taskId) || m.taskId.includes('/') || m.taskId.includes('\\')) return null;
  if (m.taskId !== dirName) return null;
  return { taskId: m.taskId, branch: m.branch };
}

// Read the task's state.json. Returns the state string or null (absent /
// unreadable / schema-invalid → treated as "no observable state").
function readTaskStateForWorktree(
  forgeDir: string,
  taskId: string,
): TaskState | null {
  const taskDir = join(tasksRootDir(forgeDir), taskId);
  const path = join(taskDir, 'state.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = TaskStateSchema.safeParse(parsed);
  return res.success ? res.data.state : null;
}

type LeaseGate =
  | { ok: true }
  | { ok: false; reason: string };

// Lease gate (delta 4). `now` is injected so tests are deterministic.
//   - absent lease  → allow (LEASE_NOT_FOUND treated as "no live owner")
//   - malformed/unparseable lease → refuse (never treat as absent)
//   - alive | expiring_soon → refuse
//   - stale → allow
function checkLeaseGate(
  forgeDir: string,
  taskId: string,
  now: Date,
): LeaseGate {
  const path = leaseFilePath(forgeDir, taskId);
  if (!existsSync(path)) return { ok: true };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Present but unreadable — refuse; never silently treat as absent.
    return { ok: false, reason: 'lease.json present but unreadable; refusing (run gc divergence reconciler or release manually)' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'lease.json is malformed JSON; refusing (never treated as absent)' };
  }
  const parsed = LeaseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: 'lease.json failed schema validation; refusing (never treated as absent)' };
  }
  const health = classifyLeaseHealth(parsed.data.expires_at, now);
  if (health === 'alive' || health === 'expiring_soon') {
    return { ok: false, reason: `lease is ${health}; refusing to remove an actively-leased worktree` };
  }
  // stale → orphaned, safe to remove.
  return { ok: true };
}

// Why a candidate is refused by the eligibility/gate checks (state-only; the
// lease re-check happens at execute time).
function classifyEligibility(
  state: TaskState | null,
  batch: boolean,
): { eligible: true } | { eligible: false; reason: string } {
  if (state === null) {
    return { eligible: false, reason: 'no task state.json found (unclaimed or never claimed); refusing' };
  }
  if (state === 'unclaimed') {
    return { eligible: false, reason: 'task is unclaimed; refusing' };
  }
  if (ACTIVE_STATES.has(state)) {
    return { eligible: false, reason: `task is in active state '${state}'; refusing` };
  }
  if (state === 'abandoned') {
    return { eligible: false, reason: "task is 'abandoned'; refusing (run the gc divergence reconciler)" };
  }
  const allowed = batch ? BATCH_ELIGIBLE : SINGLE_TASK_ELIGIBLE;
  if (!allowed.has(state)) {
    const scope = batch ? 'batch mode allows only terminal states (shipped/cancelled/failed)' : 'not an eligible state';
    return { eligible: false, reason: `task state '${state}': ${scope}; refusing` };
  }
  return { eligible: true };
}

function listWorktreeDirs(worktreesRoot: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Build the planner: classify candidates into eligible/refused/absent. Pure of
// any mutation. The lease gate is evaluated here for the plan view, then
// RE-CHECKED at execute time (delta 4).
//
// Noop mechanism (fix 3, FORGE-116): missing worktrees go into the `absent`
// list (a third category, NOT `refused`). This keeps the refused list for
// real gate failures, so callers can distinguish:
//   - pure noop (eligible:[], refused:[], absent:[...]) → exit 0
//   - gate refusal  (refused:[...]) → distinguishable from noop
// The executor converts each absent entry to `results[].outcome: "noop"`.
function planRemoveWorktrees(
  forgeDir: string,
  now: Date,
  scopedTask: string | undefined,
): { eligible: RemoveWorktreesEligible[]; refused: RemoveWorktreesRefused[]; absent: RemoveWorktreesAbsent[]; candidates: Map<string, WorktreeCandidate> } {
  const worktreesRoot = join(forgeDir, 'worktrees');
  const batch = scopedTask === undefined;

  let dirNames: string[];
  if (scopedTask !== undefined) {
    // Single-task mode: only consider the named worktree dir (if it exists).
    dirNames = [scopedTask];
  } else {
    dirNames = listWorktreeDirs(worktreesRoot);
  }

  const eligible: RemoveWorktreesEligible[] = [];
  const refused: RemoveWorktreesRefused[] = [];
  const absent: RemoveWorktreesAbsent[] = [];
  const candidates = new Map<string, WorktreeCandidate>();

  for (const dirName of dirNames) {
    const worktreePath = join(worktreesRoot, dirName);
    if (!existsSync(worktreePath)) {
      // --task pointed at a worktree directory that does not exist → planned
      // noop (delta 8). Batch mode never produces this (it lists existing dirs).
      // Placed in `absent`, NOT `refused`, so callers can distinguish
      // "nothing to remove" from a gate refusal of a real candidate.
      if (scopedTask !== undefined) {
        absent.push({ task_id: dirName });
      }
      continue;
    }
    const marker = readWorktreeMarker(worktreePath, dirName);
    if (!marker) {
      refused.push({ task_id: dirName, reason: 'worktree marker missing/invalid or marker.taskId does not match directory name; refusing' });
      continue;
    }
    const state = readTaskStateForWorktree(forgeDir, marker.taskId);
    const elig = classifyEligibility(state, batch);
    if (!elig.eligible) {
      refused.push({ task_id: marker.taskId, reason: elig.reason, ...(state ? { state } : {}) });
      continue;
    }
    const gate = checkLeaseGate(forgeDir, marker.taskId, now);
    if (!gate.ok) {
      refused.push({ task_id: marker.taskId, reason: gate.reason, ...(state ? { state } : {}) });
      continue;
    }
    // state is non-null here (classifyEligibility refuses null).
    eligible.push({ task_id: marker.taskId, worktree_path: worktreePath, branch: marker.branch, state: state! });
    candidates.set(marker.taskId, { taskId: marker.taskId, worktreePath, branch: marker.branch });
  }

  return { eligible, refused, absent, candidates };
}

async function runRemoveWorktrees(
  opts: OrchestrateGcOptions,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  now: Date,
): Promise<OrchestrateGcResult> {
  const dryRun = opts.dryRun ?? false;
  const json = opts.json ?? false;
  const worktreesRoot = join(opts.forgeDir, 'worktrees');

  const { eligible, refused, absent } = planRemoveWorktrees(
    opts.forgeDir,
    now,
    opts.removeWorktreesTask,
  );

  if (dryRun) {
    const envelope: RemoveWorktreesEnvelope = {
      mode: 'remove-worktrees',
      dryRun: true,
      eligible,
      refused,
      absent,
    };
    if (json) {
      out.write(`${JSON.stringify({ eligible, refused, absent })}\n`);
    } else {
      formatRemovePlan(eligible, refused, absent, out);
    }
    return { exitCode: 0, migrated: [], removeWorktrees: envelope };
  }

  // ── Execute. RE-CHECK the lease gate immediately before each cleanup. ──
  const results: RemoveWorktreesResult[] = [];
  // Fix 2 (FORGE-116): any `refused` or `error` outcome in a non-dry-run
  // execution must produce a non-zero exit code (1) so callers (e.g. /wrap-up)
  // detect the failure and do not proceed to branch deletion. Pure noop and
  // removed outcomes stay 0. The JSON envelope is unchanged.
  let hadNonNoop = false;

  // Convert planner-detected absent entries directly to noop results.
  // The absent list is populated only in single-task mode (--task), so this
  // loop is typically 0 or 1 iterations.
  for (const a of absent) {
    results.push({
      task_id: a.task_id,
      worktree_path: join(worktreesRoot, a.task_id),
      branch: '',
      state: 'shipped', // placeholder — no marker was read; not used by callers
      outcome: 'noop',
      reason: 'worktree directory already absent (nothing to remove)',
    });
  }

  for (const cand of eligible) {
    const state = readTaskStateForWorktree(opts.forgeDir, cand.task_id);
    // Re-validate eligibility + lease at execute time (state or lease may have
    // changed between plan and execute).
    const elig = classifyEligibility(state, opts.removeWorktreesTask === undefined);
    if (!elig.eligible) {
      results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'refused', reason: elig.reason });
      hadNonNoop = true;
      continue;
    }
    const gate = checkLeaseGate(opts.forgeDir, cand.task_id, now);
    if (!gate.ok) {
      results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'refused', reason: gate.reason });
      hadNonNoop = true;
      continue;
    }
    try {
      await cleanup(cand.task_id, {
        root: worktreesRoot,
        deleteBranch: false, // delta 6 — verb removes worktrees only.
        // No force — delta 2. GITIGNORED_LOSS surfaces verbatim with guidance.
      });
      results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'removed' });
    } catch (e) {
      if (e instanceof WorkspaceError && e.code === 'NOT_FOUND') {
        // delta 8 — worktree vanished between plan and execute → noop, not error.
        results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'noop', reason: 'worktree already absent' });
        continue;
      }
      if (e instanceof WorkspaceError && e.code === 'GITIGNORED_LOSS') {
        // delta 2 — surface verbatim with manual guidance; no force flag.
        const files = Array.isArray(e.details.files) ? (e.details.files as string[]) : [];
        const guidance =
          `${e.message}. Refusing to remove (would lose gitignored files: ${files.join(', ')}). ` +
          `Remove the offending files from ${cand.worktree_path} (e.g. a node_modules symlink), then re-run.`;
        results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'refused', reason: guidance });
        hadNonNoop = true;
        continue;
      }
      // Anything else propagates as an error result (delta 8).
      const message = e instanceof Error ? e.message : String(e);
      results.push({ task_id: cand.task_id, worktree_path: cand.worktree_path, branch: cand.branch, state: cand.state, outcome: 'error', reason: message });
      hadNonNoop = true;
    }
  }

  const envelope: RemoveWorktreesEnvelope = {
    mode: 'remove-worktrees',
    dryRun: false,
    eligible,
    refused,
    absent,
    results,
  };
  if (json) {
    out.write(`${JSON.stringify({ eligible, refused, absent, results })}\n`);
  } else {
    formatRemoveResults(results, refused, out, err);
  }
  // Non-dry-run: PLANNER refusals must also fail the command — a refused
  // single task exiting 0 would let /wrap-up proceed to branch deletion after
  // nothing was removed (Codex impl-review round 2). Pure absent/noop runs
  // stay 0.
  return { exitCode: hadNonNoop || refused.length > 0 ? 1 : 0, migrated: [], removeWorktrees: envelope };
}

function formatRemovePlan(
  eligible: readonly RemoveWorktreesEligible[],
  refused: readonly RemoveWorktreesRefused[],
  absent: readonly RemoveWorktreesAbsent[],
  out: NodeJS.WritableStream,
): void {
  out.write('\ngc --remove-worktrees plan (no changes will be made):\n\n');
  if (eligible.length === 0 && refused.length === 0 && absent.length === 0) {
    out.write('  no worktrees found.\n');
    return;
  }
  for (const e of eligible) {
    out.write(`  ✓ ${e.task_id} (${e.state}) → ${e.worktree_path}  [branch ${e.branch}]\n`);
  }
  for (const r of refused) {
    out.write(`  ✗ ${r.task_id}${r.state ? ` (${r.state})` : ''}: ${r.reason}\n`);
  }
  for (const a of absent) {
    out.write(`  ○ ${a.task_id}: worktree directory already absent (noop)\n`);
  }
  out.write(`\n${eligible.length} eligible, ${refused.length} refused, ${absent.length} absent. Re-run without --dry-run to remove.\n`);
}

function formatRemoveResults(
  results: readonly RemoveWorktreesResult[],
  refused: readonly RemoveWorktreesRefused[],
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): void {
  for (const r of results) {
    if (r.outcome === 'removed') {
      out.write(`  ✓ ${r.task_id}: removed worktree ${r.worktree_path}\n`);
    } else if (r.outcome === 'noop') {
      out.write(`  ✓ ${r.task_id}: ${r.reason ?? 'worktree already absent'}\n`);
    } else {
      err.write(`  ✗ ${r.task_id}: ${r.reason ?? r.outcome}\n`);
    }
  }
  for (const r of refused) {
    err.write(`  ✗ ${r.task_id}${r.state ? ` (${r.state})` : ''}: ${r.reason}\n`);
  }
  const removedCount = results.filter((r) => r.outcome === 'removed').length;
  out.write(`gc --remove-worktrees: removed ${removedCount}/${results.length} worktree(s).\n`);
}

// ────────────────────────────────────────────────────────────────────────────
//  Snapshot builder — local I/O only (no tracker, no git). Tracker integration
//  is deferred to follow-up; for now full-mode planGc runs with empty
//  trackerIssues, which means rows 1, 3, 4, 6, 7 will not fire even when their
//  preconditions are met. Local rows (2, 5, 8, 9, 10, 11, 12, 13, 14) work
//  end-to-end.
// ────────────────────────────────────────────────────────────────────────────

// Cheap auto-gc — called by `phases --ready` and `status` (read-band verbs).
// Detect-only: writes a one-line "[gc] <task>: <description> — run gc to
// apply" warning to stderr for each cheap-row divergence. Never mutates.
// Per FORGE-22 plan Q6 (Codex 2nd-pass #4: real read-band pattern break
// avoided here by NOT mutating).
//
// Stdout is untouched, so JSON consumers of `phases --ready --json` are
// unaffected. Precedent: phases.ts:91 emits the freshness line to stderr.
export function detectCheapDivergences(
  forgeDir: string,
  err: NodeJS.WritableStream,
  now: Date,
): void {
  let snapshot: OrchestratorSnapshot;
  try {
    snapshot = buildSnapshot(forgeDir, now, 'cheap');
  } catch (e) {
    // Best-effort — but DON'T fail silently. A corrupt .forge/orchestrator tree
    // is exactly the case operators need to know about; the host verb itself
    // continues regardless. (Codex 3rd-pass IMPROVEMENT 5.)
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`[gc] auto-detect failed (continuing): ${msg}\n`);
    return;
  }
  const plan = planGc(snapshot);
  if (plan.rows.length === 0) return;
  for (const row of plan.rows) {
    err.write(
      `[gc] ${row.taskId}: row ${row.rowId} (${row.action}) — run \`forge orchestrate gc\` to apply\n`,
    );
  }
}

function buildSnapshot(
  forgeDir: string,
  now: Date,
  mode: 'cheap' | 'full',
): OrchestratorSnapshot {
  const tasks = scanTasksDir(forgeDir);
  // Tracker integration deferred — see file header.
  const trackerIssues = new Map<string, Issue>();
  // Worktree / branch scans only matter for rows 9, 10 (expensive). Defer until
  // tracker integration is wired and a worktree-list source is plumbed.
  const worktrees: OrchestratorSnapshot['worktrees'] = [];
  const branches: OrchestratorSnapshot['branches'] = [];
  // Empty phases is acceptable — only used by row 10 (orphan worktree check).
  const phases: Phases = { phases: [] } as unknown as Phases;
  return {
    tasks,
    trackerIssues,
    worktrees,
    branches,
    phases,
    now,
    mode,
  };
}

function scanTasksDir(forgeDir: string): Map<string, TaskSnapshot> {
  const root = tasksRootDir(forgeDir);
  const result = new Map<string, TaskSnapshot>();
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (isNodeFsError(e) && e.code === 'ENOENT') return result;
    throw e;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let taskId: string;
    try {
      taskId = validateIdSegment(entry.name, 'taskId');
    } catch {
      continue; // skip unexpected directory names
    }
    const taskDir = join(root, taskId);
    result.set(taskId, {
      state: readStateSafe(taskDir),
      leases: readLeasesSafe(forgeDir, taskId, taskDir),
      attempts: readAttemptsSafe(forgeDir, taskId),
    });
  }
  return result;
}

function readStateSafe(taskDir: string): TaskStateRecord | null {
  const path = join(taskDir, 'state.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const res = TaskStateSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

function readLeasesSafe(
  forgeDir: string,
  taskId: string,
  taskDir: string,
): LeaseAtPath[] {
  // Canonical lease.json + any sibling files matching `lease.json*` are
  // considered. Row 13 fires when more than one is present.
  const out: LeaseAtPath[] = [];
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = readdirSync(taskDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const canonicalPath = leaseFilePath(forgeDir, taskId);
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.startsWith('lease.json')) continue;
    const path = join(taskDir, d.name);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      const validated = LeaseSchema.safeParse(parsed);
      if (!validated.success) continue;
      out.push({
        lease: validated.data,
        path,
        isCanonical: path === canonicalPath,
      });
    } catch {
      // Skip malformed lease files — they would be cleaned up by an explicit
      // operator intervention; gc doesn't try to repair garbage.
    }
  }
  return out;
}

function readAttemptsSafe(forgeDir: string, taskId: string): AttemptSnapshot[] {
  const out: AttemptSnapshot[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(attemptsDir(forgeDir, taskId), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let attemptId: string;
    try {
      attemptId = validateIdSegment(entry.name, 'attemptId');
    } catch {
      continue;
    }
    const aDir = attemptDir(forgeDir, taskId, attemptId);
    const verdictPath = join(aDir, 'verdict.json');
    const verdictVerifiedPath = join(aDir, 'verdict.verified.json');
    const questionsDirPath = join(aDir, 'questions');
    const answersDirPath = join(aDir, 'answers');
    const questionFiles = listJsonFiles(questionsDirPath);
    const answerFiles = listJsonFiles(answersDirPath);
    const questionNames = new Set(questionFiles.map((p) => p.split('/').pop()!));
    const orphanAnswerFiles = answerFiles.filter(
      (p) => !questionNames.has(p.split('/').pop()!),
    );
    // Terminal heuristic: an attempt is "terminal" if its parent task state is
    // terminal OR if no questions/answers exist and the attempt directory is
    // older than 24h. Conservative — false negatives are fine for row 11.
    // For now, infer from absence of any open question files OR presence of
    // verdict.json. We err on the side of NOT calling an attempt terminal —
    // archiving questions of a live attempt would corrupt state.
    const isTerminal = existsSyncSafe(verdictPath);
    out.push({
      attemptId,
      isTerminal,
      verdictPresent: existsSyncSafe(verdictPath),
      verdictVerifiedPresent: existsSyncSafe(verdictVerifiedPath),
      questionFiles,
      orphanAnswerFiles,
    });
  }
  return out;
}

function listJsonFiles(dir: string): string[] {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith('.json')) continue;
    out.push(join(dir, d.name));
  }
  return out;
}

function existsSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Plan formatter (--dry-run)
// ────────────────────────────────────────────────────────────────────────────

function formatPlanForDryRun(plan: GcPlan, out: NodeJS.WritableStream): void {
  if (plan.rows.length === 0) {
    out.write('gc reconciler: no divergences detected.\n');
    return;
  }
  out.write('\ngc reconciler plan (no changes will be made):\n\n');
  out.write('  row  task            action                  description\n');
  out.write('  ───  ─────────────   ─────────────────────   ────────────────────────\n');
  for (const row of plan.rows) {
    const desc = describeRow(row);
    out.write(
      `  ${row.rowId.toString().padStart(2)}   ${row.taskId.padEnd(15)} ${row.action.padEnd(22)}  ${desc}\n`,
    );
  }
  out.write(`\n${plan.rows.length} actions queued. Re-run without --dry-run to apply.\n`);
}

function describeRow(row: GcPlanRow): string {
  switch (row.action) {
    case 'mark_terminal':
      return `mark ${row.payload.targetState}, release lease`;
    case 'mark_abandoned':
      return `mark abandoned (lease expired ${formatAgeMs(row.payload.expiredAgeMs)} ago)`;
    case 'mark_unclaimed':
      return `mark unclaimed (${row.payload.reason})`;
    case 'archive_question':
      return `archive question ${row.payload.questionPath.split('/').pop()}`;
    case 'reverify_verdict':
      return `re-verify attempt ${row.payload.attemptId}`;
    case 'release_lease_admin':
      return `admin-release lease (${row.payload.reason})`;
    case 'prune_branch':
      return `prune branch ${row.payload.branchRef} (${row.payload.reason})`;
    case 'report_orphan':
      return `report orphan: ${row.payload.kind}`;
    default:
      return assertNeverGcRow(row);
  }
}

function formatAgeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

// ────────────────────────────────────────────────────────────────────────────
//  Plan executor — dispatch on action discriminant. Per spec/ORCHESTRATOR.md
//  every row resolution must be idempotent so re-running gc converges. Rows
//  that mutate state.json route through writeTaskState (lease-owned writes are
//  not available to gc, so we use writeTaskState by stealing the lease first
//  for rows 1, 2 — implemented inline below).
// ────────────────────────────────────────────────────────────────────────────

interface ExecuteOutcome {
  readonly applied: boolean;
  // Set when the row's action is recognized but its execution path is deferred
  // to a follow-up PR (tracker reconciler / git ops / state-machine transition
  // glue). Surfaced as a stderr warning, NOT as an error — operator sees that
  // gc detected the divergence and knows infrastructure follow-up is pending.
  readonly deferredReason?: string;
}

function executeRow(
  row: GcPlanRow,
  forgeDir: string,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): ExecuteOutcome {
  switch (row.action) {
    case 'release_lease_admin': {
      const reasonMap = {
        'gc:row-13:duplicate': 'gc:row-13:duplicate' as AdminReleaseReason,
        'gc:row-14:terminal-state': 'gc:row-14:terminal-state' as AdminReleaseReason,
      };
      adminReleaseLeaseByIdentity({
        forgeDir,
        taskId: row.taskId,
        expectedClaimId: row.payload.expectedClaimId,
        expectedGeneration: row.payload.expectedGeneration,
        expectedOwnerRunId: row.payload.expectedOwnerRunId,
        expectedExpiresAt: row.payload.expectedExpiresAt,
        expectedPath: row.payload.expectedPath,
        requireTerminalState: row.payload.requireTerminalState,
        reason: reasonMap[row.payload.reason],
      });
      out.write(
        `  ✓ row ${row.rowId} (${row.taskId}): admin-released lease (${row.payload.reason}) at ${row.payload.expectedPath}\n`,
      );
      return { applied: true };
    }
    case 'archive_question': {
      // Archive: move question file under attempts/<a>/archived/
      const archiveTarget = join(
        dirname(dirname(row.payload.questionPath)),
        'archived',
        row.payload.questionPath.split('/').pop()!,
      );
      mkdirSync(dirname(archiveTarget), { recursive: true, mode: 0o700 });
      renameSync(row.payload.questionPath, archiveTarget);
      out.write(
        `  ✓ row ${row.rowId} (${row.taskId}): archived question to ${archiveTarget}\n`,
      );
      return { applied: true };
    }
    case 'report_orphan':
      // Detection-only — report and continue. Not a failure, not an apply.
      out.write(
        `  ⚠ row ${row.rowId} (${row.taskId}): ${row.payload.description}\n`,
      );
      return { applied: true };
    case 'mark_terminal':
      return executeMarkTerminal(row, forgeDir, out, err);
    case 'mark_abandoned':
      return executeMarkAbandoned(row, forgeDir, out);
    case 'mark_unclaimed':
      return executeMarkUnclaimed(row, forgeDir, out);
    case 'reverify_verdict':
      return executeReverifyVerdict(row, forgeDir, out);
    case 'prune_branch':
      return executePruneBranch(row, forgeDir, out);
    default:
      return assertNeverGcRow(row);
  }
}

function callerFromLeaseIdentity(identity: {
  readonly claimId: string;
  readonly generation: number;
  readonly ownerRunId: string;
}): StateCaller {
  return {
    run_id: identity.ownerRunId,
    claim_id: identity.claimId,
    generation: identity.generation,
  };
}

function writeStateForGc(
  forgeDir: string,
  taskId: string,
  state: TaskStateRecord['state'],
  caller: StateCaller,
  extra: Partial<TaskStateRecord> = {},
): void {
  const current = readTaskState(forgeDir, taskId);
  const next: TaskStateRecord = {
    ...current,
    ...extra,
    state,
    state_version: current.state_version + 1,
    updated_at: new Date().toISOString(),
    updated_by: {
      run_id: caller.run_id,
      claim_id: caller.claim_id,
      generation: caller.generation,
    },
  };
  if (state !== 'failed') delete next.failure_reason;
  writeTaskState(forgeDir, next, caller);
}

function executeMarkTerminal(
  row: Extract<GcPlanRow, { action: 'mark_terminal' }>,
  forgeDir: string,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): ExecuteOutcome {
  if (!row.payload.leaseIdentity.claimId) {
    const reason = 'mark_terminal requires an observed local lease identity; tracker-only row left for manual reconciliation.';
    err.write(`  ⓘ row ${row.rowId} (${row.taskId}): ${reason}\n`);
    return { applied: false, deferredReason: reason };
  }
  const caller = callerFromLeaseIdentity(row.payload.leaseIdentity);
  writeStateForGc(forgeDir, row.taskId, row.payload.targetState, caller, {
    current_attempt_id: null,
  });
  release({ forgeDir, taskId: row.taskId, caller });
  out.write(
    `  ✓ row ${row.rowId} (${row.taskId}): marked ${row.payload.targetState} and released lease\n`,
  );
  return { applied: true };
}

function executeMarkAbandoned(
  row: Extract<GcPlanRow, { action: 'mark_abandoned' }>,
  forgeDir: string,
  out: NodeJS.WritableStream,
): ExecuteOutcome {
  const caller = callerFromLeaseIdentity(row.payload.leaseIdentity);
  writeStateForGc(forgeDir, row.taskId, 'abandoned', caller);
  release({ forgeDir, taskId: row.taskId, caller });
  out.write(
    `  ✓ row ${row.rowId} (${row.taskId}): marked abandoned and released expired lease\n`,
  );
  return { applied: true };
}

function executeMarkUnclaimed(
  row: Extract<GcPlanRow, { action: 'mark_unclaimed' }>,
  forgeDir: string,
  out: NodeJS.WritableStream,
): ExecuteOutcome {
  const caller = callerFromLeaseIdentity(row.payload.leaseIdentity);
  writeStateForGc(forgeDir, row.taskId, 'unclaimed', caller, {
    current_attempt_id: null,
  });
  release({ forgeDir, taskId: row.taskId, caller });
  out.write(
    `  ✓ row ${row.rowId} (${row.taskId}): marked unclaimed (${row.payload.reason}) and released lease\n`,
  );
  return { applied: true };
}

function executeReverifyVerdict(
  row: Extract<GcPlanRow, { action: 'reverify_verdict' }>,
  forgeDir: string,
  out: NodeJS.WritableStream,
): ExecuteOutcome {
  const aDir = attemptDir(forgeDir, row.taskId, row.payload.attemptId);
  const verdictPath = join(aDir, 'verdict.json');
  const verifiedPath = join(aDir, 'verdict.verified.json');
  if (existsSyncSafe(verifiedPath)) {
    out.write(
      `  ✓ row ${row.rowId} (${row.taskId}): verdict already verified at ${verifiedPath}\n`,
    );
    return { applied: true };
  }
  const raw = readFileSync(verdictPath, 'utf8');
  const parsed = VerdictSchema.parse(JSON.parse(raw));
  const verified = {
    ...parsed,
    verified_by: 'cli@gc-self-attest',
    verified_at: new Date().toISOString(),
  };
  writeFileSync(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`, { flag: 'wx' });
  out.write(
    `  ✓ row ${row.rowId} (${row.taskId}): wrote verdict.verified.json for attempt ${row.payload.attemptId}\n`,
  );
  return { applied: true };
}

function executePruneBranch(
  row: Extract<GcPlanRow, { action: 'prune_branch' }>,
  forgeDir: string,
  out: NodeJS.WritableStream,
): ExecuteOutcome {
  const repoRoot = dirname(forgeDir);
  const branch = row.payload.branchRef.replace(/^refs\/heads\//, '');
  const result = spawnSync('git', ['-C', repoRoot, 'branch', '-D', branch], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '');
    if (/not found|branch .* not found|Cannot delete branch/i.test(stderr)) {
      out.write(
        `  ✓ row ${row.rowId} (${row.taskId}): branch ${branch} already absent\n`,
      );
      return { applied: true };
    }
    throw new Error(stderr.trim() || `git branch -D ${branch} failed`);
  }
  out.write(
    `  ✓ row ${row.rowId} (${row.taskId}): pruned branch ${branch} (${row.payload.reason})\n`,
  );
  return { applied: true };
}
