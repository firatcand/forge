import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import {
  diffPull,
  diffPush,
  applyPullToPhases,
  applyPlanToDocument,
  renderTaskBody,
} from '../../../src/orchestrator/reconcile.ts';
import type { Phase, Phases, Task } from '../../../src/schemas/phases.ts';
import type { Issue, IssueState } from '../../../src/trackers/types.ts';

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'P1-T01',
    title: 'Task one',
    description: 'Does something.',
    type: 'foundation',
    priority: 'P0',
    depends_on: [],
    estimate: 'S',
    owner_type: 'backend-dev',
    acceptance: ['It works.'],
    ...overrides,
  };
}

function mkPhases(tasks: Task[]): Phases {
  const phase: Phase = {
    id: 'phase-1',
    name: 'Phase 1',
    status: 'active',
    goal: 'g',
    gate_criteria: ['g1'],
    tasks,
  };
  return { project: 'forge', phases: [phase] };
}

function mkIssue(overrides: Partial<Issue> = {}): Issue {
  const state: IssueState = 'todo';
  return {
    id: 'tracker-1',
    identifier: 'FORGE-1',
    title: 'Task one',
    state,
    blockerIds: [],
    ...overrides,
  };
}

// ---------------- diffPull ----------------

test('diffPull — empty on both sides yields no changes', () => {
  const plan = diffPull([], mkPhases([]));
  assert.equal(plan.updated.length, 0);
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.added.length, 0);
  assert.equal(plan.unmanaged.length, 0);
});

test('diffPull — matched task, same title + deps → no changes', () => {
  const task = mkTask({ tracker_issue_id: 'tracker-1', title: 'Same' });
  const issue = mkIssue({ id: 'tracker-1', title: 'Same', forgeTaskId: 'P1-T01' });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.updated.length, 0);
});

test('diffPull — title diff produces updated entry', () => {
  const task = mkTask({ tracker_issue_id: 'tracker-1', title: 'Local title' });
  const issue = mkIssue({ id: 'tracker-1', title: 'Tracker title', forgeTaskId: 'P1-T01' });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0]!.task_id, 'P1-T01');
  assert.equal(plan.updated[0]!.changes.length, 1);
  assert.equal(plan.updated[0]!.changes[0]!.field, 'title');
  assert.equal(plan.updated[0]!.changes[0]!.from, 'Local title');
  assert.equal(plan.updated[0]!.changes[0]!.to, 'Tracker title');
});

test('diffPull — depends_on diff maps tracker blockerIds back to task IDs', () => {
  const blocker = mkTask({ id: 'P1-T01', tracker_issue_id: 'tracker-1' });
  const child = mkTask({
    id: 'P1-T02',
    tracker_issue_id: 'tracker-2',
    title: 'Child',
    depends_on: [],
  });
  const blockerIssue = mkIssue({ id: 'tracker-1', forgeTaskId: 'P1-T01' });
  const childIssue = mkIssue({
    id: 'tracker-2',
    forgeTaskId: 'P1-T02',
    title: 'Child',
    blockerIds: ['tracker-1'],
  });
  const plan = diffPull([blockerIssue, childIssue], mkPhases([blocker, child]));
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0]!.task_id, 'P1-T02');
  assert.equal(plan.updated[0]!.changes[0]!.field, 'depends_on');
  assert.deepEqual(plan.updated[0]!.changes[0]!.from, []);
  assert.deepEqual(plan.updated[0]!.changes[0]!.to, ['P1-T01']);
});

test('diffPull — tracker issue without forgeTaskId is reported as unmanaged', () => {
  const issue = mkIssue({ id: 'tracker-9', identifier: 'FORGE-99', forgeTaskId: undefined });
  const plan = diffPull([issue], mkPhases([]));
  assert.equal(plan.unmanaged.length, 1);
  assert.equal(plan.unmanaged[0]!.tracker_issue_id, 'tracker-9');
  assert.equal(plan.added.length, 0);
  assert.equal(plan.updated.length, 0);
});

test('diffPull — tracker issue with forgeTaskId but no matching task is "added"', () => {
  const issue = mkIssue({
    id: 'tracker-99',
    identifier: 'FORGE-99',
    title: 'Brand new',
    forgeTaskId: 'P9-T99',
  });
  const plan = diffPull([issue], mkPhases([]));
  assert.equal(plan.added.length, 1);
  assert.equal(plan.added[0]!.forge_task_id, 'P9-T99');
  assert.equal(plan.added[0]!.title, 'Brand new');
});

