// `forge orchestrate dashboard` — read-only cross-run cockpit (FORGE-90 / P2-T22).
//
// Aggregates ALL orchestrator state into one "where am I?" view:
//   - active_sessions  : run manifests + the tasks each run currently holds
//   - open_questions   : worker questions awaiting a supervisor answer
//   - ready_tasks      : dep-satisfied + unclaimed (from the LOCAL phases.yaml cache)
//   - blocked_tasks    : tasks with unsatisfied deps + the blocking task ids
//   - overlap_warnings : file-glob collisions between in-flight tasks
//   - lease_health     : alive / expiring_soon / stale per held lease
//
// Read-only band: no lease, no tracker mutation, no state write. The verb is a
// best-effort, non-atomic snapshot — it reads many files with no lock while
// workers mutate them, so transient mismatches (e.g. state=running with a
// released lease) are expected and harmless for a status view.
//
// Source-of-truth note: ready/blocked is computed from the LOCAL phases.yaml
// dependency graph (forge's "tracker is truth, phases.yaml is a cache" rule).
// The envelope labels this via `source.ready_blocked`; the /status-check skill
// (which can reach the tracker) is the layer that refreshes against truth.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { loadPhases } from '../../core/phases.ts';
import type { Task } from '../../schemas/phases.ts';
import { classifyOverlap, type TaskWriteGlobs } from '../../orchestrator/overlap.ts';
import {
  classifyLeaseHealth,
  type LeaseHealth,
} from '../../orchestrator/leases.ts';
import {
  ACTIVE_STATES,
  collectActiveAttempts,
  isTrackerIdDone,
} from '../../orchestrator/readiness.ts';
import { listOpenQuestionsAcrossTree } from '../../orchestrator/questions/index.ts';
import {
  tasksRootDir,
  stateFilePath,
  leaseFilePath,
  validateIdSegment,
} from '../../orchestrator/questions/paths.ts';
import { TaskStateSchema, type TaskStateRecord } from '../../schemas/task-state.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { DashboardArgsSchema, type DashboardArgs } from '../../schemas/cli-args.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// Per-file read cap — mirrors status.ts. .forge files are treated as untrusted.
const FILE_MAX_BYTES = 1 * 1024 * 1024;

const PHASES_YAML_PATHS = ['plans/phases.yaml', 'phases.yaml'] as const;

// Run manifest shape — same as run-list.ts (not exported there).
const ManifestSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1),
  started_at: z.string().datetime(),
  name: z.string().nullable(),
  host: z.string().min(1),
});

export interface ActiveSession {
  readonly run_id: string;
  readonly started_at: string;
  readonly claimed_tasks: string[];
}
export interface OpenQuestionOut {
  readonly question_id: string;
  readonly task_id: string;
  readonly decision_key: string;
  readonly options: { id: string; label: string; description?: string }[];
}
export interface BlockedTask {
  readonly task_id: string;
  readonly blocked_by: string[];
}
export interface OverlapWarning {
  readonly task_a: string;
  readonly task_b: string;
  readonly globs: string[];
  readonly severity: 'hard' | 'soft';
}
export interface LeaseHealthOut {
  readonly task_id: string;
  readonly status: LeaseHealth;
}
export interface DashboardData {
  readonly active_sessions: ActiveSession[];
  readonly open_questions: OpenQuestionOut[];
  readonly ready_tasks: string[];
  readonly blocked_tasks: BlockedTask[];
  readonly overlap_warnings: OverlapWarning[];
  readonly lease_health: LeaseHealthOut[];
  readonly source: { ready_blocked: 'local-cache' | 'unavailable' };
  readonly warnings: string[];
}

export interface OrchestrateDashboardOptions {
  readonly forgeDir: string;
  readonly json?: boolean;
  // Injectable for deterministic lease-health classification in tests.
  readonly now?: Date;
  // Injectable streams so PassThrough fixtures can capture output. The shared
  // logger / emit() write straight to process.stdout and are invisible to
  // captured streams, so this verb owns its writes (precedent: status.ts).
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}
export interface OrchestrateDashboardResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

