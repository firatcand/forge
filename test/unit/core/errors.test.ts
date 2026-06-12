import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrchestratorError } from '../../../src/core/errors.ts';

test('OrchestratorError.safeDetails — allow-listed identifier keys pass through', () => {
  const err = new OrchestratorError('LEASE_STOLEN', 'msg', {
    taskId: 'FORGE-1',
    runId: '0190run',
    attemptId: 'att-1',
    claimId: 'claim-1',
    questionId: 'q-1',
    decisionKey: 'dk-1',
    rowId: 14,
    state: 'running',
    fromState: 'claimed',
    toState: 'running',
    expected: 'a',
    actual: 'b',
    generation: 3,
    stateVersion: 7,
  });
  assert.deepEqual(err.safeDetails(), {
    taskId: 'FORGE-1',
    runId: '0190run',
    attemptId: 'att-1',
    claimId: 'claim-1',
    questionId: 'q-1',
    decisionKey: 'dk-1',
    rowId: 14,
    state: 'running',
    fromState: 'claimed',
    toState: 'running',
    expected: 'a',
    actual: 'b',
    generation: 3,
    stateVersion: 7,
  });
});

test('OrchestratorError.safeDetails — an unknown key is redacted (named AC)', () => {
  const err = new OrchestratorError('IO_ERROR', 'msg', {
    taskId: 'FORGE-2',
    somethingSecret: 'super-secret-value',
  });
  const safe = err.safeDetails();
  assert.equal(safe['taskId'], 'FORGE-2');
  assert.equal(safe['somethingSecret'], '[redacted]');
});

test('OrchestratorError.safeDetails — path and cause are redacted', () => {
  const cause = new Error('inner with /home/user/.forge/lease.json in it');
  const err = new OrchestratorError('IO_ERROR', 'msg', {
    taskId: 'FORGE-3',
    path: '/Users/secret/.forge/orchestrator/tasks/x/lease.json',
    dir: '/Users/secret/.forge',
    cause,
  });
  const safe = err.safeDetails();
  assert.equal(safe['taskId'], 'FORGE-3');
  assert.equal(safe['path'], '[redacted]');
  assert.equal(safe['dir'], '[redacted]');
  assert.equal(safe['cause'], '[redacted]');
  // The key is preserved so the shape stays debuggable.
  assert.ok('path' in safe);
  assert.ok('cause' in safe);
});

test('OrchestratorError.safeDetails — a non-allow-listed nested object is redacted wholesale (never recursed)', () => {
  const err = new OrchestratorError('SCHEMA_INVALID', 'msg', {
    taskId: 'FORGE-4',
    nested: { path: '/secret/path', taskId: 'should-not-leak-from-here' },
  });
  const safe = err.safeDetails();
  assert.equal(safe['nested'], '[redacted]');
  // Critically, no recursion: the inner object is gone entirely, not partially
  // projected.
  assert.equal(typeof safe['nested'], 'string');
});

test('OrchestratorError.safeDetails — empty details → empty object', () => {
  const err = new OrchestratorError('STATE_NOT_FOUND', 'msg');
  assert.deepEqual(err.safeDetails(), {});
});

test('OrchestratorError.safeDetails — FORGE-149 lease-coordination snake_case ids pass through, paths stay redacted', () => {
  // These are the identity-mismatch keys constructed in src/orchestrator/leases.ts
  // and state-machine.ts on LEASE_STOLEN / LEASE_IDENTITY_MISMATCH.
  const err = new OrchestratorError('LEASE_IDENTITY_MISMATCH', 'msg', {
    stored_claim_id: 'claim-A',
    caller_claim_id: 'claim-B',
    expected_claim_id: 'claim-C',
    stored_generation: 2,
    caller_generation: 3,
    expected_generation: 4,
    from_generation: 1,
    stored_run_id: 'run-A',
    caller_run_id: 'run-B',
    stored_owner_run_id: 'run-C',
    expected_owner_run_id: 'run-D',
    task_id: 'FORGE-9',
    decision_key: 'dk-9',
    current_state: 'running',
    // Still must be redacted — proves the allow-list did not go permissive.
    path: '/Users/secret/.forge/orchestrator/tasks/x/lease.json',
  });
  assert.deepEqual(err.safeDetails(), {
    stored_claim_id: 'claim-A',
    caller_claim_id: 'claim-B',
    expected_claim_id: 'claim-C',
    stored_generation: 2,
    caller_generation: 3,
    expected_generation: 4,
    from_generation: 1,
    stored_run_id: 'run-A',
    caller_run_id: 'run-B',
    stored_owner_run_id: 'run-C',
    expected_owner_run_id: 'run-D',
    task_id: 'FORGE-9',
    decision_key: 'dk-9',
    current_state: 'running',
    path: '[redacted]',
  });
});