test('diffPull — phases.yaml task with no matching tracker issue is "removed"', () => {
  const orphan = mkTask({ tracker_issue_id: 'tracker-gone' });
  const plan = diffPull([], mkPhases([orphan]));
  assert.equal(plan.removed.length, 1);
  assert.equal(plan.removed[0]!.task_id, 'P1-T01');
  assert.equal(plan.removed[0]!.tracker_issue_id, 'tracker-gone');
});

test('diffPull — task without tracker_issue_id is not counted as removed', () => {
  const local = mkTask({ tracker_issue_id: undefined });
  const plan = diffPull([], mkPhases([local]));
  assert.equal(plan.removed.length, 0);
});

test('diffPull — depends_on order-independence (sorted comparison)', () => {
  const blockerA = mkTask({ id: 'P1-T01', tracker_issue_id: 'tA' });
  const blockerB = mkTask({ id: 'P1-T02', tracker_issue_id: 'tB' });
  const child = mkTask({
    id: 'P1-T03',
    tracker_issue_id: 'tC',
    title: 'Child',
    depends_on: ['P1-T01', 'P1-T02'],
  });
  // Tracker returns blockers in reverse order — should not flag a diff.
  const issueA = mkIssue({ id: 'tA', forgeTaskId: 'P1-T01' });
  const issueB = mkIssue({ id: 'tB', forgeTaskId: 'P1-T02' });
  const issueC = mkIssue({
    id: 'tC',
    forgeTaskId: 'P1-T03',
    title: 'Child',
    blockerIds: ['tB', 'tA'],
  });
  const plan = diffPull([issueA, issueB, issueC], mkPhases([blockerA, blockerB, child]));
  assert.equal(plan.updated.length, 0);
});

test('diffPull — tracker blockerId pointing to unknown task is dropped from diff', () => {
  const local = mkTask({ tracker_issue_id: 't1', depends_on: [] });
  const issue = mkIssue({ id: 't1', forgeTaskId: 'P1-T01', blockerIds: ['t-unknown'] });
  const plan = diffPull([issue], mkPhases([local]));
  assert.equal(plan.updated.length, 0);
});

test('diffPull — local-only depends_on (dep without tracker_issue_id) does NOT trigger a depends_on diff', () => {
  // Regression for code-review BLOCK #3: a local task with depends_on
  // [P1-T01, P1-T02] where P1-T02 has no tracker_issue_id can never be
  // represented on the tracker side. The previous implementation produced
  // a spurious diff and would have overwritten depends_on to [P1-T01],
  // silently dropping the local-only P1-T02.
  //
  // Per Codex 2nd-pass: the assertion is SCOPED to "no depends_on change for
  // P1-T03" — earlier version asserted `childUpdate === undefined` which
  // would mask the regression if a future change introduced an unrelated
  // title/etc diff for the same task.
  const localOnlyDep = mkTask({
    id: 'P1-T02',
    tracker_issue_id: undefined,
    title: 'Local-only blocker',
  });
  const blocker = mkTask({ id: 'P1-T01', tracker_issue_id: 't-1' });
  const child = mkTask({
    id: 'P1-T03',
    tracker_issue_id: 't-3',
    title: 'Child',
    depends_on: ['P1-T01', 'P1-T02'],
  });
  const blockerIssue = mkIssue({ id: 't-1', forgeTaskId: 'P1-T01' });
  const childIssue = mkIssue({
    id: 't-3',
    forgeTaskId: 'P1-T03',
    title: 'Child',
    blockerIds: ['t-1'],
  });
  const plan = diffPull(
    [blockerIssue, childIssue],
    mkPhases([blocker, localOnlyDep, child]),
  );
  const childUpdate = plan.updated.find((u) => u.task_id === 'P1-T03');
  const dependsChange = childUpdate?.changes.find((c) => c.field === 'depends_on');
  assert.equal(
    dependsChange,
    undefined,
    'expected no depends_on diff because P1-T02 is local-only (no tracker_issue_id)',
  );
});

