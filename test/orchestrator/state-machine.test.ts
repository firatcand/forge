import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertLegalTransition,
  readTaskState,
  writeTaskState,
  type TransitionTrigger,
} from '../../src/orchestrator/state-machine.ts';
import { OrchestratorError } from '../../src/core/errors.ts';
import type { TaskState, TaskStateRecord } from '../../src/schemas/task-state.ts';
import { leaseFilePath, stateFilePath } from '../../src/orchestrator/questions/paths.ts';
import { LeaseSchema } from '../../src/schemas/lease.ts';

// ---- Helpers ----

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-sm-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function forgeDir(name: string): string {
  const d = join(tmpDir, name, '.forge');
  mkdirSync(d, { recursive: true });
  return d;
}

function makeLease(
  forgeDir: string,
  taskId: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const taskDirPath = join(forgeDir, 'orchestrator', 'tasks', taskId);
  mkdirSync(taskDirPath, { recursive: true });
  const lease = {
    version: 1,
    claim_id: 'claim-001',
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-001',
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    generation: 0,
    spec_revision: 'digest:empty',
    ...overrides,
  };
  writeFileSync(leaseFilePath(forgeDir, taskId), JSON.stringify(lease));
}

function baseState(
  taskId: string,
  overrides: Partial<TaskStateRecord> = {},
): TaskStateRecord {
  return {
    version: 1,
    task_id: taskId,
    state: 'unclaimed',
    state_version: 0,
    attempt_count: 0,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'run-001', claim_id: 'claim-001', generation: 0 },
    ...overrides,
  };
}

const defaultCaller = { run_id: 'run-001', claim_id: 'claim-001', generation: 0 };

// ---- assertLegalTransition: legal transitions ----

const legalTransitions: Array<{ from: TaskState; trigger: TransitionTrigger; to: TaskState }> = [
  { from: 'unclaimed', trigger: 'claim', to: 'claimed' },
  { from: 'claimed', trigger: 'dispatch', to: 'dispatched' },
  { from: 'dispatched', trigger: 'first_heartbeat', to: 'running' },
  { from: 'running', trigger: 'question_written', to: 'blocked_on_question' },
  { from: 'blocked_on_question', trigger: 'answer_recorded', to: 'awaiting_respawn' },
  { from: 'awaiting_respawn', trigger: 'dispatch', to: 'dispatched' },
  { from: 'running', trigger: 'complete_ready_for_review', to: 'ready_for_review' },
  { from: 'ready_for_review', trigger: 'review_passed', to: 'reviewed' },
  { from: 'reviewed', trigger: 'ship_completed', to: 'shipped' },
  { from: 'running', trigger: 'lease_expired', to: 'abandoned' },
  { from: 'dispatched', trigger: 'lease_expired', to: 'abandoned' },
  { from: 'blocked_on_question', trigger: 'lease_expired', to: 'abandoned' },
  { from: 'abandoned', trigger: 'steal', to: 'unclaimed' },
  { from: 'running', trigger: 'cancel', to: 'cancelled' },
  { from: 'claimed', trigger: 'cancel', to: 'cancelled' },
  { from: 'dispatched', trigger: 'cancel', to: 'cancelled' },
  { from: 'running', trigger: 'retries_exhausted', to: 'failed' },
  { from: 'ready_for_review', trigger: 'changes_requested', to: 'running' },
];

for (const { from, trigger, to } of legalTransitions) {
  test(`state-machine: legal transition ${from} --[${trigger}]--> ${to} does not throw`, () => {
    assert.doesNotThrow(() => assertLegalTransition(from, to, trigger));
  });
}

// ---- assertLegalTransition: illegal transitions ----

