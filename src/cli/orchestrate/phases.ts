// `forge orchestrate phases` — read-only graph state inspection.
//
// Default form: dump the parsed phases.yaml task list.
// --ready form: return tasks ready to claim, with optional phase filter and
// per-task overlap classification vs the active-attempts set.
//
// Read-only band: no lease, no tracker mutation, no state write.

import path from 'node:path';

import { loadPhases, resolvePhasesYaml } from '../../core/phases.ts';
import { evaluateShipDependencyGate, type DependencyObserver } from '../../orchestrator/dependency-gate.ts';
import type { DependencyGateReport } from '../../schemas/dependency-gate.ts';
import { createDependencyObserver } from '../../repo-hosts/detect.ts';
import { ghExec } from './gh-exec.ts';
import { PhasesError } from '../../core/errors.ts';
import { loadSettings } from '../../core/settings.ts';
import type { Phases, Task } from '../../schemas/phases.ts';
import {
  classifyOverlap,
  type OverlapClassification,
} from '../../orchestrator/overlap.ts';
import {
  collectActiveAttempts,
  collectTasksByState,
  isTrackerIdDone,
} from '../../orchestrator/readiness.ts';
import { PhasesArgsSchema, type PhasesArgs } from '../../schemas/cli-args.ts';
import type { VerbHandler } from './index.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { detectCheapDivergences, type GcCheapWarning } from './gc.ts';
import { readTaskState } from '../../orchestrator/state-machine.ts';
import {
  DEFAULT_RETRY_POLICY,
  nextEligibleAt,
  type RetryPolicy,
} from '../../orchestrator/retry.ts';

export interface ReadyTaskOut {
  readonly task_id: string;
  readonly tracker_issue_id?: string;
  readonly title: string;
  readonly phase: string;
  readonly priority: string;
  readonly estimate: string;
  readonly owner_type: string;
  readonly type: string;
  readonly depends_on: readonly string[];
  // FORGE-215: the task's raw DECLARED write_globs. `overlap` above classifies a
  // candidate against the ACTIVE-attempts set (parallel-dispatch safety), so a
  // set of all-ready related tickets shows `no-overlap` and cannot be grouped
  // from it. /deliver's themed batching needs candidate-vs-CANDIDATE subsystem
  // grouping, which requires the raw globs — exposed here (the grouping policy
  // itself stays in the /deliver skill). `[]` when the task declares none.
  readonly write_globs: readonly string[];
  readonly overlap: {
    readonly classification: OverlapClassification;
    readonly offendingGlobs: readonly string[];
    readonly conflictingTaskIds: readonly string[];
  };
}

export interface HumanCheckpointOut {
  readonly task_id: string;
  readonly tracker_issue_id?: string;
  readonly title: string;
  readonly phase: string;
  readonly depends_on: readonly string[];
}

export interface PhasesResultData {
  readonly tasks: readonly ReadyTaskOut[];
  readonly overlap_check: 'enabled' | 'disabled';
  // FORGE-177: ready tasks with owner_type 'human' are NOT dispatchable — they
  // surface here as manual checkpoints so they stay queue-visible without being
  // auto-claimed by the dispatch loop.
  readonly human_checkpoints: readonly HumanCheckpointOut[];
  // FORGE-149: present ONLY when --include-warnings is set (with --json on
  // --ready). Omitted entirely otherwise so legacy output is byte-identical.
  readonly warnings?: readonly GcCheapWarning[];
}

// FORGE-176: cap on the number of issue bullets rendered into the human stderr
// message, to avoid flooding the terminal on a deeply-broken phases.yaml. The
// full set always rides in error.details.issues for --json consumers.
const MAX_RENDERED_ISSUES = 20;

