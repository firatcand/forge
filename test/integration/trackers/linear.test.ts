// Integration tests for LinearTracker.
//
// Gated by FORGE_E2E_LINEAR=1 — skipped by default. Requires:
//   - LINEAR_API_KEY     valid Personal API Key (linear.app/settings/account/security)
//   - FORGE_E2E_LINEAR_TEAM_ID  UUID of a throwaway Linear team
//
// The team MUST be a throwaway fixture; tests create issues, projects, and
// labels. Issues are archived in `finally` blocks but Linear retains them
// (no hard-delete API exposed) — use a dedicated test team.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinearClient } from '@linear/sdk';

import {
  LinearTracker,
  wrapLinearClient,
  type Logger,
} from '../../../src/trackers/index.ts';
import type { LinearTrackerConfig } from '../../../src/schemas/settings.ts';

const E2E_ENABLED = process.env.FORGE_E2E_LINEAR === '1';
const TEAM_ID = process.env.FORGE_E2E_LINEAR_TEAM_ID ?? '';
const API_KEY = process.env.LINEAR_API_KEY ?? '';

const skip = !E2E_ENABLED || TEAM_ID.length === 0 || API_KEY.length === 0;
const skipReason =
  'FORGE_E2E_LINEAR!=1 or FORGE_E2E_LINEAR_TEAM_ID/LINEAR_API_KEY unset';

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeTracker(): LinearTracker {
  const config: LinearTrackerConfig = {
    type: 'linear',
    config: { team_id: TEAM_ID },
  };
  // Build via the real wrapper so we exercise the SDK end-to-end.
  const client = wrapLinearClient(new LinearClient({ apiKey: API_KEY }));
  return new LinearTracker(config, noopLogger(), { client });
}

async function archiveIssueBestEffort(issueId: string): Promise<void> {
  try {
    const client = new LinearClient({ apiKey: API_KEY });
    await client.archiveIssue(issueId);
  } catch {
    // Best-effort cleanup; intentionally silent.
  }
}

test(
  'integration: full lifecycle createProject → createIssue → list → claim → updateState → comment → done',
  { skip: skip ? skipReason : false },
  async () => {
    const tracker = makeTracker();

    const health = await tracker.healthCheck();
    assert.equal(health.ok, true, `health not ok: ${health.detail}`);

    const projectName = `forge-e2e-${Date.now()}`;
    const project = await tracker.createProject(projectName, 'forge integration test');
    assert.ok(project.id);
    assert.ok(project.url);

    const forgeTaskId = `FORGE-E2E-${Date.now()}`;
    const issue = await tracker.createIssue({
      title: `[e2e] ${forgeTaskId}`,
      body: 'integration test body',
      forgeTaskId,
      ownerType: 'backend-dev',
      acceptance: ['round-trips'],
      dependsOn: [],
    });

    try {
      assert.equal(issue.forgeTaskId, forgeTaskId);

      // Round-trip: footer-encoded fields survive list → toIssue parse.
      const listed = await tracker.listActiveIssues();
      const found = listed.find((i) => i.id === issue.id);
      assert.ok(found, 'created issue should appear in listActiveIssues');
      assert.equal(found?.forgeTaskId, forgeTaskId);

      // Claim
      const claimResult = await tracker.claim(issue.id, 'e2e-orchestrator');
      assert.equal(claimResult.ok, true, 'first claim should succeed');

      // State transitions
      await tracker.updateState(issue.id, 'in_progress');
      await tracker.updateState(issue.id, 'in_review');

      // Comment
      await tracker.comment(issue.id, 'forge integration comment');

      // Release + close
      await tracker.releaseClaim(issue.id, 'e2e-orchestrator');
      await tracker.updateState(issue.id, 'done');
    } finally {
      await archiveIssueBestEffort(issue.id);
    }
  },
);

test(
  'integration: concurrent claim — exactly one orchestrator wins',
  { skip: skip ? skipReason : false },
  async () => {
    const tracker = makeTracker();
    const forgeTaskId = `FORGE-E2E-RACE-${Date.now()}`;
    const issue = await tracker.createIssue({
      title: `[e2e race] ${forgeTaskId}`,
      body: 'race test',
      forgeTaskId,
      ownerType: 'backend-dev',
      acceptance: [],
      dependsOn: [],
    });

    try {
      const [a, b] = await Promise.all([
        tracker.claim(issue.id, 'agent-aaa'),
        tracker.claim(issue.id, 'agent-zzz'),
      ]);

      const winners = [a, b].filter((r) => r.ok === true);
      assert.equal(
        winners.length,
        1,
        `expected exactly one winner, got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
      );

      // Loser is either already_claimed or version_conflict (via tiebreak)
      const loser = a.ok ? b : a;
      if (!loser.ok) {
        assert.match(loser.reason, /already_claimed|version_conflict/);
      }
    } finally {
      await archiveIssueBestEffort(issue.id);
    }
  },
);

test(
  'integration: setBlockedBy writes footer AND native blocks relation',
  { skip: skip ? skipReason : false },
  async () => {
    const tracker = makeTracker();
    const taskA = `FORGE-E2E-A-${Date.now()}`;
    const taskB = `FORGE-E2E-B-${Date.now()}`;

    const issueA = await tracker.createIssue({
      title: `[e2e] ${taskA}`,
      body: 'A',
      forgeTaskId: taskA,
      ownerType: 'backend-dev',
      acceptance: [],
      dependsOn: [],
    });
    const issueB = await tracker.createIssue({
      title: `[e2e] ${taskB}`,
      body: 'B',
      forgeTaskId: taskB,
      ownerType: 'backend-dev',
      acceptance: [],
      dependsOn: [],
    });

    try {
      await tracker.setBlockedBy(issueB.id, issueA.id);

      // Footer round-trip via listActiveIssues
      const listed = await tracker.listActiveIssues();
      const reloadedB = listed.find((i) => i.id === issueB.id);
      assert.ok(reloadedB);
      assert.deepEqual(reloadedB?.blockerIds, [issueA.id]);

      // Idempotency: second call must not throw and must not duplicate footer
      await tracker.setBlockedBy(issueB.id, issueA.id);
      const listed2 = await tracker.listActiveIssues();
      const reloadedB2 = listed2.find((i) => i.id === issueB.id);
      assert.deepEqual(reloadedB2?.blockerIds, [issueA.id]);
    } finally {
      await archiveIssueBestEffort(issueA.id);
      await archiveIssueBestEffort(issueB.id);
    }
  },
);
