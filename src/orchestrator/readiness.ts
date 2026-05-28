// Policy-free dependency-graph + active-attempt primitives shared by
// `forge orchestrate phases --ready` and `forge orchestrate dashboard`.
//
// Extracted from phases.ts (FORGE-90) so both verbs share ONE active-attempt
// scanner + done-set logic. The readiness POLICY differs between the verbs and
// deliberately lives in each verb, NOT here:
//   - `phases --ready` surfaces dep-satisfied candidates INCLUDING in-flight
//     ones (annotated with overlap classification).
//   - `dashboard` splits ready vs blocked and EXCLUDES claimed tasks from ready.
// This module holds only the shared, policy-free building blocks.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Task } from '../schemas/phases.ts';
import { TaskStateSchema, type TaskState } from '../schemas/task-state.ts';
import type { TaskWriteGlobs } from './overlap.ts';

// States that count as an active claim of a task: an attempt in any of these
// states blocks a fresh claim and counts for overlap classification.
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
]);

// A phases.yaml `depends_on` entry may reference either a P<phase>-T<n> id OR a
// tracker issue id (FORGE-NN). Match by tracker_issue_id with status 'done'.
export function isTrackerIdDone(
  depId: string,
  tasks: ReadonlyArray<{ task: Task }>,
): boolean {
  for (const { task } of tasks) {
    if (task.tracker_issue_id === depId && task.status === 'done') return true;
  }
  return false;
}

// Scan .forge/orchestrator/tasks/<id>/state.json and return the write_globs of
// every task whose state is active (per ACTIVE_STATES). write_globs are looked
// up from the flattened phases.yaml task list (keyed by both phases id and
// tracker id). Tolerant: missing dir → []; unreadable / corrupt / non-active
// entries are skipped.
export function collectActiveAttempts(
  forgeDir: string,
  allTasks: ReadonlyArray<{ task: Task }>,
): TaskWriteGlobs[] {
  const tasksRoot = path.join(forgeDir, 'orchestrator', 'tasks');
  let entries: string[];
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    return [];
  }
  const out: TaskWriteGlobs[] = [];
  const globsByTaskId = new Map<string, readonly string[]>();
  for (const { task } of allTasks) {
    if (task.write_globs) globsByTaskId.set(task.id, task.write_globs);
    if (task.tracker_issue_id && task.write_globs) {
      globsByTaskId.set(task.tracker_issue_id, task.write_globs);
    }
  }
  for (const entry of entries) {
    const statePath = path.join(tasksRoot, entry, 'state.json');
    let raw: string;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = TaskStateSchema.safeParse(parsed);
    if (!result.success) continue;
    if (!ACTIVE_STATES.has(result.data.state)) continue;
    out.push({
      taskId: result.data.task_id,
      writeGlobs: globsByTaskId.get(result.data.task_id) ?? [],
    });
  }
  return out;
}