interface PhasesIssueOut {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

// Build the PHASES_PARSE_ERROR envelope. When the underlying failure is a
// schema (Zod) validation error, surface the structured issues at
// error.details.issues (for --json) AND compose them as bullets into the human
// message (the envelope renderer never prints details). Non-schema failures
// (read/parse/yaml) fall back to the bare message.
function buildPhasesParseFailure(err: unknown): ReturnType<typeof fail> {
  if (err instanceof PhasesError && Array.isArray(err.details.issues)) {
    const issues: PhasesIssueOut[] = (err.details.issues as Array<{
      path: Array<string | number>;
      code: string;
      message: string;
    }>).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    const shown = issues.slice(0, MAX_RENDERED_ISSUES);
    const bullets = shown.map((i) => `  - ${i.path}: ${i.message}`);
    if (issues.length > shown.length) {
      bullets.push(`  - +${issues.length - shown.length} more`);
    }
    const message = `phases schema validation failed:\n${bullets.join('\n')}`;
    return fail('PHASES_PARSE_ERROR', message, false, { issues });
  }
  return fail(
    'PHASES_PARSE_ERROR',
    err instanceof Error ? err.message : String(err),
    false,
  );
}

export async function runOrchestratePhases(
  args: PhasesArgs,
  deps: { observerFor?: (depStateId: string) => Promise<DependencyObserver | null> } = {},
): Promise<{ exitCode: number }> {
  const parsed = PhasesArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', `phases: ${parsed.error.message}`, false),
        { json: args.json },
      ),
    };
  }
  const opts = parsed.data;
  const cwd = opts.forgeDir.replace(/[/\\]\.forge\/?$/, '') || process.cwd();
  const phasesPath = resolvePhasesYaml(cwd);
  if (!phasesPath) {
    return {
      exitCode: emit(
        fail(
          'PHASES_NOT_FOUND',
          'phases.yaml not found at plans/phases.yaml or ./phases.yaml',
          false,
        ),
        { json: opts.json },
      ),
    };
  }
  let phases: Phases;
  try {
    const loaded = loadPhases(phasesPath);
    phases = loaded.phases;
    // Freshness line goes to stderr before main output. Loader stays pure;
    // caller decides surfacing (FORGE-113 plan §0 Q1).
    process.stderr.write(loaded.freshnessLine + '\n');
  } catch (err) {
    return {
      exitCode: emit(buildPhasesParseFailure(err), { json: opts.json }),
    };
  }

  // Flatten tasks once with phase ordinal so we can filter / surface metadata.
  const tasks: Array<{ task: Task; phaseId: string; phaseStatus: string }> = [];
  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      tasks.push({ task, phaseId: phase.id, phaseStatus: phase.status });
    }
  }

  if (!opts.ready) {
    // Default form: dump full task list (lightly projected) — supports `--limit`.
    const projected = tasks.map(({ task, phaseId }) => ({
      task_id: task.tracker_issue_id ?? task.id,
      phases_task_id: task.id,
      phase: phaseId,
      title: task.title,
      status: task.status ?? 'active',
      depends_on: task.depends_on,
    }));
    const limited = opts.limit ? projected.slice(0, opts.limit) : projected;
    return {
      exitCode: emit(ok({ tasks: limited }), { json: opts.json }),
    };
  }

  // Cheap auto-gc detect-and-warn (FORGE-22). Fires only on --ready path so
  // the dump form stays minimal. Writes warnings to stderr (matching the
  // freshness-line precedent above); never mutates state. JSON stdout is
  // unaffected.
  const cheapWarnings = detectCheapDivergences(opts.forgeDir, process.stderr, new Date());

  // --ready filter pipeline.
  const doneTaskIds = new Set<string>();
  for (const { task } of tasks) {
    if (task.status === 'done') doneTaskIds.add(task.id);
  }

  const candidates: Array<{ task: Task; phaseId: string }> = [];
  // FORGE-233: ship candidates pass through the dependency-merge gate; the
  // unsatisfied ones surface with their machine-readable reports (read-only,
  // suggest-don't-force — the skill shows WHY a reviewed task can't ship).
  const shipGateCandidates: Array<{ task: Task; phaseId: string }> = [];
  const blockedOnDeps: Array<{ task_id: string; dependency_gate: DependencyGateReport }> = [];
  // FORGE-177: ready human-owned tasks are collected separately so the dispatch
  // loop never claims them, but they remain queue-visible as manual checkpoints.
  const humanCheckpoints: HumanCheckpointOut[] = [];
  for (const { task, phaseId, phaseStatus } of tasks) {
    if (task.status && task.status !== 'active') continue; // skip deferred/dropped/done/paused
    if (phaseStatus === 'blocked') continue;
    if (opts.blockedBy && !task.depends_on.includes(opts.blockedBy)) continue;
    if (opts.phase && opts.phase !== 'implement') {
      // FORGE-231: --phase review lists tasks whose ORCHESTRATOR state is
      // ready_for_review (dual-host review dispatch candidates); --phase ship
      // lists reviewed (ship dispatch candidates). Both are read-only listings
      // over the capped state scanner; phases.yaml supplies the metadata.
      const wanted = opts.phase === 'review' ? 'ready_for_review' : 'reviewed';
      const inState = collectTasksByState(opts.forgeDir, (s) => s === wanted);
      const ids = new Set(inState.map((t) => t.taskId));
      const candidateId = task.tracker_issue_id ?? task.id;
      if (!ids.has(candidateId) && !ids.has(task.id)) continue;
      if (opts.phase === 'ship') {
        shipGateCandidates.push({ task, phaseId });
        continue;
      }
      candidates.push({ task, phaseId });
      continue;
    }
    // FORGE-234 (impl R1 MAJ #5): the explicit IMPLEMENT listing must never
    // surface a task whose orchestrator lifecycle has moved past implement —
    // a reviewed SHIP-failure retry is a ship candidate, not an implement one.
    if (opts.phase === 'implement') {
      try {
        const s = readTaskState(opts.forgeDir, task.tracker_issue_id ?? task.id);
        if (s.state === 'reviewed' || s.state === 'ready_for_review' || s.state === 'merge_pending' || s.state === 'shipped') {
          continue;
        }
      } catch {
        // no orchestrator state → normal implement candidate
      }
    }
    // Are all deps satisfied?
    const allDepsDone = task.depends_on.every(
      (depId) => doneTaskIds.has(depId) || isTrackerIdDone(depId, tasks),
    );
    if (!allDepsDone) continue;
    if (task.owner_type === 'human') {
      // Not dispatchable — surface as a manual checkpoint instead of a candidate.
      humanCheckpoints.push({
        task_id: task.tracker_issue_id ?? task.id,
        title: task.title,
        phase: phaseId,
        depends_on: task.depends_on,
        ...(task.tracker_issue_id ? { tracker_issue_id: task.tracker_issue_id } : {}),
      });
      continue;
    }
    candidates.push({ task, phaseId });
  }

  // Build active-attempts set by scanning .forge/orchestrator/tasks/.
  const activeAttempts = collectActiveAttempts(opts.forgeDir, tasks);
  // FORGE-170: honor settings.agents.hard_lock_globs override (default list otherwise).
  let hardLockGlobs: readonly string[] | undefined;
  let retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;
  try {
    const settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
    hardLockGlobs = settings.agents.hard_lock_globs;
    retryPolicy = {
      retry_attempts: settings.agents.retry_attempts,
      retry_backoff_ms_max: settings.agents.retry_backoff_ms_max,
    };
  } catch {
    hardLockGlobs = undefined;
  }

  if (shipGateCandidates.length > 0) {
    const allTasks = phases.phases.flatMap((ph) => ph.tasks);
    for (const cand of shipGateCandidates) {
      const report = await evaluateShipDependencyGate({
        forgeDir: opts.forgeDir,
        taskId: cand.task.tracker_issue_id ?? cand.task.id,
        tasks: allTasks,
        observerFor:
          deps.observerFor ?? ((depId) => createDependencyObserver(opts.forgeDir, depId, ghExec)),
      });
      if (report.satisfied) {
        candidates.push(cand);
      } else {
        blockedOnDeps.push({ task_id: cand.task.tracker_issue_id ?? cand.task.id, dependency_gate: report });
      }
    }
  }

  const retryEligible = candidates.filter(({ task }) => {
    const taskId = task.tracker_issue_id ?? task.id;
    try {
      const state = readTaskState(opts.forgeDir, taskId);
      // FORGE-234 (plan v3 Δ13): a budgeted SHIP failure leaves the task in
      // `reviewed` — backoff applies ONLY to the ship listing (implement
      // NEVER lists reviewed tasks; review/default listings are unchanged),
      // with failure_count as the exponent.
      if (opts.phase === 'ship' && state.state === 'reviewed' && state.failure_count > 0 && state.last_failed_at) {
        return nextEligibleAt(state.failure_count, state.last_failed_at, retryPolicy) <= new Date();
      }
      if (state.state !== 'running' || !state.last_failed_at) return true;
      return nextEligibleAt(state.attempt_count, state.last_failed_at, retryPolicy) <= new Date();
    } catch {
      return true;
    }
  });

  const out: ReadyTaskOut[] = retryEligible.map(({ task, phaseId }) => {
    const overlap = classifyOverlap({
      activeAttempts,
      candidate: { taskId: task.id, writeGlobs: task.write_globs ?? [] },
      ...(hardLockGlobs ? { hardLockGlobs } : {}),
    });
    return {
      task_id: task.tracker_issue_id ?? task.id,
      title: task.title,
      phase: phaseId,
      priority: task.priority,
      estimate: task.estimate,
      owner_type: task.owner_type,
      type: task.type,
      depends_on: task.depends_on,
      write_globs: task.write_globs ?? [],
      ...(task.tracker_issue_id ? { tracker_issue_id: task.tracker_issue_id } : {}),
      overlap: {
        classification: overlap.classification,
        offendingGlobs: overlap.offendingGlobs,
        conflictingTaskIds: overlap.conflictingTaskIds,
      },
    };
  });

  const limited = opts.limit ? out.slice(0, opts.limit) : out;
  const result: PhasesResultData = {
    tasks: limited,
    overlap_check: 'enabled',
    human_checkpoints: humanCheckpoints,
    ...(opts.phase === 'ship' ? { blocked_on_deps: blockedOnDeps } : {}),
    // FORGE-149: opt-in. Field omitted entirely when the flag is absent so the
    // JSON shape is byte-identical to the pre-change output for existing consumers.
    ...(opts.includeWarnings ? { warnings: cheapWarnings } : {}),
  };
  // Human (stderr) surfacing: keep human checkpoints visible in the non-JSON
  // form too, where the envelope renderer only dumps `tasks`. JSON stdout is
  // unaffected (the field rides in the envelope's data).
  if (!opts.json && humanCheckpoints.length > 0) {
    for (const cp of humanCheckpoints) {
      process.stderr.write(
        `⏸ human checkpoint (not dispatchable): ${cp.task_id} — ${cp.title}\n`,
      );
    }
  }
  return { exitCode: emit(ok(result), { json: opts.json }) };
}

// Adapter for the verb-table dispatcher.
export const phasesHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List tasks from phases.yaml (with --ready, filter to dispatchable + overlap-classified).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const ready = hasFlag(rest, 'ready');
    const json = hasFlag(rest, 'json');
    const phase = parseFlag(rest, 'phase');
    const blockedBy = parseFlag(rest, 'blocked-by');
    const limitRaw = parseFlag(rest, 'limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const runId = parseFlag(rest, 'run-id') ?? parseFlag(rest, 'run');
    const includeWarnings = hasFlag(rest, 'include-warnings');
    const args: PhasesArgs = {
      ready,
      forgeDir,
      json,
      includeWarnings,
      ...(phase ? { phase: phase as 'implement' | 'review' | 'ship' } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(limit && !Number.isNaN(limit) ? { limit } : {}),
      ...(runId ? { runId } : {}),
    };
    return runOrchestratePhases(args);
  },
};
