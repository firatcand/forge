import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Tracker,
  Issue,
  ClaimResult,
  ClaimFailureReason,
  IssueState,
  CreateIssuePayload,
} from '../../../src/trackers/index.ts';
import { runClaimResultUnionFixture } from '../../fixtures/trackers/conformance.ts';

const fakeIssue: Issue = {
  id: 't_1',
  identifier: 'FORGE-1',
  title: 't',
  state: 'todo',
  blockerIds: [],
};

const fakePayload: CreateIssuePayload = {
  title: 't',
  body: 'b',
  forgeTaskId: 'FORGE-1',
  ownerType: 'backend-dev',
  acceptance: [],
  dependsOn: [],
};

const fakeStates: IssueState[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
  'blocked',
];

const fakeAdapter: Tracker = {
  type: 'github',
  listActiveIssues: async () => [fakeIssue],
  listAllIssues: async () => ({ issues: [fakeIssue], truncated: false }),
  claim: async (_id: string, _runId: string) => ({ ok: true }) as ClaimResult,
  releaseClaim: async (_id: string, _runId: string) => {},
  updateState: async () => {},
  comment: async () => {},
  updateIssueBody: async () => {},
  setClaimFence: async () => {},
  createProject: async (_name: string) => ({
    id: 'p_1',
    url: 'https://github.com/foo/bar',
  }),
  createIssue: async (_p: CreateIssuePayload) => fakeIssue,
  setBlockedBy: async () => {},
  getCurrentRevision: async () => 'github:compile-rev',
  healthCheck: async () => ({ ok: true }),
};

// @ts-expect-error — interface requires all methods (listAllIssues now too)
const _missingMethods: Tracker = {
  type: 'github',
  listActiveIssues: async () => [],
};
void _missingMethods;

test('Tracker interface compiles with all methods implemented (v2 signatures)', async () => {
  const issues = await fakeAdapter.listActiveIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, 't_1');

  const claimed = await fakeAdapter.claim('FORGE-1', 'run-0190abc');
  assert.equal(claimed.ok, true);

  // releaseClaim is (issueId, runId) in v2 — compile check.
  await fakeAdapter.releaseClaim('FORGE-1', 'run-0190abc');

  assert.equal(fakeStates.length, 6);
  assert.equal(fakePayload.forgeTaskId, 'FORGE-1');
});

test('ClaimResult — v2 ok variant compiles with and without tracker_version', () => {
  const bare: ClaimResult = { ok: true };
  const withVersion: ClaimResult = { ok: true, tracker_version: 'rev-1' };

  if (bare.ok) {
    // tracker_version is optional — narrows to string | undefined.
    const v: string | undefined = bare.tracker_version;
    assert.equal(v, undefined);
  }
  if (withVersion.ok) {
    const v: string | undefined = withVersion.tracker_version;
    assert.equal(v, 'rev-1');
  }
});

test('ClaimResult — v2 failure variant discriminated-union narrowing', () => {
  const failed: ClaimResult = {
    ok: false,
    reason: 'version_conflict',
    detail: 'lost-tiebreak-to:other',
  };
  if (!failed.ok) {
    // Exhaustive v2 reason union — must match exactly.
    const reason: 'already_claimed' | 'version_conflict' | 'transient_error' =
      failed.reason;
    assert.equal(reason, 'version_conflict');
  }

  const alreadyClaimed: ClaimResult = {
    ok: false,
    reason: 'already_claimed',
    detail: 'forge:claimed-by:other',
  };
  assert.equal(alreadyClaimed.ok, false);

  const transient: ClaimResult = {
    ok: false,
    reason: 'transient_error',
    detail: 'timeout',
  };
  assert.equal(transient.ok, false);
});

test('ClaimFailureReason — escape-hatch guard rejects v1 state_changed', () => {
  // @ts-expect-error — 'state_changed' was removed in v2 (FORGE-72).
  const v1Leak: ClaimResult = { ok: false, reason: 'state_changed' };
  void v1Leak;

  // @ts-expect-error — arbitrary strings are not assignable to ClaimFailureReason.
  const arbitrary: ClaimFailureReason = 'wat';
  void arbitrary;
});

test('ClaimResult — conformance fixture exercises both ok variants at runtime', () => {
  // AC bullet: "Conformance suite fixtures cover both Result.ok=true variants
  // ({ ok: true } and { ok: true, tracker_version: '...' })". The fixture
  // helper lives in test/fixtures/trackers/conformance.ts and is invoked here
  // so the assertion machinery is actually executed each run.
  runClaimResultUnionFixture();
});

test('ClaimFailureReason — exhaustiveness sentinel', () => {
  function describe(reason: ClaimFailureReason): string {
    switch (reason) {
      case 'already_claimed':
        return 'a';
      case 'version_conflict':
        return 'v';
      case 'transient_error':
        return 't';
      default: {
        // If a new reason is added to the union without updating this switch,
        // the assignment below fails the typecheck — `never` widens.
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }
  assert.equal(describe('version_conflict'), 'v');
  assert.equal(describe('already_claimed'), 'a');
  assert.equal(describe('transient_error'), 't');
});
