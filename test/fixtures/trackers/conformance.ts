// Conformance suite for the Tracker interface.
//
// Each adapter has its own provider-specific mocking story (GhExec for
// GitHubTracker, LinearSdkLike for LinearTracker), so this helper is
// generic over the wired-up Tracker — callers construct a tracker with
// all 9 methods configured for happy-path responses, then pass it here.
//
// This is the runtime backing for AC bullet 1: "All Tracker interface
// methods implemented; pass adapter conformance suite". The TypeScript
// parameter type itself enforces the structural contract — if a future
// adapter drops a method, this file fails to compile when imported.

import assert from 'node:assert/strict';

import type { Tracker } from '../../../src/trackers/index.ts';

export interface ConformanceInputs {
  /** An issue ID the tracker can lookup successfully (must exist in mocks). */
  existingIssueId: string;
  /** A blocker ID the tracker accepts for setBlockedBy. */
  blockerId: string;
  /** Agent ID used for claim. Must not yet hold a claim on existingIssueId. */
  agentId?: string;
}

/**
 * Exercise every method on the Tracker interface and assert each response
 * matches the interface contract. Caller is responsible for constructing
 * a tracker whose mock layer responds successfully to all 9 calls.
 */
export async function runTrackerConformance(
  tracker: Tracker,
  inputs: ConformanceInputs,
): Promise<void> {
  const agentId = inputs.agentId ?? 'conformance-agent';

  // 1. healthCheck — never throws
  const health = await tracker.healthCheck();
  assert.equal(typeof health.ok, 'boolean', 'healthCheck: ok must be boolean');
  if (health.detail !== undefined) {
    assert.equal(typeof health.detail, 'string', 'healthCheck: detail must be string when set');
  }

  // 2. listActiveIssues — returns Issue[]
  const issues = await tracker.listActiveIssues();
  assert.ok(Array.isArray(issues), 'listActiveIssues must return an array');
  for (const i of issues) {
    assert.equal(typeof i.id, 'string', 'Issue.id must be string');
    assert.equal(typeof i.identifier, 'string', 'Issue.identifier must be string');
    assert.equal(typeof i.title, 'string', 'Issue.title must be string');
    assert.ok(
      ['todo', 'in_progress', 'in_review', 'done', 'cancelled', 'blocked'].includes(
        i.state,
      ),
      `Issue.state '${i.state}' must be a valid IssueState`,
    );
    assert.ok(Array.isArray(i.blockerIds), 'Issue.blockerIds must be array');
  }

  // 3. claim — returns ClaimResult discriminated union
  const claim = await tracker.claim(inputs.existingIssueId, agentId);
  assert.equal(typeof claim.ok, 'boolean', 'ClaimResult.ok must be boolean');
  if (!claim.ok) {
    assert.ok(
      ['already_claimed', 'state_changed', 'transient_error'].includes(claim.reason),
      `ClaimResult.reason '${claim.reason}' must be a valid ClaimFailureReason`,
    );
  }

  // 4. releaseClaim — void return
  await tracker.releaseClaim(inputs.existingIssueId);

  // 5. updateState — void return
  await tracker.updateState(inputs.existingIssueId, 'in_progress');

  // 6. comment — void return
  await tracker.comment(inputs.existingIssueId, 'conformance test comment');

  // 7. createProject — returns { id, url }
  const project = await tracker.createProject(
    'conformance-test-project',
    'created by tracker conformance suite',
  );
  assert.equal(typeof project.id, 'string', 'createProject.id must be string');
  assert.equal(typeof project.url, 'string', 'createProject.url must be string');

  // 8. createIssue — returns Issue
  const newIssue = await tracker.createIssue({
    title: 'conformance test issue',
    body: 'body content',
    forgeTaskId: 'P0-CONF-01',
    ownerType: 'backend-dev',
    acceptance: ['something'],
    dependsOn: [],
  });
  assert.equal(typeof newIssue.id, 'string', 'createIssue: Issue.id must be string');
  assert.equal(
    typeof newIssue.identifier,
    'string',
    'createIssue: Issue.identifier must be string',
  );

  // 9. setBlockedBy — void return
  await tracker.setBlockedBy(inputs.existingIssueId, inputs.blockerId);

  // Type-level guard: the `tracker.type` discriminator exists and is one of
  // the three known values. Caught at compile time by `Tracker.type` literal
  // union; runtime is just defensive.
  assert.ok(
    ['linear', 'github', 'notion'].includes(tracker.type),
    `Tracker.type '${tracker.type}' must be a known TrackerType`,
  );
}