test('diffPull — duplicate forgeTaskId footer on a different tracker issue does NOT attribute updates', () => {
  // Regression for Codex 2nd-pass BLOCK (confidence 9): a malicious or
  // duplicate tracker issue carrying a `<!-- forge:task=P1-T01 -->` footer
  // when the local P1-T01 already binds a different tracker_issue_id used
  // to fall back via `byTaskId` and silently apply the duplicate issue's
  // title/deps to the local task. Now: the collision is reported as
  // unmanaged, not applied.
  const local = mkTask({ id: 'P1-T01', tracker_issue_id: 't-real', title: 'Real' });
  const realIssue = mkIssue({ id: 't-real', forgeTaskId: 'P1-T01', title: 'Real' });
  const evilIssue = mkIssue({
    id: 't-evil',
    identifier: 'F-EVIL',
    forgeTaskId: 'P1-T01',
    title: 'Hijacked title',
  });
  const plan = diffPull([realIssue, evilIssue], mkPhases([local]));
  // No update — t-real matches by id, t-evil is treated as unmanaged
  // collision rather than re-attributed to P1-T01 via forgeTaskId fallback.
  assert.equal(plan.updated.length, 0);
  const unmanaged = plan.unmanaged.find((u) => u.tracker_issue_id === 't-evil');
  assert.ok(unmanaged, 'evil duplicate-footer issue should surface as unmanaged');
});

test('diffPull — forgeTaskId fallback DOES match when local task has no tracker_issue_id yet', () => {
  // The fallback is preserved for the legitimate case: a tracker issue
  // exists with a forge footer pointing at a local task whose
  // tracker_issue_id hasn't been recorded (yet). Without this case, the
  // first sync after `forge orchestrate` issue creation would be a no-op.
  const local = mkTask({ id: 'P1-T01', tracker_issue_id: undefined, title: 'Local' });
  const issue = mkIssue({
    id: 't-new',
    forgeTaskId: 'P1-T01',
    title: 'Tracker title',
  });
  const plan = diffPull([issue], mkPhases([local]));
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0]!.task_id, 'P1-T01');
});

// ----- diffPull: FORGE-165 identifier/UUID match resilience -----

test('diffPull — FORGE-165: identifier-keyed tracker_issue_id matches a footer-less issue (no false orphan/unmanaged)', () => {
  // Linear's listActiveIssues returns id=UUID, identifier="FORGE-90", and —
  // for issues created/edited outside forge — NO forge:task footer. phases.yaml
  // stores the human identifier. The matcher must bind them. Previously this
  // flagged the task as a prunable orphan AND the issue as unmanaged.
  const task = mkTask({ tracker_issue_id: 'FORGE-90', title: 'Same' });
  const issue = mkIssue({
    id: 'uuid-eb15e290',
    identifier: 'FORGE-90',
    title: 'Same',
    forgeTaskId: undefined,
  });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.removed.length, 0, 'identifier match must not orphan the task');
  assert.equal(plan.unmanaged.length, 0, 'identifier match must not flag the issue unmanaged');
  assert.equal(plan.updated.length, 0);
  assert.equal(plan.added.length, 0);
});

test('diffPull — FORGE-165: identifier-keyed match still diffs title', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-90', title: 'Local title' });
  const issue = mkIssue({
    id: 'uuid-1',
    identifier: 'FORGE-90',
    title: 'Tracker title',
    forgeTaskId: undefined,
  });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0]!.changes[0]!.field, 'title');
  // Report the locally-stored tracker_issue_id, not the issue's UUID.
  assert.equal(plan.updated[0]!.tracker_issue_id, 'FORGE-90');
});

test('diffPull — FORGE-165: footer-less matched issue does NOT propose wiping depends_on', () => {
  // blockerIds are footer-derived, so a footer-less issue has blockerIds:[] by
  // ABSENCE. After matching by identifier, the depends_on diff must be skipped
  // so local deps are not proposed for deletion on --pull.
  const blocker = mkTask({ id: 'P1-T01', tracker_issue_id: 'FORGE-1' });
  const child = mkTask({
    id: 'P1-T02',
    tracker_issue_id: 'FORGE-2',
    title: 'Child',
    depends_on: ['P1-T01'],
  });
  const blockerIssue = mkIssue({ id: 'u1', identifier: 'FORGE-1', forgeTaskId: undefined });
  const childIssue = mkIssue({
    id: 'u2',
    identifier: 'FORGE-2',
    title: 'Child',
    forgeTaskId: undefined,
    blockerIds: [],
  });
  const plan = diffPull([blockerIssue, childIssue], mkPhases([blocker, child]));
  const childUpdate = plan.updated.find((u) => u.task_id === 'P1-T02');
  const dependsChange = childUpdate?.changes.find((c) => c.field === 'depends_on');
  assert.equal(dependsChange, undefined, 'footer-less issue must not propose wiping depends_on');
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.unmanaged.length, 0);
});

