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

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Task } from '../schemas/phases.ts';
import {
  TaskStateSchema,
  type TaskState,
  type TaskStateRecord,
} from '../schemas/task-state.ts';
import type { TaskWriteGlobs } from './overlap.ts';
import { validateIdSegment } from './questions/paths.ts';

// Per-file read cap for untrusted .forge/orchestrator files. Mirrors the cap in
// dashboard.ts / status.ts — a hostile or corrupt state.json must not be able to
// exhaust memory in a read verb.
const STATE_FILE_MAX_BYTES = 1 * 1024 * 1024;

// States that count as an active claim of a task: an attempt in any of these
// states blocks a fresh claim and counts for overlap classification.
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
  // FORGE-231: a task awaiting its platform merge is still-unmerged work — a
  // hard overlap that must block fresh claims of overlapping scope.
  'merge_pending',
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

// One scanned task: the canonical (validated) task id, its parsed state, and
// the full state.json record. The taskId is ALWAYS the validated directory
// name (not the payload's task_id) — see collectTasksByState path-safety notes.
export interface TaskStateScan {
  readonly taskId: string;
  readonly state: TaskState;
  readonly record: TaskStateRecord;
}

// Pure state-dir scanner shared by the readiness/overlap path and the
// review-queue / inbox read verbs (FORGE-185 / FORGE-195). It does NOT couple
// to phases.yaml — callers join phases metadata themselves — and does NOT bake
// in any particular state; the caller supplies a predicate.
//
// Scans <forgeDir>/orchestrator/tasks/<id>/state.json. Tolerant: missing dir →
// []. Per directory entry it skips on ANY of:
//   - directory name fails validateIdSegment (path-traversal / hostile name),
//   - state.json unreadable,
//   - state.json is not valid JSON,
//   - state.json fails TaskStateSchema,
//   - the payload's task_id disagrees with the directory name (dir/payload
//     mismatch — TaskStateSchema only checks task_id is non-empty, so we never
//     trust it as a path/identity key),
//   - predicate(state) returns false.
// The returned taskId is the validated directory name.
export function collectTasksByState(
  forgeDir: string,
  predicate: (state: TaskState) => boolean,
): TaskStateScan[] {
  const tasksRoot = path.join(forgeDir, 'orchestrator', 'tasks');
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(tasksRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TaskStateScan[] = [];
  for (const ent of entries) {
    // Only real directories. Dirent.isDirectory() is false for a symlink, so a
    // symlinked task dir (which could point outside the task tree) is skipped —
    // the scanner is exported and consumed by read verbs, so it must not be a
    // path-traversal vector.
    if (!ent.isDirectory()) continue;
    let taskId: string;
    try {
      taskId = validateIdSegment(ent.name, 'task_id');
    } catch {
      continue; // hostile / malformed dir name — skip
    }
    const statePath = path.join(tasksRoot, taskId, 'state.json');
    let raw: string;
    try {
      // lstat (not stat): reject a symlinked state.json, and cap the size before
      // reading so a giant file cannot exhaust memory.
      const st = lstatSync(statePath);
      if (!st.isFile() || st.size > STATE_FILE_MAX_BYTES) continue;
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
    // Guard against a dir/payload mismatch: the directory name is the canonical
    // id; a state.json whose task_id disagrees is corrupt/misfiled — skip it.
    if (result.data.task_id !== taskId) continue;
    if (!predicate(result.data.state)) continue;
    out.push({ taskId, state: result.data.state, record: result.data });
  }
  return out;
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
  const globsByTaskId = new Map<string, readonly string[]>();
  for (const { task } of allTasks) {
    if (task.write_globs) globsByTaskId.set(task.id, task.write_globs);
    if (task.tracker_issue_id && task.write_globs) {
      globsByTaskId.set(task.tracker_issue_id, task.write_globs);
    }
  }
  return collectTasksByState(forgeDir, (s) => ACTIVE_STATES.has(s)).map((scan) => ({
    taskId: scan.record.task_id,
    writeGlobs: globsByTaskId.get(scan.record.task_id) ?? [],
  }));
}
