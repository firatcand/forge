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

test('diffPull — local-only depends_on (dep without tracker_issue_id) is NOT silently truncated', () => {
  // Regression for code-review BLOCK #3: a local task with depends_on
  // [P1-T01, P1-T02] where P1-T02 has no tracker_issue_id can never be
  // represented on the tracker side. The previous implementation produced
  // a spurious diff and would have overwritten depends_on to [P1-T01],
  // silently dropping the local-only P1-T02.
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
  // Tracker can only carry P1-T01 as blockerId; P1-T02 has no tracker mirror
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
  // No depends_on diff — the local-only dep means we skip the diff entirely
  const childUpdate = plan.updated.find((u) => u.task_id === 'P1-T03');
  assert.equal(childUpdate, undefined, 'expected no diff for child task');
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
