// Pure diff logic for `forge orchestrate reconcile`. No I/O.
//
// --pull: tracker → phases.yaml. Reports updated/removed/added/unmanaged.
// --push: phases.yaml → tracker bodies. Reports bodies-to-write + skip reasons.
//
// Per spec/ORCHESTRATOR.md §CLI surface and team-mode minimum architecture:
// no conflict-resolution UI. The verb writes phases.yaml or calls
// updateIssueBody atomically; the skill confirms orphan prune before apply.

import type { Document, Node } from 'yaml';
import { YAMLSeq, isMap, isScalar, isSeq } from 'yaml';

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
// reconcile to phases.yaml. Deduped: depends_on is a set, and a tracker that
// reports the same blocker twice must not yield a duplicate task ID — that
// would re-diff against the deduped local list on every --pull. (Codex
// 2nd-pass.) This is the sole producer of the depends_on change.to, so the
// canonical (deduped, sorted) shape flows to every consumer.
function mapBlockerIdsToTaskIds(
  blockerIds: readonly string[],
  idx: TaskIndex,
): readonly string[] {
  const out = new Set<string>();
  for (const trackerId of blockerIds) {
    const taskId = idx.trackerIdToTaskId.get(trackerId);
    if (taskId) out.add(taskId);
  }
  return [...out].sort();
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

  // depends_on is derived from the issue's forge:task footer (blockerIds).
  // When the issue has no footer (forgeTaskId undefined), blockerIds is empty
  // by ABSENCE — not because the deps were cleared on the tracker. Diffing
  // against it would spuriously propose wiping local depends_on, so skip the
  // depends_on diff for footer-less issues. title (above) is a real
  // first-class field and is always diffed.
  const hasFooter = issue.forgeTaskId !== undefined;

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
  if (hasFooter && allLocalDepsMapToTracker) {
    const trackerDepsAsTaskIds = mapBlockerIdsToTaskIds(issue.blockerIds, idx);
    const localDeps = [...task.depends_on].sort();
    if (!sameStringArray(localDeps, trackerDepsAsTaskIds)) {
      changes.push({ field: 'depends_on', from: localDeps, to: trackerDepsAsTaskIds });
    }
  }
  return changes;
}

export function diffPull(
  issues: readonly Issue[],
  phases: Phases,
  opts: { trackerViewTruncated?: boolean } = {},
): PullPlan {
  const idx = buildTaskIndex(phases);
  const seenTrackerIds = new Set<string>();

  const updated: UpdatedTask[] = [];
  const added: AddedIssue[] = [];
  const unmanaged: UnmanagedIssue[] = [];

  for (const issue of issues) {
    // phases.yaml may bind tracker_issue_id to EITHER the tracker's internal
    // id (a UUID on Linear) OR the human identifier ("FORGE-90"). Seed both
    // namespaces so the orphan sweep below — which compares the stored
    // tracker_issue_id key — recognizes this issue as seen regardless of which
    // form the local task recorded. Seeding the unmatched case too is
    // harmless: nothing in byTrackerId will key on it.
    seenTrackerIds.add(issue.id);
    seenTrackerIds.add(issue.identifier);

    // Primary match: a local task that binds this issue via tracker_issue_id.
    // Try the internal id first, then the human identifier. This explicit
    // binding wins even when the issue carries no forge:task footer — a
    // recorded tracker_issue_id is a stronger link than the footer.
    let local: { phase: Phase; task: Task } | undefined =
      idx.byTrackerId.get(issue.id) ?? idx.byTrackerId.get(issue.identifier);

    const forgeTaskId = issue.forgeTaskId;

    if (!local) {
      // The pull path fetches ALL issues (incl. done/cancelled) for
      // orphan-safety. A terminal issue with no local binding is finished work
      // that isn't actionable: don't surface it as `added` (don't propose
      // re-adding completed work to the roadmap) or `unmanaged` (noise). It's
      // already in seenTrackerIds, so suppressing it here is safe.
      const terminal = issue.state === 'done' || issue.state === 'cancelled';

      // No tracker_issue_id binding. Fall back to the forge:task footer.
      if (forgeTaskId === undefined) {
        // No binding and no footer → created/edited outside forge.
        if (!terminal) {
          unmanaged.push({
            tracker_issue_id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
          });
        }
        continue;
      }
      // Match by footer ONLY if the local task has no tracker_issue_id yet
      // (e.g. the issue was created via `forge orchestrate` outside this yaml's
      // lifetime and the back-link hasn't been recorded). Per Codex 2nd-pass
      // review: if the local task already binds a *different* tracker_issue_id,
      // a duplicate or adversarial issue carrying the same forge:task footer
      // must NOT attribute updates back to that local task — it's an unmanaged
      // collision, not a match.
      const byTaskId = idx.byTaskId.get(forgeTaskId);
      if (byTaskId && byTaskId.task.tracker_issue_id === undefined) {
        local = byTaskId;
      } else if (byTaskId) {
        if (!terminal) {
          unmanaged.push({
            tracker_issue_id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
          });
        }
        continue;
      } else {
        // Footer present but no matching local task → genuinely new on tracker.
        if (!terminal) {
          added.push({
            tracker_issue_id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            forge_task_id: forgeTaskId,
          });
        }
        continue;
      }
    }

    const changes = diffTaskAgainstIssue(local.task, issue, idx);
    if (changes.length > 0) {
      updated.push({
        task_id: local.task.id,
        tracker_issue_id: local.task.tracker_issue_id ?? issue.id,
        changes,
      });
    }
  }

  // Orphan detection requires a COMPLETE tracker view: a task is only "removed"
  // when its issue is genuinely absent. If the adapter truncated the issue list
  // (page/limit cap hit), an absent issue may simply be off-page — pruning it
  // would be a false positive. Fail closed: skip orphan detection entirely.
  // (FORGE-165 Bug 2 / Codex 2nd-pass block — prune only from a full view.)
  const removed: RemovedTask[] = [];
  if (!opts.trackerViewTruncated) {
    for (const [trackerId, entry] of idx.byTrackerId) {
      if (!seenTrackerIds.has(trackerId)) {
        removed.push({ task_id: entry.task.id, tracker_issue_id: trackerId });
      }
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
          const next = change.to as readonly string[];
          const nextSet = new Set(next);
          const existing = taskNode.get('depends_on', true);
          if (isSeq(existing)) {
            // Edit the existing sequence in place so its collection style
            // (block vs flow) and any inline comments on retained items
            // survive. Rebuilding a fresh flow YAMLSeq destroyed both.
            // (FORGE-121.)
            const kept = new Set<string>();
            const removeAt: number[] = [];
            for (let di = 0; di < existing.items.length; di++) {
              const item = existing.items[di] as Node;
              const val = isScalar(item) ? item.value : undefined;
              const dep = typeof val === 'string' ? val : undefined;
              // Keep the FIRST occurrence of each wanted dep (so its inline
              // comment survives); drop unwanted deps AND any duplicate
              // occurrences. Collapsing duplicates keeps the result a faithful
              // set so the next --pull doesn't re-diff. (Codex 2nd-pass BLOCK.)
              if (dep !== undefined && nextSet.has(dep) && !kept.has(dep)) {
                kept.add(dep);
                continue;
              }
              // Refuse to splice a YAML-anchored item: an alias elsewhere
              // would dangle on serialize, exactly like the task-prune guard
              // above. (Codex 2nd-pass.)
              if (hasYamlAnchor(item)) {
                throw new Error(
                  `applyPlanToDocument: refusing to drop depends_on item '${String(dep)}' on task '${id}' — its node has a YAML anchor; aliases elsewhere in the document would dangle. Resolve the anchor manually before re-running --pull.`,
                );
              }
              removeAt.push(di);
            }
            // Splice in reverse so earlier indices stay valid.
            for (let k = removeAt.length - 1; k >= 0; k--) {
              existing.items.splice(removeAt[k], 1);
            }
            for (const dep of next) {
              if (!kept.has(dep)) existing.add(dep);
            }
          } else {
            // No existing sequence node (null/absent) — create one in the
            // forge default flow style.
            const seq = new YAMLSeq();
            seq.flow = true;
            for (const dep of next) seq.add(dep);
            taskNode.set('depends_on', seq);
          }
          mutations++;
        }
      }
    }
  }

  return mutations;
}

