import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Tracker,
  Issue,
  ClaimResult,
  IssueState,
  CreateIssuePayload,
} from '../../../src/trackers/index.ts';

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
  claim: async (_id: string, _agentId: string) => ({ ok: true }) as ClaimResult,
  releaseClaim: async () => {},
  updateState: async () => {},
  comment: async () => {},
  createProject: async (_name: string) => ({
    id: 'p_1',
    url: 'https://github.com/foo/bar',
  }),
  createIssue: async (_p: CreateIssuePayload) => fakeIssue,
  setBlockedBy: async () => {},
  healthCheck: async () => ({ ok: true }),
};

// @ts-expect-error — interface requires all 9 methods
const _missingMethods: Tracker = {
  type: 'github',
  listActiveIssues: async () => [],
};
void _missingMethods;

test('Tracker interface compiles with all 9 methods implemented', async () => {
  const issues = await fakeAdapter.listActiveIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, 't_1');

  const claimed = await fakeAdapter.claim('FORGE-1', 'orc-1');
  assert.equal(claimed.ok, true);

  // Discriminated-union narrowing
  const failed: ClaimResult = {
    ok: false,
    reason: 'state_changed',
    detail: 'issue moved to in_review',
  };
  if (!failed.ok) {
    const reason: 'already_claimed' | 'state_changed' | 'transient_error' =
      failed.reason;
    assert.equal(reason, 'state_changed');
  }

  assert.equal(fakeStates.length, 6);
  assert.equal(fakePayload.forgeTaskId, 'FORGE-1');
});
