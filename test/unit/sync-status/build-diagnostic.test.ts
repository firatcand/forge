import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnostic } from '../../../src/sync-status/index.ts';
import type { Phase, Phases, Task } from '../../../src/schemas/phases.ts';
import type { Issue, IssueState } from '../../../src/trackers/types.ts';

const FROZEN_NOW = () => new Date('2026-05-16T12:00:00.000Z');

function makeTask(id: string, opts: Partial<Task> = {}): Task {
  return {
    id,
    title: opts.title ?? `Task ${id}`,
    description: opts.description ?? `desc for ${id}`,
    type: opts.type ?? 'backend',
    priority: opts.priority ?? 'P0',
    depends_on: opts.depends_on ?? [],
    estimate: opts.estimate ?? 'M',
    owner_type: opts.owner_type ?? 'backend-dev',
    acceptance: opts.acceptance ?? ['accept-1'],
    tracker_issue_id: opts.tracker_issue_id,
    split_into: opts.split_into,
  };
}

function makePhase(id: string, status: Phase['status'], tasks: Task[]): Phase {
  return {
    id,
    name: `Phase ${id}`,
    status,
    goal: 'goal',
    gate_criteria: ['gate-1'],
    tasks,
  };
}

function makePhases(phases: Phase[]): Phases {
  return { project: 'forge', phases };
}

function makeIssue(identifier: string, state: IssueState, title = `Issue ${identifier}`): Issue {
  return { id: identifier, identifier, title, state, blockerIds: [] };
}

test('AC1: active phase, all tracked tasks absent from active set, no untracked → ready_to_gate=true', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' }),
      makeTask('P2-T02', { tracker_issue_id: 'FORGE-101' }),
    ]),
  ]);
  const issues: Issue[] = [];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 1);
  const s = report.phase_suggestions[0]!;
  assert.equal(s.phase_id, 'phase-2');
  assert.equal(s.tracked_total, 2);
  assert.equal(s.tracked_inactive, 2);
  assert.equal(s.untracked_warnings.length, 0);
  assert.equal(s.ready_to_gate, true);
  assert.equal(report.generated_at, '2026-05-16T12:00:00.000Z');
});

test('AC2: active phase, all tracked tasks absent, 2 untracked → ready_to_gate=false, warnings populated', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' }),
      makeTask('P2-T02', { tracker_issue_id: 'FORGE-101' }),
      makeTask('P2-T20', { title: 'Spike: GraphQL client' }),
      makeTask('P2-T21', { title: 'Doc audit' }),
    ]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 1);
  const s = report.phase_suggestions[0]!;
  assert.equal(s.tracked_total, 2);
  assert.equal(s.tracked_inactive, 2);
  assert.equal(s.untracked_warnings.length, 2);
  assert.deepEqual(s.untracked_warnings, [
    { task_id: 'P2-T20', title: 'Spike: GraphQL client' },
    { task_id: 'P2-T21', title: 'Doc audit' },
  ]);
  assert.equal(s.ready_to_gate, false);
});

test('AC3: active phase with 1 tracked task still active → no suggestion (silent)', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' }),
      makeTask('P2-T02', { tracker_issue_id: 'FORGE-101' }),
    ]),
  ]);
  const issues = [makeIssue('FORGE-100', 'in_progress')];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0);
});

test('AC4: multiple active phases → multiple suggestions', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' })]),
    makePhase('phase-3', 'active', [makeTask('P3-T01', { tracker_issue_id: 'FORGE-200' })]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 2);
  assert.deepEqual(
    report.phase_suggestions.map((s) => s.phase_id),
    ['phase-2', 'phase-3'],
  );
});

