import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHEAP_ROW_IDS,
  planGc,
  type GcPlanRow,
  type OrchestratorSnapshot,
  type TaskSnapshot,
  type LeaseAtPath,
  type AttemptSnapshot,
} from '../../src/orchestrator/gc.ts';
import type { Lease } from '../../src/schemas/lease.ts';
import type { TaskStateRecord, TaskState } from '../../src/schemas/task-state.ts';
import type { Issue, IssueState } from '../../src/trackers/types.ts';
import type { Phases } from '../../src/schemas/phases.ts';

// ---- Fixtures ----

function mkLease(overrides: Partial<Lease> = {}): Lease {
  return {
    version: 1,
    claim_id: 'claim-A',
    task_id: 'TASK-X',
    attempt_id: null,
    owner_run_id: 'run-A',
    acquired_at: '2026-05-15T10:00:00.000Z',
    expires_at: '2026-05-15T10:30:00.000Z',
    last_heartbeat_at: '2026-05-15T10:00:00.000Z',
    generation: 0,
    spec_revision: 'git:0000000000000000000000000000000000000000',
    lease_version: 1,
    ...overrides,
  };
}

function mkLeaseAtPath(
  overrides: Partial<Lease> = {},
  pathOverride?: string,
  isCanonical = true,
): LeaseAtPath {
  const lease = mkLease(overrides);
  return {
    lease,
    path: pathOverride ?? `/fake/.forge/orchestrator/tasks/${lease.task_id}/lease.json`,
    isCanonical,
  };
}

function mkState(overrides: Partial<TaskStateRecord> = {}): TaskStateRecord {
  const base: TaskStateRecord = {
    version: 1,
    task_id: 'TASK-X',
    state: 'unclaimed' as TaskState,
    state_version: 0,
    attempt_count: 0,
    failure_count: 0,
    last_failure_key: null,
    review_attempt_count: 0,
    ship_attempt_count: 0,
    current_attempt_id: null,
    updated_at: '2026-05-15T10:00:00.000Z',
    updated_by: { run_id: 'run-A', claim_id: 'claim-A', generation: 0 },
  };
  return { ...base, ...overrides } as TaskStateRecord;
}

function mkTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    state: null,
    leases: [],
    attempts: [],
    ...overrides,
  };
}

function mkAttempt(overrides: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    attemptId: 'att-001',
    isTerminal: false,
    verdictPresent: false,
    verdictVerifiedPresent: false,
    questionFiles: [],
    orphanAnswerFiles: [],
    ...overrides,
  };
}

function mkIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'tracker-id-1',
    identifier: 'FORGE-1',
    title: 't',
    state: 'in_progress' as IssueState,
    blockerIds: [],
    ...overrides,
  };
}

function mkSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  const emptyPhases: Phases = { phases: [] } as unknown as Phases;
  return {
    tasks: new Map(),
    trackerIssues: new Map(),
    worktrees: [],
    branches: [],
    phases: emptyPhases,
    now: new Date('2026-05-15T11:00:00.000Z'),
    mode: 'full',
    ...overrides,
  };
}

// ---- cheap-set partition ----

test('gc: CHEAP_ROW_IDS is exactly {2, 5, 8, 11, 12, 13, 14}', () => {
  assert.deepEqual([...CHEAP_ROW_IDS].sort((a, b) => a - b), [2, 5, 8, 11, 12, 13, 14]);
});

test('gc: planGc(empty snapshot) returns empty plan + cheap set', () => {
  const plan = planGc(mkSnapshot());
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.cheapRows, CHEAP_ROW_IDS);
});

test('gc: cheap mode skips expensive rows (1, 3, 4, 6, 7, 9, 10) even when their preconditions match', () => {
  // running task + tracker says done — row 1 would fire in full mode
  const tasks = new Map([
    [
      'TASK-A',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-A', state: 'running' }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-A' })],
      }),
    ],
  ]);
  const trackerIssues = new Map([
    ['TASK-A', mkIssue({ identifier: 'TASK-A', state: 'done' as IssueState })],
  ]);
  const plan = planGc(
    mkSnapshot({ tasks, trackerIssues, mode: 'cheap' }),
  );
  // No row 1 in cheap mode
  assert.equal(
    plan.rows.find((r) => r.rowId === 1),
    undefined,
  );
});

// ---- Row 1: running + tracker done → mark_terminal ----