function readJsonCapped(filePath: string): unknown | undefined {
  let raw: string;
  try {
    const s = statSync(filePath);
    if (!s.isFile() || s.size > FILE_MAX_BYTES) return undefined;
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function resolvePhasesYaml(cwd: string): string | undefined {
  for (const rel of PHASES_YAML_PATHS) {
    const full = path.join(cwd, rel);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // try next
    }
  }
  return undefined;
}

interface TaskRow {
  readonly taskId: string;
  readonly state?: TaskStateRecord;
  readonly lease?: Lease;
}

// Walk .forge/orchestrator/tasks/<id>/ reading state.json + lease.json. Dir
// names are validated before path-joining (path-traversal guard); corrupt /
// schema-invalid files are skipped.
function collectTaskRows(forgeDir: string): TaskRow[] {
  const root = tasksRootDir(forgeDir);
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: TaskRow[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    let taskId: string;
    try {
      taskId = validateIdSegment(ent.name, 'taskId');
    } catch {
      continue; // hostile / malformed dir name — skip
    }
    const stateParsed = TaskStateSchema.safeParse(
      readJsonCapped(stateFilePath(forgeDir, taskId)),
    );
    const leaseParsed = LeaseSchema.safeParse(
      readJsonCapped(leaseFilePath(forgeDir, taskId)),
    );
    rows.push({
      taskId,
      ...(stateParsed.success ? { state: stateParsed.data } : {}),
      ...(leaseParsed.success ? { lease: leaseParsed.data } : {}),
    });
  }
  return rows;
}

function buildActiveSessions(
  forgeDir: string,
  rows: readonly TaskRow[],
): ActiveSession[] {
  // A session is "active" iff it currently owns >=1 in-flight task. Seeding
  // from every run manifest (Codex review-impl, dashboard.ts active_sessions)
  // would report long-quiesced runs as active forever — `forge orchestrate run
  // list` is the verb for the full run inventory. Group in-flight tasks by the
  // run that owns their lease; an orphaned owner (lease but no manifest) still
  // surfaces, with an empty started_at.
  const claimedByRun = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.lease || !row.state) continue;
    if (!ACTIVE_STATES.has(row.state.state)) continue;
    const runId = row.lease.owner_run_id;
    const list = claimedByRun.get(runId) ?? [];
    list.push(row.taskId);
    claimedByRun.set(runId, list);
  }
  if (claimedByRun.size === 0) return [];

  // Enrich each owning run with started_at from its manifest (when present).
  const runsRoot = path.join(forgeDir, 'orchestrator', 'runs');
  const sessions: ActiveSession[] = [];
  for (const [runId, claimed] of claimedByRun) {
    const m = ManifestSchema.safeParse(
      readJsonCapped(path.join(runsRoot, runId, 'manifest.json')),
    );
    sessions.push({
      run_id: runId,
      started_at: m.success ? m.data.started_at : '',
      claimed_tasks: claimed,
    });
  }
  return sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function computeReadyAndBlocked(
  flat: ReadonlyArray<{ task: Task; phaseStatus: string }>,
  claimedIds: ReadonlySet<string>,
): { ready: string[]; blocked: BlockedTask[] } {
  const doneTaskIds = new Set<string>();
  for (const { task } of flat) {
    if (task.status === 'done') doneTaskIds.add(task.id);
  }
  const ready: string[] = [];
  const blocked: BlockedTask[] = [];
  for (const { task, phaseStatus } of flat) {
    if (task.status && task.status !== 'active') continue; // done/paused/deferred/dropped
    const unsatisfied = task.depends_on.filter(
      (dep) => !(doneTaskIds.has(dep) || isTrackerIdDone(dep, flat)),
    );
    const displayId = task.tracker_issue_id ?? task.id;
    if (unsatisfied.length > 0) {
      blocked.push({ task_id: displayId, blocked_by: unsatisfied });
      continue;
    }
    if (phaseStatus === 'blocked') continue; // phase gate not open — not ready (parity w/ phases --ready)
    const claimed =
      claimedIds.has(task.id) ||
      (task.tracker_issue_id ? claimedIds.has(task.tracker_issue_id) : false);
    if (claimed) continue;
    ready.push(displayId);
  }
  return { ready, blocked };
}

