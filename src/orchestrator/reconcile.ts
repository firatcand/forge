// Pure diff logic for `forge orchestrate reconcile`. No I/O.
//
// --pull: tracker → phases.yaml. Reports updated/removed/added/unmanaged.
// --push: phases.yaml → tracker bodies. Reports bodies-to-write + skip reasons.
//
// Per spec/ORCHESTRATOR.md §CLI surface and team-mode minimum architecture:
// no conflict-resolution UI. The verb writes phases.yaml or calls
// updateIssueBody atomically; the skill confirms orphan prune before apply.

import type { Document, Node } from 'yaml';
import { YAMLSeq, isMap, isSeq } from 'yaml';

// A YAML node has an anchor when its source had `&name` syntax. yaml v2 stores
// it on `node.anchor`. We can't safely splice the node out of its parent
// sequence because any `*name` alias elsewhere in the document would become a
// dangling reference on serialize.
function hasYamlAnchor(node: Node): boolean {
  return typeof (node as { anchor?: unknown }).anchor === 'string';
}
import type { Issue } from '../trackers/types.ts';
import type { Phase, Phases, Task } from '../schemas/phases.ts';

export interface FieldChange {
  readonly field: 'title' | 'depends_on';
  readonly from: string | readonly string[];
  readonly to: string | readonly string[];
}

export interface UpdatedTask {
  readonly task_id: string;
  readonly tracker_issue_id: string;
  readonly changes: readonly FieldChange[];
}

export interface RemovedTask {
  readonly task_id: string;
  readonly tracker_issue_id: string;
}

export interface AddedIssue {
  readonly tracker_issue_id: string;
  readonly identifier: string;
  readonly title: string;
  readonly forge_task_id: string;
}

export interface UnmanagedIssue {
  readonly tracker_issue_id: string;
  readonly identifier: string;
  readonly title: string;
}

export interface PullPlan {
  readonly updated: readonly UpdatedTask[];
  readonly removed: readonly RemovedTask[];
  readonly added: readonly AddedIssue[];
  readonly unmanaged: readonly UnmanagedIssue[];
}

export interface PushBody {
  readonly tracker_issue_id: string;
  readonly task_id: string;
  readonly body: string;
}

export interface PushSkip {
  readonly task_id: string;
  readonly reason: 'no_tracker_issue_id' | 'orphan_in_phases';
}

export interface PushPlan {
  readonly bodies: readonly PushBody[];
  readonly skipped: readonly PushSkip[];
}

// Index for cross-namespace mapping. tracker_issue_id ↔ task.id.
interface TaskIndex {
  readonly byTrackerId: ReadonlyMap<string, { phase: Phase; task: Task }>;
  readonly byTaskId: ReadonlyMap<string, { phase: Phase; task: Task }>;
  readonly trackerIdToTaskId: ReadonlyMap<string, string>;
}

function buildTaskIndex(phases: Phases): TaskIndex {
  const byTrackerId = new Map<string, { phase: Phase; task: Task }>();
  const byTaskId = new Map<string, { phase: Phase; task: Task }>();
  const trackerIdToTaskId = new Map<string, string>();
  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      byTaskId.set(task.id, { phase, task });
      if (task.tracker_issue_id) {
        byTrackerId.set(task.tracker_issue_id, { phase, task });
        trackerIdToTaskId.set(task.tracker_issue_id, task.id);
      }
    }
  }
  return { byTrackerId, byTaskId, trackerIdToTaskId };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Map tracker.blockerIds (tracker IDs) → task.depends_on (task IDs) via the
// tracker_issue_id index. Tracker blockers that don't map to a known task ID
// are dropped silently — they represent orphan/unmanaged blockers we can't
// reconcile to phases.yaml.
function mapBlockerIdsToTaskIds(
  blockerIds: readonly string[],
  idx: TaskIndex,
): readonly string[] {
  const out: string[] = [];
  for (const trackerId of blockerIds) {
    const taskId = idx.trackerIdToTaskId.get(trackerId);
    if (taskId) out.push(taskId);
  }
  return out.sort();
}

function diffTaskAgainstIssue(
  task: Task,
  issue: Issue,
  idx: TaskIndex,
): readonly FieldChange[] {
  const changes: FieldChange[] = [];
  if (task.title !== issue.title) {
    changes.push({ field: 'title', from: task.title, to: issue.title });
  }

  // depends_on diff is only meaningful when EVERY local dep can be
  // represented on the tracker side (i.e. every local dep maps to a
  // tracker_issue_id). If any local dep is "local-only" (a phases.yaml task
  // with no tracker_issue_id), the tracker can never carry it as a
  // blockerId, so comparing the full local list against the mapped tracker
  // list would always show a spurious diff and silently overwrite the
  // local-only dep on --pull. Bail out of the depends_on diff for those
  // tasks — local-only deps stay local.
  const allLocalDepsMapToTracker = task.depends_on.every((depTaskId) => {
    const entry = idx.byTaskId.get(depTaskId);
    return entry !== undefined && entry.task.tracker_issue_id !== undefined;
  });
  if (allLocalDepsMapToTracker) {
    const trackerDepsAsTaskIds = mapBlockerIdsToTaskIds(issue.blockerIds, idx);
    const localDeps = [...task.depends_on].sort();
    if (!sameStringArray(localDeps, trackerDepsAsTaskIds)) {
      changes.push({ field: 'depends_on', from: localDeps, to: trackerDepsAsTaskIds });
    }
  }
  return changes;
}