// ---- staged additions (used by `forge orchestrate amend-roadmap`) ---------
//
// The pull diff intentionally never materializes `added[]` issues (it lacks
// the description/type/priority/estimate/acceptance a TaskSchema task needs).
// /amend-roadmap KNOWS the full task — it authored the tracker issue — so it
// stages the complete task and the pull path inserts it here, keeping
// applyPlanToDocument + this function the only writers of phases.yaml.

export interface StagedAddition {
  readonly phaseId: string;
  readonly task: Task;
}

// Insert `task` into the tasks sequence of `phaseId`, preserving comments and
// house style (flow-style depends_on; acceptance stays block — matches the
// emitter conventions used across the live phases.yaml). Idempotent: returns
// false when a task with the same id already exists anywhere in the document
// (a resumed amend re-running the pull step must not duplicate). Throws when
// the phase is missing or malformed — the caller surfaces that as a staged-
// addition failure WITHOUT writing the file.
export function insertTaskIntoDocument(
  doc: Document,
  phaseId: string,
  task: Task,
): boolean {
  const phasesSeq = doc.get('phases');
  if (!isSeq(phasesSeq)) {
    throw new Error('insertTaskIntoDocument: phases.yaml has no phases sequence');
  }

  // Global idempotency sweep first: the id must not exist in ANY phase.
  for (const phaseNode of phasesSeq.items) {
    if (!isMap(phaseNode)) continue;
    const tasksNode = phaseNode.get('tasks');
    if (!isSeq(tasksNode)) continue;
    for (const taskNode of tasksNode.items) {
      if (isMap(taskNode) && taskNode.get('id') === task.id) return false;
    }
  }

  for (const phaseNode of phasesSeq.items) {
    if (!isMap(phaseNode)) continue;
    if (phaseNode.get('id') !== phaseId) continue;
    const tasksNode = phaseNode.get('tasks');
    if (!isSeq(tasksNode)) {
      throw new Error(
        `insertTaskIntoDocument: phase '${phaseId}' has no tasks sequence`,
      );
    }
    // Build the node from a plain shape with only-defined fields so the YAML
    // output carries no `null`s for absent optionals.
    const shape: Record<string, unknown> = {
      id: task.id,
      ...(task.tracker_issue_id ? { tracker_issue_id: task.tracker_issue_id } : {}),
      title: task.title,
      description: task.description,
      type: task.type,
      priority: task.priority,
      depends_on: [...task.depends_on],
      estimate: task.estimate,
      owner_type: task.owner_type,
      acceptance: [...task.acceptance],
      ...(task.write_globs ? { write_globs: [...task.write_globs] } : {}),
    };
    const node = doc.createNode(shape);
    if (isMap(node)) {
      // depends_on renders flow-style (`[P1-T01, P1-T02]`) to match the file's
      // existing convention; acceptance stays block style.
      const deps = node.get('depends_on', true);
      if (isSeq(deps)) deps.flow = true;
    }
    tasksNode.add(node);
    return true;
  }

  throw new Error(`insertTaskIntoDocument: phase '${phaseId}' not found in phases.yaml`);
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
