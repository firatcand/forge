// `forge orchestrate phases` — read-only graph state inspection.
//
// Default form: dump the parsed phases.yaml task list.
// --ready form: return tasks ready to claim, with optional phase filter and
// per-task overlap classification vs the active-attempts set.
//
// Read-only band: no lease, no tracker mutation, no state write.

import { statSync } from 'node:fs';
import path from 'node:path';

import { loadPhases } from '../../core/phases.ts';
import type { Phases, Task } from '../../schemas/phases.ts';
import {
  classifyOverlap,
  type OverlapClassification,
} from '../../orchestrator/overlap.ts';
import {
  collectActiveAttempts,
  isTrackerIdDone,
} from '../../orchestrator/readiness.ts';
import { PhasesArgsSchema, type PhasesArgs } from '../../schemas/cli-args.ts';
import type { VerbHandler } from './index.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { detectCheapDivergences } from './gc.ts';

const PHASES_YAML_PATHS = ['plans/phases.yaml', 'phases.yaml'] as const;

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
  readonly overlap: {
    readonly classification: OverlapClassification;
    readonly offendingGlobs: readonly string[];
    readonly conflictingTaskIds: readonly string[];
  };
}

export interface PhasesResultData {
  readonly tasks: readonly ReadyTaskOut[];
  readonly overlap_check: 'enabled' | 'disabled';
}

export async function runOrchestratePhases(args: PhasesArgs): Promise<{ exitCode: number }> {
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
      exitCode: emit(
        fail(
          'PHASES_PARSE_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
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
  detectCheapDivergences(opts.forgeDir, process.stderr, new Date());

  // --ready filter pipeline.
  const doneTaskIds = new Set<string>();
  for (const { task } of tasks) {
    if (task.status === 'done') doneTaskIds.add(task.id);
  }

  const candidates: Array<{ task: Task; phaseId: string }> = [];
  for (const { task, phaseId, phaseStatus } of tasks) {
    if (task.status && task.status !== 'active') continue; // skip deferred/dropped/done/paused
    if (phaseStatus === 'blocked') continue;
    if (opts.blockedBy && !task.depends_on.includes(opts.blockedBy)) continue;
    if (opts.phase) {
      // Phase filter currently only meaningful for tasks that have not been
      // dispatched: we surface them under 'implement' by default. The dispatch
      // skill decides whether the candidate is review-ready or ship-ready.
      if (opts.phase !== 'implement') continue;
    }
    // Are all deps satisfied?
    const allDepsDone = task.depends_on.every(
      (depId) => doneTaskIds.has(depId) || isTrackerIdDone(depId, tasks),
    );
    if (!allDepsDone) continue;
    candidates.push({ task, phaseId });
  }

  // Build active-attempts set by scanning .forge/orchestrator/tasks/.
  const activeAttempts = collectActiveAttempts(opts.forgeDir, tasks);

  const out: ReadyTaskOut[] = candidates.map(({ task, phaseId }) => {
    const overlap = classifyOverlap({
      activeAttempts,
      candidate: { taskId: task.id, writeGlobs: task.write_globs ?? [] },
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
      ...(task.tracker_issue_id ? { tracker_issue_id: task.tracker_issue_id } : {}),
      overlap: {
        classification: overlap.classification,
        offendingGlobs: overlap.offendingGlobs,
        conflictingTaskIds: overlap.conflictingTaskIds,
      },
    };
  });

  const limited = opts.limit ? out.slice(0, opts.limit) : out;
  const result: PhasesResultData = { tasks: limited, overlap_check: 'enabled' };
  return { exitCode: emit(ok(result), { json: opts.json }) };
}

function resolvePhasesYaml(cwd: string): string | undefined {
  for (const rel of PHASES_YAML_PATHS) {
    const full = path.join(cwd, rel);
    try {
      const s = statSync(full);
      if (s.isFile()) return full;
    } catch {
      // ENOENT: try next.
    }
  }
  return undefined;
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
    const args: PhasesArgs = {
      ready,
      forgeDir,
      json,
      ...(phase ? { phase: phase as 'implement' | 'review' | 'ship' } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(limit && !Number.isNaN(limit) ? { limit } : {}),
      ...(runId ? { runId } : {}),
    };
    return runOrchestratePhases(args);
  },
};