test('gc row 1: running locally + tracker done → mark_terminal:shipped (full mode)', () => {
  const lease = mkLease({ task_id: 'TASK-A', claim_id: 'claim-1' });
  const tasks = new Map([
    [
      'TASK-A',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-A', state: 'running' }),
        leases: [{ lease, path: '/p/lease.json', isCanonical: true }],
      }),
    ],
  ]);
  const trackerIssues = new Map([
    ['TASK-A', mkIssue({ identifier: 'TASK-A', state: 'done' })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, trackerIssues, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 1);
  assert.ok(row);
  assert.equal(row.action, 'mark_terminal');
  if (row.action === 'mark_terminal') {
    assert.equal(row.payload.targetState, 'shipped');
    assert.equal(row.payload.leaseIdentity.claimId, 'claim-1');
  }
});

test('gc row 1: running locally + tracker cancelled → mark_terminal:cancelled', () => {
  const tasks = new Map([
    [
      'TASK-B',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-B', state: 'running' }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-B' })],
      }),
    ],
  ]);
  const trackerIssues = new Map([
    ['TASK-B', mkIssue({ identifier: 'TASK-B', state: 'cancelled' })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, trackerIssues, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 1);
  assert.ok(row);
  if (row?.action === 'mark_terminal') {
    assert.equal(row.payload.targetState, 'cancelled');
  }
});

// ---- Row 2: running + expired lease (beyond grace) → mark_abandoned ----

test('gc row 2 (cheap): running + lease expired beyond steal_grace_ms → mark_abandoned', () => {
  const tasks = new Map([
    [
      'TASK-C',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-C', state: 'running' }),
        leases: [
          mkLeaseAtPath({
            task_id: 'TASK-C',
            expires_at: '2026-05-15T10:00:00.000Z', // 1 hour ago
          }),
        ],
      }),
    ],
  ]);
  const plan = planGc(
    mkSnapshot({
      tasks,
      mode: 'cheap',
      now: new Date('2026-05-15T11:00:00.000Z'),
      stealGraceMs: 60_000,
    }),
  );
  const row = plan.rows.find((r) => r.rowId === 2);
  assert.ok(row, 'row 2 should fire');
  assert.equal(row.action, 'mark_abandoned');
});

test('gc row 2: lease not yet expired beyond grace → no row', () => {
  const tasks = new Map([
    [
      'TASK-D',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-D', state: 'running' }),
        leases: [
          mkLeaseAtPath({
            task_id: 'TASK-D',
            expires_at: '2026-05-15T11:00:00.000Z', // now
          }),
        ],
      }),
    ],
  ]);
  const plan = planGc(
    mkSnapshot({
      tasks,
      mode: 'cheap',
      now: new Date('2026-05-15T11:00:01.000Z'),
      stealGraceMs: 60_000,
    }),
  );
  assert.equal(plan.rows.find((r) => r.rowId === 2), undefined);
});

// ---- Row 3: claimed local + no tracker claim → mark_unclaimed ----

test('gc row 3 (full): claimed locally + no tracker entry → mark_unclaimed:tracker-not-found', () => {
  const tasks = new Map([
    [
      'TASK-E',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-E', state: 'claimed' }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-E' })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 3);
  assert.ok(row);
  if (row?.action === 'mark_unclaimed') {
    assert.equal(row.payload.reason, 'tracker-not-found');
  }
});

// ---- Row 4: tracker claimed + no local state → report_orphan (deferred recovery) ----

