// Conformance suite for the Tracker interface (v2 contract).
//
// v2 changes (FORGE-72, 2026-05-15):
//   - claim(issueId, runId)        — second arg renamed from agentId
//   - releaseClaim(issueId, runId) — second arg added (stub-ignored by
//     adapters in this task; targeted removal lands in FORGE-76/77)
//   - ClaimFailureReason drops 'state_changed', adds 'version_conflict'
//   - ClaimResult.ok=true gains optional tracker_version: string
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

import type { ClaimResult, Tracker } from '../../../src/trackers/index.ts';

export interface ConformanceInputs {
  /** An issue ID the tracker can lookup successfully (must exist in mocks). */
  existingIssueId: string;
  /** A blocker ID the tracker accepts for setBlockedBy. */
  blockerId: string;
  /** Run ID used for claim/releaseClaim. Must not yet hold a claim on existingIssueId. */
  runId?: string;
}

/**
 * Exercise every method on the Tracker interface and assert each response
 * matches the v2 interface contract. Caller is responsible for constructing
 * a tracker whose mock layer responds successfully to all 9 calls.
 */
export async function runTrackerConformance(
  tracker: Tracker,
  inputs: ConformanceInputs,
): Promise<void> {
  const runId = inputs.runId ?? 'conformance-run';

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

  // 3. claim — returns v2 ClaimResult discriminated union
  const claim = await tracker.claim(inputs.existingIssueId, runId);
  assertClaimResultShape(claim);

  // 4. releaseClaim — void return; v2 takes (issueId, runId)
  await tracker.releaseClaim(inputs.existingIssueId, runId);

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

/**
 * Validate a ClaimResult against the v2 contract. Asserts:
 *   - ok must be boolean
 *   - if !ok: reason is one of the v2 ClaimFailureReason values
 *   - if ok: tracker_version, when present, is a non-empty string
 *
 * The 'state_changed' reason from v1 is intentionally rejected — any
 * adapter still emitting it fails this check, which is what makes the
 * pre-patch code fail the conformance suite (AC bullet 1).
 */
function assertClaimResultShape(claim: ClaimResult): void {
  assert.equal(typeof claim.ok, 'boolean', 'ClaimResult.ok must be boolean');
  if (claim.ok) {
    if (claim.tracker_version !== undefined) {
      assert.equal(
        typeof claim.tracker_version,
        'string',
        'ClaimResult.tracker_version must be string when present',
      );
      assert.ok(
        claim.tracker_version.length > 0,
        'ClaimResult.tracker_version must be non-empty when present',
      );
    }
    return;
  }
  assert.ok(
    ['already_claimed', 'version_conflict', 'transient_error'].includes(claim.reason),
    `ClaimResult.reason '${claim.reason}' must be a valid v2 ClaimFailureReason`,
  );
}

/**
 * Exercise both `Result.ok=true` variants — `{ ok: true }` and
 * `{ ok: true, tracker_version: '...' }` — against the v2 shape assertion.
 *
 * Satisfies AC bullet: "Conformance suite fixtures cover both Result.ok=true
 * variants". Adapters emit only the bare `{ ok: true }` in this task; the
 * tracker_version variant is exercised here so the assertion machinery
 * itself is verified.
 */
export function runClaimResultUnionFixture(): void {
  const bare: ClaimResult = { ok: true };
  assertClaimResultShape(bare);

  const withVersion: ClaimResult = { ok: true, tracker_version: 'rev-abc-123' };
  assertClaimResultShape(withVersion);

  const conflicting: ClaimResult = {
    ok: false,
    reason: 'version_conflict',
    detail: 'lost-tiebreak-to:other',
  };
  assertClaimResultShape(conflicting);

  const alreadyClaimed: ClaimResult = {
    ok: false,
    reason: 'already_claimed',
    detail: 'forge:claimed-by:other',
  };
  assertClaimResultShape(alreadyClaimed);

  const transient: ClaimResult = {
    ok: false,
    reason: 'transient_error',
    detail: 'timeout',
  };
  assertClaimResultShape(transient);
}