export function diffPull(issues: readonly Issue[], phases: Phases): PullPlan {
  const idx = buildTaskIndex(phases);
  const seenTrackerIds = new Set<string>();

  const updated: UpdatedTask[] = [];
  const added: AddedIssue[] = [];
  const unmanaged: UnmanagedIssue[] = [];

  for (const issue of issues) {
    seenTrackerIds.add(issue.id);
    if (!issue.forgeTaskId) {
      unmanaged.push({
        tracker_issue_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      });
      continue;
    }
    // Match by tracker_issue_id first. Fall back to forgeTaskId footer ONLY
    // if the local task has no tracker_issue_id yet (e.g. the issue was
    // created via `forge orchestrate` outside this yaml's lifetime and the
    // back-link hasn't been recorded). Per Codex 2nd-pass review: if the
    // local task already binds a *different* tracker_issue_id, a duplicate
    // or adversarial issue carrying the same forge:task footer must NOT
    // attribute updates back to that local task — it's an unmanaged
    // collision, not a match.
    const byTrackerId = idx.byTrackerId.get(issue.id);
    let local: { phase: Phase; task: Task } | undefined = byTrackerId;
    if (!local) {
      const byTaskId = idx.byTaskId.get(issue.forgeTaskId);
      if (byTaskId && byTaskId.task.tracker_issue_id === undefined) {
        local = byTaskId;
      } else if (byTaskId) {
        // Local task already binds a different tracker_issue_id — this
        // incoming issue is a duplicate-footer collision. Surface as
        // unmanaged so the user can investigate; do NOT silently apply.
        unmanaged.push({
          tracker_issue_id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
        });
        continue;
      }
    }
    if (!local) {
      added.push({
        tracker_issue_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        forge_task_id: issue.forgeTaskId,
      });
      continue;
    }
    const changes = diffTaskAgainstIssue(local.task, issue, idx);
    if (changes.length > 0) {
      updated.push({
        task_id: local.task.id,
        tracker_issue_id: issue.id,
        changes,
      });
    }
  }

  const removed: RemovedTask[] = [];
  for (const [trackerId, entry] of idx.byTrackerId) {
    if (!seenTrackerIds.has(trackerId)) {
      removed.push({ task_id: entry.task.id, tracker_issue_id: trackerId });
    }
  }

  return { updated, removed, added, unmanaged };
}

// Render the markdown body for a task. Mirrors the metadata-header + body +
// acceptance shape used by live tracker issues so --push doesn't regress
// readability. The caller-provided body content is wrapped — adapters add the
// trailing forge:task footer themselves.
export function renderTaskBody(task: Task, phase: Phase): string {
  const lines: string[] = [];
  lines.push(`**Forge task ID:** ${task.id}`);
  const meta: string[] = [
    `**Phase:** ${phase.id}${phase.name ? ` — ${phase.name}` : ''}`,
    `**Type:** ${task.type}`,
    `**Owner:** ${task.owner_type}`,
    `**Priority:** ${task.priority}`,
    `**Estimate:** ${task.estimate}`,
  ];
  lines.push(meta.join(' · '));
  if (task.depends_on.length > 0) {
    lines.push(`**Depends on:** ${task.depends_on.join(', ')}`);
  }
  lines.push('');
  lines.push(task.description);
  lines.push('');
  lines.push('## Acceptance');
  for (const ac of task.acceptance) {
    lines.push(`- [ ] ${ac}`);
  }
  return lines.join('\n');
}

export function diffPush(phases: Phases, issues: readonly Issue[]): PushPlan {
  const issueById = new Map<string, Issue>();
  for (const i of issues) issueById.set(i.id, i);

  const bodies: PushBody[] = [];
  const skipped: PushSkip[] = [];

  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      if (!task.tracker_issue_id) {
        skipped.push({ task_id: task.id, reason: 'no_tracker_issue_id' });
        continue;
      }
      const issue = issueById.get(task.tracker_issue_id);
      if (!issue) {
        skipped.push({ task_id: task.id, reason: 'orphan_in_phases' });
        continue;
      }
      bodies.push({
        tracker_issue_id: task.tracker_issue_id,
        task_id: task.id,
        body: renderTaskBody(task, phase),
      });
    }
  }

  return { bodies, skipped };
}