test('gc row 4: tracker has forgeTaskId but no local state → report_orphan (auto-recovery deferred)', () => {
  const trackerIssues = new Map([
    ['tracker-1', mkIssue({ id: 'tracker-1', forgeTaskId: 'FORGE-99' })],
  ]);
  const plan = planGc(mkSnapshot({ trackerIssues, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 4);
  assert.ok(row);
  assert.equal(row.action, 'report_orphan');
  if (row?.action === 'report_orphan') {
    assert.equal(row.payload.kind, 'tracker_claimed_no_local');
  }
});

// ---- Row 5: blocked_on_question with answer ready or timeout ----

test('gc row 5: blocked_on_question + answer ready → report (info)', () => {
  const tasks = new Map([
    [
      'TASK-F',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-F', state: 'blocked_on_question' }),
        attempts: [
          mkAttempt({
            attemptId: 'att-1',
            blockedOnQuestion: {
              attemptStartedAt: '2026-05-15T10:00:00.000Z',
              answerReady: true,
            },
          }),
        ],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const row = plan.rows.find((r) => r.rowId === 5);
  assert.ok(row);
  assert.equal(row.severity, 'info');
});

test('gc row 5: blocked_on_question + timeout elapsed → report', () => {
  const tasks = new Map([
    [
      'TASK-G',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-G', state: 'blocked_on_question' }),
        attempts: [
          mkAttempt({
            attemptId: 'att-1',
            blockedOnQuestion: {
              attemptStartedAt: '2026-05-15T10:00:00.000Z',
              answerReady: false,
            },
          }),
        ],
      }),
    ],
  ]);
  const plan = planGc(
    mkSnapshot({
      tasks,
      mode: 'cheap',
      now: new Date('2026-05-15T11:00:00.000Z'),
      questionTimeoutMs: 30 * 60 * 1000, // 30 min, elapsed 60 min
    }),
  );
  const row = plan.rows.find((r) => r.rowId === 5);
  assert.ok(row);
});

// ---- Row 6: ready_for_review + tracker done → mark shipped ----

test('gc row 6 (full): ready_for_review + tracker done → mark_terminal:shipped', () => {
  const tasks = new Map([
    [
      'TASK-H',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-H', state: 'ready_for_review' }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-H' })],
      }),
    ],
  ]);
  const trackerIssues = new Map([
    ['TASK-H', mkIssue({ identifier: 'TASK-H', state: 'done' })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, trackerIssues, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 6);
  assert.ok(row);
  if (row?.action === 'mark_terminal') {
    assert.equal(row.payload.targetState, 'shipped');
  }
});

// ---- Row 7: shipped + tracker not closed → report ----

test('gc row 7 (full): shipped + tracker still todo → report_orphan:shipped_not_closed', () => {
  const tasks = new Map([
    [
      'TASK-I',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-I', state: 'shipped', failure_reason: undefined }),
      }),
    ],
  ]);
  const trackerIssues = new Map([
    ['TASK-I', mkIssue({ identifier: 'TASK-I', state: 'todo' })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, trackerIssues, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 7);
  assert.ok(row);
  if (row?.action === 'report_orphan') {
    assert.equal(row.payload.kind, 'shipped_not_closed');
  }
});

// ---- Row 8: verdict.json + no verdict.verified.json → reverify ----