test('diffPull — FORGE-165: whole identifier-keyed board, nothing changed → clean no-op', () => {
  // The exact production failure mode: every task binds a human identifier and
  // every live issue is footer-less. Must be a clean no-op, not a wholesale
  // orphan + unmanaged false-prune.
  const tasks = [
    mkTask({ id: 'P1-T01', tracker_issue_id: 'FORGE-6', title: 'A' }),
    mkTask({ id: 'P1-T02', tracker_issue_id: 'FORGE-7', title: 'B' }),
    mkTask({ id: 'P1-T03', tracker_issue_id: 'FORGE-8', title: 'C' }),
  ];
  const issues = [
    mkIssue({ id: 'u6', identifier: 'FORGE-6', title: 'A', forgeTaskId: undefined }),
    mkIssue({ id: 'u7', identifier: 'FORGE-7', title: 'B', forgeTaskId: undefined }),
    mkIssue({ id: 'u8', identifier: 'FORGE-8', title: 'C', forgeTaskId: undefined }),
  ];
  const plan = diffPull(issues, mkPhases(tasks));
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.unmanaged.length, 0);
  assert.equal(plan.updated.length, 0);
  assert.equal(plan.added.length, 0);
});

test('diffPull — FORGE-165: UUID-keyed tracker_issue_id still matches (no regression)', () => {
  const task = mkTask({ tracker_issue_id: 'uuid-1', title: 'Same' });
  const issue = mkIssue({ id: 'uuid-1', identifier: 'FORGE-50', title: 'Same', forgeTaskId: undefined });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.unmanaged.length, 0);
  assert.equal(plan.updated.length, 0);
});

test('diffPull — FORGE-165: a genuinely absent issue is still a true orphan', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-404' });
  const plan = diffPull([], mkPhases([task]));
  assert.equal(plan.removed.length, 1);
  assert.equal(plan.removed[0]!.tracker_issue_id, 'FORGE-404');
});

test('diffPull — FORGE-165: a footer-less issue bound by no local task is still unmanaged', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-6', title: 'A' });
  const matched = mkIssue({ id: 'u6', identifier: 'FORGE-6', title: 'A', forgeTaskId: undefined });
  const stranger = mkIssue({ id: 'u-x', identifier: 'FORGE-999', title: 'Outside', forgeTaskId: undefined });
  const plan = diffPull([matched, stranger], mkPhases([task]));
  assert.equal(plan.unmanaged.length, 1);
  assert.equal(plan.unmanaged[0]!.identifier, 'FORGE-999');
  assert.equal(plan.removed.length, 0);
});

// ----- diffPull: FORGE-165 Bug 2 — Done/Cancelled issues are not false orphans -----
// reconcile --pull now feeds diffPull the FULL issue set (listAllIssues incl.
// terminal). These lock in that terminal issues keep their bound tasks present
// without adding roadmap noise.

test('diffPull — Bug2: a task bound to a Done issue is NOT orphaned', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-6', title: 'Bootstrap' });
  const doneIssue = mkIssue({
    id: 'u6',
    identifier: 'FORGE-6',
    title: 'Bootstrap',
    state: 'done',
    forgeTaskId: undefined,
  });
  const plan = diffPull([doneIssue], mkPhases([task]));
  assert.equal(plan.removed.length, 0, 'Done-bound task must not be orphaned');
  assert.equal(plan.unmanaged.length, 0);
  assert.equal(plan.updated.length, 0);
});

test('diffPull — Bug2: a cancelled-bound task is NOT orphaned', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-9', title: 'Dropped' });
  const issue = mkIssue({
    id: 'u9',
    identifier: 'FORGE-9',
    title: 'Dropped',
    state: 'cancelled',
    forgeTaskId: undefined,
  });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.removed.length, 0);
});