// ---- phases.yaml mutation (used by --pull apply step) ---------------------
//
// applyPullToPhases is a pure function over the in-memory Phases shape: it
// returns a new Phases with `updated[]` applied to titles + depends_on, and
// `removed[]` pruned. `added[]` issues are NOT auto-inserted — phases.yaml
// only gets new tasks via /amend-roadmap (deferred v0.5). New tracker issues
// surface as informational data to the user.
//
// Caller is responsible for serializing the result back to YAML with unknown
// top-level keys preserved (use yaml.parseDocument).

export interface ApplyOptions {
  readonly confirmPrune: boolean;
}

// Mutates a yaml Document in place so comments + ordering are preserved.
// The Document is expected to validate against PhasesSchema (caller's
// responsibility). Returns the count of structural mutations applied so the
// caller can decide whether to write the file.
//
// WHY: re-stringifying from the parsed `Phases` shape via yaml.stringify
// strips ~100 comment lines from the live forge phases.yaml. Per
// [[validator-narrower-than-preserver-causes-silent-corruption]] we navigate
// the Document API instead.
//
// `plan.added[]` is intentionally NOT applied here. Tracker issues that
// don't yet exist in phases.yaml are surfaced to the user as informational;
// formalizing them into phases.yaml is the job of /amend-roadmap (deferred
// v0.5). Same contract as applyPullToPhases.
export function applyPlanToDocument(
  doc: Document,
  plan: PullPlan,
  opts: ApplyOptions,
): number {
  let mutations = 0;
  const phasesSeq = doc.get('phases');
  if (!isSeq(phasesSeq)) return 0;

  const updatedByTaskId = new Map(plan.updated.map((u) => [u.task_id, u]));
  const removedTaskIds = opts.confirmPrune
    ? new Set(plan.removed.map((r) => r.task_id))
    : new Set<string>();

  for (let pi = 0; pi < phasesSeq.items.length; pi++) {
    const phaseNode = phasesSeq.items[pi];
    if (!isMap(phaseNode)) continue;
    const tasksNode = phaseNode.get('tasks');
    if (!isSeq(tasksNode)) continue;

    // Iterate backwards so splices don't shift remaining indices.
    for (let ti = tasksNode.items.length - 1; ti >= 0; ti--) {
      const taskNode = tasksNode.items[ti];
      if (!isMap(taskNode)) continue;
      const idScalar = taskNode.get('id');
      const id = typeof idScalar === 'string' ? idScalar : null;
      if (!id) continue;

      if (removedTaskIds.has(id)) {
        // Safety: refuse to splice a YAML-anchored node. yaml v2's Document
        // does not re-resolve aliases on toString() after a splice, so any
        // remaining alias would surface as "Unresolved alias" on serialize.
        // forge-emitted phases.yaml never uses anchors, but a hand-edited
        // file might. Throw early with a clear message rather than corrupt
        // the file. (Codex/Claude 2nd-pass BLOCK.)
        if (hasYamlAnchor(taskNode)) {
          throw new Error(
            `applyPlanToDocument: refusing to prune task '${id}' — its node has a YAML anchor; aliases elsewhere in the document would dangle. Resolve the anchor manually before re-running --pull --confirm-prune.`,
          );
        }
        tasksNode.items.splice(ti, 1);
        mutations++;
        continue;
      }

      const update = updatedByTaskId.get(id);
      if (!update) continue;

      for (const change of update.changes) {
        if (change.field === 'title') {
          taskNode.set('title', String(change.to));
          mutations++;
        } else if (change.field === 'depends_on') {
          const seq = new YAMLSeq();
          seq.flow = true;
          for (const dep of change.to as readonly string[]) {
            seq.add(dep);
          }
          taskNode.set('depends_on', seq);
          mutations++;
        }
      }
    }
  }

  return mutations;
}

export function applyPullToPhases(
  phases: Phases,
  plan: PullPlan,
  opts: ApplyOptions,
): Phases {
  const updatedByTaskId = new Map(plan.updated.map((u) => [u.task_id, u]));
  const removedTaskIds = opts.confirmPrune
    ? new Set(plan.removed.map((r) => r.task_id))
    : new Set<string>();

  const nextPhases = phases.phases.map((phase) => ({
    ...phase,
    tasks: phase.tasks
      .filter((task) => !removedTaskIds.has(task.id))
      .map((task) => {
        const update = updatedByTaskId.get(task.id);
        if (!update) return task;
        let next: Task = task;
        for (const change of update.changes) {
          if (change.field === 'title') {
            next = { ...next, title: String(change.to) };
          } else if (change.field === 'depends_on') {
            next = { ...next, depends_on: [...(change.to as readonly string[])] };
          }
        }
        return next;
      }),
  }));

  return { ...phases, phases: nextPhases };
}