test('gc row 8: verdict.json present without verdict.verified.json → reverify_verdict', () => {
  const tasks = new Map([
    [
      'TASK-J',
      mkTaskSnapshot({
        attempts: [mkAttempt({ verdictPresent: true, verdictVerifiedPresent: false })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const row = plan.rows.find((r) => r.rowId === 8);
  assert.ok(row);
  assert.equal(row.action, 'reverify_verdict');
});

test('gc row 8: verdict.json + verdict.verified.json both present → no row', () => {
  const tasks = new Map([
    [
      'TASK-K',
      mkTaskSnapshot({
        attempts: [mkAttempt({ verdictPresent: true, verdictVerifiedPresent: true })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  assert.equal(plan.rows.find((r) => r.rowId === 8), undefined);
});

// ---- Row 9: branch exists, worktree missing ----

test('gc row 9 (full): branch + no worktree + task shipped → prune_branch', () => {
  const tasks = new Map([
    [
      'TASK-L',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-L', state: 'shipped' }),
      }),
    ],
  ]);
  const branches = [{ ref: 'feat/TASK-L', taskIdFromRef: 'TASK-L' }];
  const plan = planGc(
    mkSnapshot({ tasks, branches, mode: 'full' }),
  );
  const row = plan.rows.find((r) => r.rowId === 9);
  assert.ok(row);
  if (row?.action === 'prune_branch') {
    assert.equal(row.payload.reason, 'shipped');
  }
});

test('gc row 9 (full): branch + no worktree + task NOT shipped → report_orphan (prompt)', () => {
  const tasks = new Map([
    [
      'TASK-M',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-M', state: 'unclaimed' }),
      }),
    ],
  ]);
  const branches = [{ ref: 'feat/TASK-M', taskIdFromRef: 'TASK-M' }];
  const plan = planGc(mkSnapshot({ tasks, branches, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 9);
  assert.ok(row);
  assert.equal(row.action, 'report_orphan');
});

// ---- Row 10: worktree exists, no task in phases.yaml ----

test('gc row 10 (full): orphan worktree (taskId not in phases.yaml) → report_orphan', () => {
  const worktrees = [{ path: '/p/.forge/worktrees/FORGE-99', taskIdFromMarker: 'FORGE-99' }];
  const phases: Phases = { phases: [] } as unknown as Phases;
  const plan = planGc(mkSnapshot({ worktrees, phases, mode: 'full' }));
  const row = plan.rows.find((r) => r.rowId === 10);
  assert.ok(row);
  if (row?.action === 'report_orphan') {
    assert.equal(row.payload.kind, 'worktree');
  }
});

test('gc row 10: worktree present + task in phases.yaml → no row', () => {
  const worktrees = [{ path: '/p/.forge/worktrees/T-X', taskIdFromMarker: 'T-X' }];
  const phases: Phases = {
    phases: [{ id: 'P1', name: '', status: 'active', tasks: [{ id: 'T-X' }] } as unknown as Phases['phases'][number]],
  } as unknown as Phases;
  const plan = planGc(mkSnapshot({ worktrees, phases, mode: 'full' }));
  assert.equal(plan.rows.find((r) => r.rowId === 10), undefined);
});

// ---- Row 11: question file + terminal attempt → archive ----

test('gc row 11: question file present on terminal attempt → archive_question', () => {
  const tasks = new Map([
    [
      'TASK-N',
      mkTaskSnapshot({
        attempts: [
          mkAttempt({
            attemptId: 'att-1',
            isTerminal: true,
            questionFiles: ['/p/q1.json', '/p/q2.json'],
          }),
        ],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const rows = plan.rows.filter((r) => r.rowId === 11);
  assert.equal(rows.length, 2, 'one row per question file');
  for (const r of rows) {
    assert.equal(r.action, 'archive_question');
  }
});

test('gc row 11: question file on non-terminal attempt → no row', () => {
  const tasks = new Map([
    [
      'TASK-O',
      mkTaskSnapshot({
        attempts: [mkAttempt({ isTerminal: false, questionFiles: ['/p/q.json'] })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  assert.equal(plan.rows.find((r) => r.rowId === 11), undefined);
});

// ---- Row 12: orphan answer file → report ----

test('gc row 12: answer file without matching question file → report_orphan', () => {
  const tasks = new Map([
    [
      'TASK-P',
      mkTaskSnapshot({
        attempts: [mkAttempt({ orphanAnswerFiles: ['/p/a.json'] })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const row = plan.rows.find((r) => r.rowId === 12);
  assert.ok(row);
  if (row?.action === 'report_orphan') {
    assert.equal(row.payload.kind, 'answer_no_question');
  }
});

// ---- Row 13: multiple leases → release older generations ----

test('gc row 13: two leases same task → one release_lease_admin for older gen', () => {
  const newLease = mkLeaseAtPath(
    { task_id: 'TASK-Q', claim_id: 'claim-new', generation: 1 },
    '/p/lease.json',
    true,
  );
  const oldLease = mkLeaseAtPath(
    { task_id: 'TASK-Q', claim_id: 'claim-old', generation: 0 },
    '/p/lease.json.bak',
    false,
  );
  const tasks = new Map([['TASK-Q', mkTaskSnapshot({ leases: [newLease, oldLease] })]]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const rows = plan.rows.filter((r) => r.rowId === 13);
  assert.equal(rows.length, 1, 'exactly one row for the older lease');
  const row = rows[0];
  if (row.action === 'release_lease_admin') {
    assert.equal(row.payload.expectedClaimId, 'claim-old');
    assert.equal(row.payload.expectedGeneration, 0);
    assert.equal(row.payload.expectedPath, '/p/lease.json.bak');
    assert.equal(row.payload.requireTerminalState, false);
    assert.equal(row.payload.reason, 'gc:row-13:duplicate');
  } else {
    assert.fail(`expected release_lease_admin, got ${row.action}`);
  }
});

test('gc row 13: three leases → two release rows for two older gens', () => {
  const tasks = new Map([
    [
      'TASK-R',
      mkTaskSnapshot({
        leases: [
          mkLeaseAtPath({ generation: 2 }, '/p/lease.json', true),
          mkLeaseAtPath({ generation: 1 }, '/p/lease.json.1', false),
          mkLeaseAtPath({ generation: 0 }, '/p/lease.json.0', false),
        ],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const rows = plan.rows.filter((r) => r.rowId === 13);
  assert.equal(rows.length, 2);
});

// ---- Row 14: lease + terminal state → release_lease_admin (requireTerminalState=true) ----

test('gc row 14: terminal state + lease present → release_lease_admin with requireTerminalState=true', () => {
  const tasks = new Map([
    [
      'TASK-S',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-S', state: 'shipped' }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-S', claim_id: 'claim-S' })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const row = plan.rows.find((r) => r.rowId === 14);
  assert.ok(row);
  if (row?.action === 'release_lease_admin') {
    assert.equal(row.payload.requireTerminalState, true);
    assert.equal(row.payload.reason, 'gc:row-14:terminal-state');
    assert.equal(row.payload.expectedClaimId, 'claim-S');
  } else {
    assert.fail();
  }
});

test('gc row 14: terminal state but NO lease → no row (already clean)', () => {
  const tasks = new Map([
    [
      'TASK-T',
      mkTaskSnapshot({
        state: mkState({ task_id: 'TASK-T', state: 'shipped' }),
        leases: [],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  assert.equal(plan.rows.find((r) => r.rowId === 14), undefined);
});

test('gc row 14: failed state with failure_reason + lease → release_lease_admin', () => {
  const tasks = new Map([
    [
      'TASK-U',
      mkTaskSnapshot({
        state: mkState({
          task_id: 'TASK-U',
          state: 'failed',
          failure_reason: 'retries_exhausted',
        }),
        leases: [mkLeaseAtPath({ task_id: 'TASK-U' })],
      }),
    ],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  assert.ok(plan.rows.find((r) => r.rowId === 14));
});

// ---- Determinism + ordering ----

test('gc: plan ordering is deterministic — sorted by (rowId, taskId)', () => {
  const tasks = new Map([
    ['TASK-Z', mkTaskSnapshot({ state: mkState({ task_id: 'TASK-Z', state: 'shipped' }), leases: [mkLeaseAtPath({ task_id: 'TASK-Z' })] })],
    ['TASK-A', mkTaskSnapshot({ state: mkState({ task_id: 'TASK-A', state: 'shipped' }), leases: [mkLeaseAtPath({ task_id: 'TASK-A' })] })],
    ['TASK-M', mkTaskSnapshot({ state: mkState({ task_id: 'TASK-M', state: 'shipped' }), leases: [mkLeaseAtPath({ task_id: 'TASK-M' })] })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  const ids = plan.rows.filter((r) => r.rowId === 14).map((r) => r.taskId);
  assert.deepEqual(ids, ['TASK-A', 'TASK-M', 'TASK-Z']);
});

test('gc: plan is empty (no-op) when snapshot is aligned', () => {
  // Aligned: a single completed task with no lease.
  const tasks = new Map([
    ['TASK-ALIGNED', mkTaskSnapshot({ state: mkState({ task_id: 'TASK-ALIGNED', state: 'unclaimed' }), leases: [], attempts: [] })],
  ]);
  const plan = planGc(mkSnapshot({ tasks, mode: 'cheap' }));
  assert.equal(plan.rows.length, 0);
});

// ---- Discriminated union exhaustiveness ----

test('gc: GcPlanRow union is exhaustively handled by a switch (compile-time check)', () => {
  // This test exists to lock the discriminated union. Adding a new action to
  // GcPlanRow without updating this switch produces a TS `never` error at the
  // default case.
  function handle(row: GcPlanRow): string {
    switch (row.action) {
      case 'mark_terminal':
        return 'mt';
      case 'mark_abandoned':
        return 'ma';
      case 'mark_unclaimed':
        return 'mu';
      case 'archive_question':
        return 'aq';
      case 'reverify_verdict':
        return 'rv';
      case 'release_lease_admin':
        return 'rla';
      case 'prune_branch':
        return 'pb';
      case 'report_orphan':
        return 'ro';
      default: {
        const _never: never = row;
        return _never;
      }
    }
  }
  // Invoke once with a synthetic row to confirm the function compiles.
  const row: GcPlanRow = {
    rowId: 14,
    taskId: 'X',
    severity: 'info',
    action: 'release_lease_admin',
    payload: {
      expectedClaimId: 'c',
      expectedGeneration: 0,
      expectedOwnerRunId: 'r',
      expectedExpiresAt: '2026-01-01T00:00:00.000Z',
      expectedPath: '/p',
      requireTerminalState: true,
      reason: 'gc:row-14:terminal-state',
    },
  };
  assert.equal(handle(row), 'rla');
});