test('diffPull — Bug2: a terminal issue with no local task is NOT surfaced as added/unmanaged', () => {
  const doneNoFooter = mkIssue({
    id: 'ux',
    identifier: 'FORGE-900',
    title: 'Old done',
    state: 'done',
    forgeTaskId: undefined,
  });
  const doneWithFooter = mkIssue({
    id: 'uy',
    identifier: 'FORGE-901',
    title: 'Old done 2',
    state: 'done',
    forgeTaskId: 'P9-T01',
  });
  const plan = diffPull([doneNoFooter, doneWithFooter], mkPhases([]));
  assert.equal(plan.unmanaged.length, 0, 'terminal footer-less issue must not be unmanaged');
  assert.equal(plan.added.length, 0, 'terminal footer-bearing issue must not be added');
  assert.equal(plan.removed.length, 0);
});

test('diffPull — Bug2: a Done issue still syncs a title change to its bound task', () => {
  const task = mkTask({ tracker_issue_id: 'FORGE-6', title: 'Old' });
  const issue = mkIssue({
    id: 'u6',
    identifier: 'FORGE-6',
    title: 'New',
    state: 'done',
    forgeTaskId: undefined,
  });
  const plan = diffPull([issue], mkPhases([task]));
  assert.equal(plan.updated.length, 1);
  assert.equal(plan.updated[0]!.changes[0]!.field, 'title');
});

test('diffPull — Bug2: a truncated tracker view skips orphan detection (fail closed)', () => {
  // Codex 2nd-pass block: if listAllIssues hit its page cap, an absent issue
  // may simply be off-page, not deleted. Never prune from an incomplete view.
  const orphan = mkTask({ tracker_issue_id: 'FORGE-404' });
  const plan = diffPull([], mkPhases([orphan]), { trackerViewTruncated: true });
  assert.equal(plan.removed.length, 0, 'truncated view must not prune orphans');
});

test('diffPull — a complete view still detects the true orphan', () => {
  const orphan = mkTask({ tracker_issue_id: 'FORGE-404' });
  const plan = diffPull([], mkPhases([orphan]), { trackerViewTruncated: false });
  assert.equal(plan.removed.length, 1);
});

// ---------------- diffPush ----------------

test('diffPush — task without tracker_issue_id is skipped', () => {
  const local = mkTask({ tracker_issue_id: undefined });
  const plan = diffPush(mkPhases([local]), []);
  assert.equal(plan.bodies.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.reason, 'no_tracker_issue_id');
});

test('diffPush — task with tracker_issue_id but missing on tracker is skipped as orphan', () => {
  const local = mkTask({ tracker_issue_id: 'gone' });
  const plan = diffPush(mkPhases([local]), []);
  assert.equal(plan.bodies.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.reason, 'orphan_in_phases');
});

