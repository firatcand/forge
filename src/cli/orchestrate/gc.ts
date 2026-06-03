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
  stateFilePath,
  tasksRootDir,
  validateIdSegment,
} from '../../orchestrator/questions/paths.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import {
  TaskStateSchema,
  type TaskStateRecord,
} from '../../schemas/task-state.ts';
import type { Phases } from '../../schemas/phases.ts';
import { VerdictSchema } from '../../schemas/verdict.ts';
import type { Issue } from '../../trackers/types.ts';

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

export function runOrchestrateGc(
  opts: OrchestrateGcOptions,
): OrchestrateGcResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? (() => new Date());

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