function buildOverlapWarnings(activeAttempts: readonly TaskWriteGlobs[]): OverlapWarning[] {
  const out: OverlapWarning[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < activeAttempts.length; i += 1) {
    const candidate = activeAttempts[i];
    if (!candidate) continue;
    const rest = activeAttempts.filter((_, j) => j !== i);
    const res = classifyOverlap({ activeAttempts: rest, candidate });
    if (res.classification === 'no-overlap') continue;
    const severity = res.classification === 'hard-overlap' ? 'hard' : 'soft';
    for (const other of res.conflictingTaskIds) {
      const pair = [candidate.taskId, other].sort();
      const key = `${pair[0]} ${pair[1]} ${severity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        task_a: pair[0] ?? candidate.taskId,
        task_b: pair[1] ?? other,
        globs: [...res.offendingGlobs],
        severity,
      });
    }
  }
  return out;
}

function ttyWidth(): number {
  const w = process.stdout.columns;
  return w && w > 0 ? w : 80;
}

function formatDashboard(d: DashboardData, width: number): string {
  const hr = '─'.repeat(Math.max(20, Math.min(width, 100)));
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push('', title, hr);
  };

  section('Active workers');
  if (d.active_sessions.length === 0) lines.push('  (none)');
  for (const s of d.active_sessions) {
    lines.push(`  ${s.run_id}${s.started_at ? ` · started ${s.started_at}` : ''}`);
    lines.push(
      `    claimed: ${s.claimed_tasks.length ? s.claimed_tasks.join(', ') : '(none)'}`,
    );
  }

  section('Open questions');
  if (d.open_questions.length === 0) lines.push('  (none)');
  for (const q of d.open_questions) {
    lines.push(`  [${q.question_id}] ${q.task_id} — ${q.decision_key}`);
  }

  section('Ready vs blocked');
  lines.push(`  ready (${d.ready_tasks.length}): ${d.ready_tasks.join(', ') || '(none)'}`);
  if (d.blocked_tasks.length === 0) lines.push('  blocked (0): (none)');
  for (const b of d.blocked_tasks) {
    lines.push(`  blocked: ${b.task_id} ← ${b.blocked_by.join(', ')}`);
  }
  lines.push(
    d.source.ready_blocked === 'unavailable'
      ? '  (phases.yaml unavailable — ready/blocked omitted)'
      : '  (from local cache — run /reconcile for tracker truth)',
  );

  section('Overlap + lease warnings');
  if (d.overlap_warnings.length === 0) lines.push('  overlap: (none)');
  for (const o of d.overlap_warnings) {
    lines.push(`  overlap[${o.severity}]: ${o.task_a} ∩ ${o.task_b} on ${o.globs.join(', ')}`);
  }
  const unhealthy = d.lease_health.filter((l) => l.status !== 'alive');
  if (unhealthy.length === 0) lines.push('  leases: all alive');
  for (const l of unhealthy) lines.push(`  lease ${l.status}: ${l.task_id}`);

  if (d.warnings.length > 0) {
    section('Warnings');
    for (const w of d.warnings) lines.push(`  ! ${w}`);
  }
  lines.push('', '  (best-effort snapshot — files may change mid-read)');
  return lines.join('\n') + '\n';
}

export function runOrchestrateDashboard(
  opts: OrchestrateDashboardOptions,
): OrchestrateDashboardResult {
  const out = opts.stdout ?? process.stdout;
  const json = opts.json === true;
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const parsed = DashboardArgsSchema.safeParse({
    forgeDir: opts.forgeDir,
    json,
  });
  if (!parsed.success) {
    return { exitCode: writeEnvelope(fail('INVALID_ARGS', parsed.error.message, false), out) };
  }
  const forgeDir = parsed.data.forgeDir;

  const rows = collectTaskRows(forgeDir);

  // claimedIds: orchestrator task ids in an active state (used to exclude from ready).
  const claimedIds = new Set<string>();
  for (const row of rows) {
    if (row.state && ACTIVE_STATES.has(row.state.state)) claimedIds.add(row.state.task_id);
  }

  const active_sessions = buildActiveSessions(forgeDir, rows);

  // Open questions — reuse the shared tree walker.
  const open_questions: OpenQuestionOut[] = [];
  try {
    const questions = listOpenQuestionsAcrossTree({
      forgeDir,
      onSkip: (p, e) => warnings.push(`skipped question ${p}: ${e.code}`),
    });
    for (const q of questions) {
      open_questions.push({
        question_id: q.question_id,
        task_id: q.task_id,
        decision_key: q.decision_key,
        options: q.options.map((o) => ({
          id: o.id,
          label: o.label,
          ...(o.description !== undefined ? { description: o.description } : {}),
        })),
      });
    }
  } catch (e) {
    warnings.push(`open-questions walk failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Ready / blocked from the LOCAL phases.yaml cache (degrade gracefully).
  const cwd = forgeDir.replace(/[/\\]\.forge\/?$/, '') || process.cwd();
  const phasesPath = resolvePhasesYaml(cwd);
  let flatTasks: { task: Task; phaseStatus: string }[] = [];
  let phasesLoaded = false;
  if (!phasesPath) {
    warnings.push('phases.yaml not found — ready/blocked unavailable');
  } else {
    try {
      const { phases } = loadPhases(phasesPath);
      flatTasks = phases.phases.flatMap((ph) =>
        ph.tasks.map((task) => ({ task, phaseStatus: ph.status })),
      );
      phasesLoaded = true;
    } catch (e) {
      warnings.push(
        `phases.yaml unreadable — ready/blocked unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const { ready, blocked } = phasesLoaded
    ? computeReadyAndBlocked(flatTasks, claimedIds)
    : { ready: [] as string[], blocked: [] as BlockedTask[] };

  // Overlap warnings — reuse the shared active-attempt scanner for write_globs.
  const activeAttempts = collectActiveAttempts(forgeDir, flatTasks);
  const overlap_warnings = buildOverlapWarnings(activeAttempts);

  // Lease health — every task that holds a lease (orphaned leases included).
  const lease_health: LeaseHealthOut[] = rows
    .filter((r): r is TaskRow & { lease: Lease } => r.lease !== undefined)
    .map((r) => ({ task_id: r.taskId, status: classifyLeaseHealth(r.lease.expires_at, now) }));

  const data: DashboardData = {
    active_sessions,
    open_questions,
    ready_tasks: ready,
    blocked_tasks: blocked,
    overlap_warnings,
    lease_health,
    source: { ready_blocked: phasesLoaded ? 'local-cache' : 'unavailable' },
    warnings,
  };

  if (json) {
    return { exitCode: writeEnvelope(ok(data), out) };
  }
  out.write(formatDashboard(data, ttyWidth()));
  return { exitCode: 0 };
}

export const dashboardHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Cross-run cockpit: active sessions, open questions, ready/blocked, overlap + lease health.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    return runOrchestrateDashboard({ forgeDir, json: hasFlag(rest, 'json') });
  },
};

// Re-export the args type for symmetry with sibling verb modules.
export type { DashboardArgs };