test('diffPush — matched task yields one body entry with rendered markdown', () => {
  const local = mkTask({ tracker_issue_id: 't1' });
  const issue = mkIssue({ id: 't1', forgeTaskId: 'P1-T01' });
  const plan = diffPush(mkPhases([local]), [issue]);
  assert.equal(plan.bodies.length, 1);
  assert.equal(plan.bodies[0]!.tracker_issue_id, 't1');
  assert.match(plan.bodies[0]!.body, /\*\*Forge task ID:\*\* P1-T01/);
  assert.match(plan.bodies[0]!.body, /## Acceptance/);
  assert.match(plan.bodies[0]!.body, /- \[ \] It works\./);
});

// ---------------- renderTaskBody ----------------

test('renderTaskBody — full task renders all metadata', () => {
  const task = mkTask({
    id: 'P2.5-T09',
    title: 'reconcile',
    description: 'desc',
    type: 'skill',
    priority: 'P0',
    estimate: 'M',
    owner_type: 'backend-dev',
    depends_on: ['P2.5-T03'],
    acceptance: ['ship it', 'tests pass'],
  });
  const phase: Phase = {
    id: 'phase-2.5',
    name: 'Closed-loop',
    status: 'active',
    goal: 'g',
    gate_criteria: ['gc'],
    tasks: [task],
  };
  const body = renderTaskBody(task, phase);
  assert.match(body, /\*\*Forge task ID:\*\* P2.5-T09/);
  assert.match(body, /\*\*Phase:\*\* phase-2\.5 — Closed-loop/);
  assert.match(body, /\*\*Type:\*\* skill/);
  assert.match(body, /\*\*Depends on:\*\* P2\.5-T03/);
  assert.match(body, /desc\n\n## Acceptance\n- \[ \] ship it\n- \[ \] tests pass/);
});

test('renderTaskBody — omits Depends on line when empty', () => {
  const task = mkTask({ depends_on: [] });
  const phase: Phase = {
    id: 'phase-1',
    name: 'P',
    status: 'active',
    goal: 'g',
    gate_criteria: ['g'],
    tasks: [task],
  };
  const body = renderTaskBody(task, phase);
  assert.equal(body.includes('Depends on'), false);
});

// ---------------- applyPullToPhases ----------------

test('applyPullToPhases — title update is applied', () => {
  const task = mkTask({ tracker_issue_id: 't1', title: 'old' });
  const phases = mkPhases([task]);
  const plan = {
    updated: [
      {
        task_id: 'P1-T01',
        tracker_issue_id: 't1',
        changes: [{ field: 'title' as const, from: 'old', to: 'new' }],
      },
    ],
    removed: [],
    added: [],
    unmanaged: [],
  };
  const next = applyPullToPhases(phases, plan, { confirmPrune: false });
  assert.equal(next.phases[0]!.tasks[0]!.title, 'new');
});

test('applyPullToPhases — depends_on update is applied', () => {
  const task = mkTask({ tracker_issue_id: 't1', depends_on: [] });
  const phases = mkPhases([task]);
  const plan = {
    updated: [
      {
        task_id: 'P1-T01',
        tracker_issue_id: 't1',
        changes: [
          { field: 'depends_on' as const, from: [] as readonly string[], to: ['P1-T00'] as readonly string[] },
        ],
      },
    ],
    removed: [],
    added: [],
    unmanaged: [],
  };
  const next = applyPullToPhases(phases, plan, { confirmPrune: false });
  assert.deepEqual(next.phases[0]!.tasks[0]!.depends_on, ['P1-T00']);
});

test('applyPullToPhases — removed task is NOT pruned without confirmPrune', () => {
  const orphan = mkTask({ id: 'P1-T01', tracker_issue_id: 't-gone' });
  const phases = mkPhases([orphan]);
  const plan = {
    updated: [],
    removed: [{ task_id: 'P1-T01', tracker_issue_id: 't-gone' }],
    added: [],
    unmanaged: [],
  };
  const next = applyPullToPhases(phases, plan, { confirmPrune: false });
  assert.equal(next.phases[0]!.tasks.length, 1);
});

test('applyPullToPhases — removed task IS pruned with confirmPrune', () => {
  const keep = mkTask({ id: 'P1-T01', tracker_issue_id: 't-keep' });
  const orphan = mkTask({ id: 'P1-T02', tracker_issue_id: 't-gone' });
  const phases = mkPhases([keep, orphan]);
  const plan = {
    updated: [],
    removed: [{ task_id: 'P1-T02', tracker_issue_id: 't-gone' }],
    added: [],
    unmanaged: [],
  };
  const next = applyPullToPhases(phases, plan, { confirmPrune: true });
  assert.equal(next.phases[0]!.tasks.length, 1);
  assert.equal(next.phases[0]!.tasks[0]!.id, 'P1-T01');
});

// ---------------- applyPlanToDocument (preserves comments) ----------------

const SAMPLE_YAML = `# top-level comment
project: forge
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      # task before
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Old title
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
      - id: P1-T02
        tracker_issue_id: tracker-gone
        title: To be pruned
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
      # task after
`;

test('applyPlanToDocument — applies title update and preserves comments', () => {
  const doc = parseDocument(SAMPLE_YAML);
  const plan = {
    updated: [
      {
        task_id: 'P1-T01',
        tracker_issue_id: 'tracker-1',
        changes: [{ field: 'title' as const, from: 'Old title', to: 'New title' }],
      },
    ],
    removed: [],
    added: [],
    unmanaged: [],
  };
  const n = applyPlanToDocument(doc, plan, { confirmPrune: false });
  assert.equal(n, 1);
  const out = doc.toString();
  assert.match(out, /# top-level comment/);
  assert.match(out, /# task before/);
  assert.match(out, /# task after/);
  assert.match(out, /title: New title/);
});

test('applyPlanToDocument — preserves the title scalar quote style on update', () => {
  // FORGE-121 regression guard. yaml v2's map.set(key, str) on an EXISTING key
  // mutates that pair's value node in place, keeping its quote style — so a
  // title update does not churn the quoting on the one line that changed. The
  // value below ("New title") needs no quoting, so the ONLY reason it stays
  // quoted in the output is style preservation. A future change that rebuilds
  // the title node (delete+re-add, or a forced-plain scalar) would drop the
  // quotes and fail this test.
  const yaml = `project: forge
phases:
  - id: phase-1
    name: P
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: "Old title"
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;
  const doc = parseDocument(yaml);
  const plan = {
    updated: [
      {
        task_id: 'P1-T01',
        tracker_issue_id: 'tracker-1',
        changes: [{ field: 'title' as const, from: 'Old title', to: 'New title' }],
      },
    ],
    removed: [],
    added: [],
    unmanaged: [],
  };
  const n = applyPlanToDocument(doc, plan, { confirmPrune: false });
  assert.equal(n, 1);
  assert.match(doc.toString(), /title: "New title"/);
});

test('applyPlanToDocument — prunes orphan when confirmPrune=true', () => {
  const doc = parseDocument(SAMPLE_YAML);
  const plan = {
    updated: [],
    removed: [{ task_id: 'P1-T02', tracker_issue_id: 'tracker-gone' }],
    added: [],
    unmanaged: [],
  };
  const n = applyPlanToDocument(doc, plan, { confirmPrune: true });
  assert.equal(n, 1);
  const out = doc.toString();
  assert.equal(out.includes('P1-T02'), false);
  assert.match(out, /P1-T01/);
});

test('applyPlanToDocument — does NOT prune without confirmPrune', () => {
  const doc = parseDocument(SAMPLE_YAML);
  const plan = {
    updated: [],
    removed: [{ task_id: 'P1-T02', tracker_issue_id: 'tracker-gone' }],
    added: [],
    unmanaged: [],
  };
  const n = applyPlanToDocument(doc, plan, { confirmPrune: false });
  assert.equal(n, 0);
  assert.match(doc.toString(), /P1-T02/);
});

test('applyPlanToDocument — refuses to prune an anchored task (would dangle aliases)', () => {
  // Regression for Claude 2nd-pass BLOCK: yaml v2 does not re-resolve
  // aliases on toString() after a parent-sequence splice. If a task uses
  // &anchor and another node uses *alias, splicing the anchored task
  // produces "Unresolved alias" on serialize. We throw early instead.
  const yaml = `project: forge
phases:
  - id: phase-1
    name: P
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-gone
        title: &anchor Anchored title
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
        alias_field: *anchor
`;
  const doc = parseDocument(yaml);
  const plan = {
    updated: [],
    removed: [{ task_id: 'P1-T01', tracker_issue_id: 'tracker-gone' }],
    added: [],
    unmanaged: [],
  };
  // Note: this fixture anchors `title`, not the whole task node — adjusting:
  const yaml2 = `project: forge
phases:
  - id: phase-1
    name: P
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - &task1
        id: P1-T01
        tracker_issue_id: tracker-gone
        title: Anchored task
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;
  const doc2 = parseDocument(yaml2);
  assert.throws(
    () => applyPlanToDocument(doc2, plan, { confirmPrune: true }),
    /YAML anchor/,
  );
  void doc;
});

test('applyPlanToDocument — depends_on update writes flow-style array', () => {
  const doc = parseDocument(SAMPLE_YAML);
  const plan = {
    updated: [
      {
        task_id: 'P1-T01',
        tracker_issue_id: 'tracker-1',
        changes: [
          {
            field: 'depends_on' as const,
            from: [] as readonly string[],
            to: ['P1-T00'] as readonly string[],
          },
        ],
      },
    ],
    removed: [],
    added: [],
    unmanaged: [],
  };
  const n = applyPlanToDocument(doc, plan, { confirmPrune: false });
  assert.equal(n, 1);
  assert.match(doc.toString(), /depends_on:\s*\[\s*P1-T00\s*\]/);
});

test('applyPullToPhases — added entries are NOT auto-inserted', () => {
  const phases = mkPhases([]);
  const plan = {
    updated: [],
    removed: [],
    added: [
      {
        tracker_issue_id: 't-new',
        identifier: 'FORGE-99',
        title: 'New',
        forge_task_id: 'P9-T99',
      },
    ],
    unmanaged: [],
  };
  const next = applyPullToPhases(phases, plan, { confirmPrune: true });
  assert.equal(next.phases[0]!.tasks.length, 0);
});