test('AC5: all phases done → empty phase_suggestions', () => {
  const phases = makePhases([
    makePhase('phase-1', 'done', [makeTask('P1-T01', { tracker_issue_id: 'FORGE-1' })]),
    makePhase('phase-2', 'done', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-2' })]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0);
});

test('AC6: no active phase → empty phase_suggestions', () => {
  const phases = makePhases([
    makePhase('phase-1', 'done', [makeTask('P1-T01', { tracker_issue_id: 'FORGE-1' })]),
    makePhase('phase-2', 'blocked', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-2' })]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0);
});

test('AC7: orphan detection — tracker issue not in any phase tracker_issue_id set', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' })]),
  ]);
  const issues = [
    makeIssue('FORGE-100', 'in_progress'),
    makeIssue('FORGE-999', 'todo', 'Hot-fix: out-of-band'),
  ];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.orphans.length, 1);
  assert.deepEqual(report.orphans[0], {
    identifier: 'FORGE-999',
    state: 'todo',
    title: 'Hot-fix: out-of-band',
  });
});

test('AC8: zero orphans → empty orphans array', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' })]),
  ]);
  const issues = [makeIssue('FORGE-100', 'in_progress')];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.orphans.length, 0);
});

test('AC9: mixed — phase suggestion + orphans in same run', () => {
  const phases = makePhases([
    makePhase('phase-1', 'done', [makeTask('P1-T01', { tracker_issue_id: 'FORGE-1' })]),
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' }),
    ]),
  ]);
  const issues = [makeIssue('FORGE-555', 'todo', 'Out-of-band hot-fix')];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 1);
  assert.equal(report.phase_suggestions[0]!.ready_to_gate, true);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.identifier, 'FORGE-555');
});

test('AC10: blocked phase ignored — no suggestion even if all tracker IDs absent', () => {
  const phases = makePhases([
    makePhase('phase-2', 'blocked', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' })]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0);
});

test('AC11: limit_hit flag passed through to report', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [makeTask('P2-T01', { tracker_issue_id: 'FORGE-100' })]),
  ]);
  const report = buildDiagnostic(phases, [], {
    now: FROZEN_NOW,
    limit_hit: { tracker_limit: 250 },
  });

  assert.deepEqual(report.limit_hit, { tracker_limit: 250 });
});

test('AC13: active phase with ONLY untracked tasks → suggestion with all tasks in warnings, ready_to_gate=false', () => {
  const phases = makePhases([
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { title: 'Spike A' }),
      makeTask('P2-T02', { title: 'Spike B' }),
    ]),
  ]);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 1);
  const s = report.phase_suggestions[0]!;
  assert.equal(s.tracked_total, 0);
  assert.equal(s.tracked_inactive, 0);
  assert.equal(s.untracked_warnings.length, 2);
  assert.equal(s.ready_to_gate, false);
});

test('AC14: cross-adapter — tracker_issue_id stores adapter-native identifier (Linear FORGE-X, GitHub #N)', () => {
  // Locks in the contract: tracker_issue_id MUST match issue.identifier exactly.
  // If a future adapter change drifts identifier formatting, this test fails fast.
  const phases = makePhases([
    makePhase('phase-2', 'active', [
      makeTask('P2-T01', { tracker_issue_id: '#42' }),
      makeTask('P2-T02', { tracker_issue_id: '#43' }),
    ]),
  ]);
  const issues = [
    makeIssue('#42', 'in_progress', 'GitHub-style issue'),
    makeIssue('#99', 'todo', 'Orphan with hash prefix'),
  ];
  const report = buildDiagnostic(phases, issues, { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0); // #42 still active → no suggestion
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]!.identifier, '#99');
});

test('AC12: defensive — phase with zero tasks does not crash, produces no suggestion', () => {
  const phases: Phases = {
    project: 'forge',
    phases: [
      {
        id: 'phase-2',
        name: 'Phase 2',
        status: 'active',
        goal: 'goal',
        gate_criteria: ['gate-1'],
        tasks: [] as Task[],
      },
    ],
  };
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.equal(report.phase_suggestions.length, 0);
});

test('AC bonus: real-world phases.yaml smoke (loadPhases pipeline)', async () => {
  const { loadPhases } = await import('../../../src/core/index.ts');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = dirname(fileURLToPath(import.meta.url));
  const repoPhases = resolve(here, '..', '..', '..', 'plans', 'phases.yaml');

  const phases = loadPhases(repoPhases);
  const report = buildDiagnostic(phases, [], { now: FROZEN_NOW });

  assert.ok(Array.isArray(report.phase_suggestions));
  assert.ok(Array.isArray(report.orphans));
  assert.equal(typeof report.generated_at, 'string');
});