test('state-machine: unclaimed → running is illegal', () => {
  assert.throws(
    () => assertLegalTransition('unclaimed', 'running', 'first_heartbeat'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: shipped → anything is illegal (terminal)', () => {
  assert.throws(
    () => assertLegalTransition('shipped', 'unclaimed', 'claim'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: cancelled → anything is illegal (terminal)', () => {
  assert.throws(
    () => assertLegalTransition('cancelled', 'unclaimed', 'claim'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: failed → anything is illegal (terminal)', () => {
  assert.throws(
    () => assertLegalTransition('failed', 'unclaimed', 'claim'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: running → claimed is illegal (backwards move)', () => {
  assert.throws(
    () => assertLegalTransition('running', 'claimed', 'claim'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: ready_for_review → dispatched is illegal (skipped regress path)', () => {
  assert.throws(
    () => assertLegalTransition('ready_for_review', 'dispatched', 'dispatch'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: unclaimed → dispatched is illegal', () => {
  assert.throws(
    () => assertLegalTransition('unclaimed', 'dispatched', 'dispatch'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: claimed → running is illegal (skipped dispatch)', () => {
  assert.throws(
    () => assertLegalTransition('claimed', 'running', 'first_heartbeat'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: reviewed → running is illegal', () => {
  assert.throws(
    () => assertLegalTransition('reviewed', 'running', 'changes_requested'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: ILLEGAL_TRANSITION error includes from and to in details', () => {
  try {
    assertLegalTransition('shipped', 'running', 'first_heartbeat');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof OrchestratorError);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.details.from, 'shipped');
    assert.equal(err.details.to, 'running');
  }
});

test('state-machine: awaiting_respawn → running is illegal (must go through dispatch)', () => {
  assert.throws(
    () => assertLegalTransition('awaiting_respawn', 'running', 'first_heartbeat'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('state-machine: abandoned → claimed is illegal (must go unclaimed first)', () => {
  assert.throws(
    () => assertLegalTransition('abandoned', 'claimed', 'claim'),
    (err) => err instanceof OrchestratorError && err.code === 'ILLEGAL_TRANSITION',
  );
});

// ---- readTaskState ----

test('state-machine: readTaskState returns STATE_NOT_FOUND when file absent', () => {
  const fd = forgeDir('read-absent');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-1'), { recursive: true });
  assert.throws(
    () => readTaskState(fd, 'TASK-1'),
    (err) => err instanceof OrchestratorError && err.code === 'STATE_NOT_FOUND',
  );
});

test('state-machine: readTaskState returns SCHEMA_INVALID for invalid JSON', () => {
  const fd = forgeDir('read-invalid-json');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-2'), { recursive: true });
  writeFileSync(stateFilePath(fd, 'TASK-2'), 'not-json');
  assert.throws(
    () => readTaskState(fd, 'TASK-2'),
    (err) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID',
  );
});

test('state-machine: readTaskState returns SCHEMA_INVALID for valid JSON but wrong schema', () => {
  const fd = forgeDir('read-bad-schema');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-3'), { recursive: true });
  writeFileSync(stateFilePath(fd, 'TASK-3'), JSON.stringify({ version: 99 }));
  assert.throws(
    () => readTaskState(fd, 'TASK-3'),
    (err) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID',
  );
});

// ---- writeTaskState ----

test('state-machine: writeTaskState throws INVALID_ID for path/payload mismatch via validateIdSegment on task_id', () => {
  // validateIdSegment rejects empty string
  const fd = forgeDir('write-invalid-id');
  const state = baseState('');
  assert.throws(
    () => writeTaskState(fd, state, defaultCaller),
    (err) => err instanceof OrchestratorError,
  );
});

test('state-machine: writeTaskState throws LEASE_NOT_FOUND when no lease exists', () => {
  const fd = forgeDir('write-no-lease');
  const state = baseState('TASK-WNL');
  assert.throws(
    () => writeTaskState(fd, state, defaultCaller),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_NOT_FOUND',
  );
});

test('state-machine: writeTaskState throws LEASE_STOLEN when caller claim_id mismatches', () => {
  const fd = forgeDir('write-stolen-claim');
  makeLease(fd, 'TASK-WSC', { claim_id: 'claim-real' });
  const state = baseState('TASK-WSC');
  const wrongCaller = { ...defaultCaller, claim_id: 'claim-wrong' };
  assert.throws(
    () => writeTaskState(fd, state, wrongCaller),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

test('state-machine: writeTaskState throws LEASE_STOLEN when caller generation mismatches', () => {
  const fd = forgeDir('write-stolen-gen');
  makeLease(fd, 'TASK-WSG', { generation: 1 });
  const state = baseState('TASK-WSG');
  const wrongCaller = { ...defaultCaller, generation: 0 }; // stored is 1
  assert.throws(
    () => writeTaskState(fd, state, wrongCaller),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

test('state-machine: writeTaskState throws STATE_VERSION_CONFLICT when version is wrong on initial write', () => {
  const fd = forgeDir('write-version-conflict-initial');
  makeLease(fd, 'TASK-WVC1');
  const state = baseState('TASK-WVC1', { state_version: 1 }); // should be 0 for initial
  assert.throws(
    () => writeTaskState(fd, state, defaultCaller),
    (err) => err instanceof OrchestratorError && err.code === 'STATE_VERSION_CONFLICT',
  );
});

test('state-machine: writeTaskState + readTaskState round-trip succeeds', () => {
  const fd = forgeDir('write-roundtrip');
  makeLease(fd, 'TASK-RT');
  const state = baseState('TASK-RT', { state_version: 0, state: 'unclaimed' });
  writeTaskState(fd, state, defaultCaller);
  const read = readTaskState(fd, 'TASK-RT');
  assert.equal(read.task_id, 'TASK-RT');
  assert.equal(read.state, 'unclaimed');
  assert.equal(read.state_version, 0);
  assert.equal(read.updated_by.claim_id, 'claim-001');
});

test('state-machine: writeTaskState increments state_version correctly across two writes', () => {
  const fd = forgeDir('write-version-seq');
  makeLease(fd, 'TASK-VS');
  const state0 = baseState('TASK-VS', { state_version: 0, state: 'unclaimed' });
  writeTaskState(fd, state0, defaultCaller);

  const read0 = readTaskState(fd, 'TASK-VS');
  assert.equal(read0.state_version, 0);

  const state1: TaskStateRecord = { ...read0, state_version: 1, state: 'claimed' };
  writeTaskState(fd, state1, defaultCaller);

  const read1 = readTaskState(fd, 'TASK-VS');
  assert.equal(read1.state_version, 1);
  assert.equal(read1.state, 'claimed');
});

test('state-machine: writeTaskState STATE_VERSION_CONFLICT when state_version is not current+1', () => {
  const fd = forgeDir('write-version-wrong');
  makeLease(fd, 'TASK-VW');
  const state0 = baseState('TASK-VW', { state_version: 0 });
  writeTaskState(fd, state0, defaultCaller);

  // Try to write with version 0 again (should be 1)
  const stateWrong = baseState('TASK-VW', { state_version: 0 });
  assert.throws(
    () => writeTaskState(fd, stateWrong, defaultCaller),
    (err) => err instanceof OrchestratorError && err.code === 'STATE_VERSION_CONFLICT',
  );
});

// Note: this test exercises correctness within a single event-loop turn, NOT true
// inter-process concurrency. Node.js is single-threaded; Promise.allSettled here
// schedules all microtasks in one turn and they execute sequentially. The test
// proves that the version-CAS guard correctly rejects duplicate state_version
// values even when all callers hold the same lease, but does NOT simulate two
// real OS processes racing on the file simultaneously.
test('state-machine: concurrent writeTaskState with same state_version — exactly 1 succeeds', async () => {
  const fd = forgeDir('write-concurrent');
  makeLease(fd, 'TASK-CONC');
  // Write initial state
  const state0 = baseState('TASK-CONC', { state_version: 0 });
  writeTaskState(fd, state0, defaultCaller);

  // All 10 try to write version 1 simultaneously
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => {
      const s: TaskStateRecord = { ...state0, state_version: 1, state: 'claimed' };
      return Promise.resolve().then(() => writeTaskState(fd, s, defaultCaller));
    }),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter(
    (r) =>
      r.status === 'rejected' &&
      r.reason instanceof OrchestratorError &&
      r.reason.code === 'STATE_VERSION_CONFLICT',
  ).length;

  assert.equal(succeeded, 1, 'exactly 1 write should succeed');
  assert.equal(failed, 9, 'remaining 9 should get STATE_VERSION_CONFLICT');
});

// ---- H1: writeTaskState rejects correct claim_id+generation but wrong run_id ----

test('state-machine: writeTaskState throws LEASE_STOLEN for correct claim_id/gen but wrong run_id (H1)', () => {
  const fd = forgeDir('write-wrong-runid');
  makeLease(fd, 'TASK-WRI', { owner_run_id: 'run-real' });
  const state = baseState('TASK-WRI');
  const wrongRunCaller = { run_id: 'run-impersonator', claim_id: 'claim-001', generation: 0 };
  assert.throws(
    () => writeTaskState(fd, state, wrongRunCaller),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- H2: writeTaskState rejects corrupted (non-parseable) state.json ----

test('state-machine: writeTaskState throws SCHEMA_INVALID when state.json contains garbage bytes (H2)', () => {
  const fd = forgeDir('write-corrupt-state');
  makeLease(fd, 'TASK-CRR');
  // Write garbage bytes directly — simulates a partial write / corruption.
  writeFileSync(stateFilePath(fd, 'TASK-CRR'), '{garbage:not-json!!!', 'utf8');
  const state = baseState('TASK-CRR', { state_version: 0 });
  assert.throws(
    () => writeTaskState(fd, state, defaultCaller),
    (err) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID',
  );
});
