// Integration tests for GitHubTracker.
//
// Gated by FORGE_E2E_GITHUB=1 — skipped by default. Requires:
//   - `gh auth login` completed on host
//   - env var FORGE_E2E_REPO (e.g. firatcand/forge-test-fixtures)
//   - the repo MUST be a throwaway fixture; tests create + delete issues
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execa } from 'execa';

import { GitHubTracker, type Logger } from '../../../src/trackers/index.ts';
import type { GithubTrackerConfig } from '../../../src/schemas/settings.ts';

const E2E_ENABLED = process.env.FORGE_E2E_GITHUB === '1';
const REPO = process.env.FORGE_E2E_REPO ?? '';

const skip = !E2E_ENABLED || REPO.length === 0;

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeTracker(): GitHubTracker {
  const config: GithubTrackerConfig = {
    type: 'github',
    config: { repo: REPO },
  };
  return new GitHubTracker(config, noopLogger());
}

async function ghDeleteIssue(number: number): Promise<void> {
  try {
    await execa('gh', [
      'api',
      `repos/${REPO}/issues/${number}`,
      '--method',
      'DELETE',
    ]);
  } catch {
    // Best-effort cleanup; ignore.
  }
}

test('integration: full lifecycle createProject → createIssue → claim → updateState → comment → close', {
  skip: skip ? 'FORGE_E2E_GITHUB!=1 or FORGE_E2E_REPO unset' : false,
}, async () => {
  const tracker = makeTracker();

  // Health first
  const health = await tracker.healthCheck();
  assert.equal(health.ok, true, `gh auth not healthy: ${health.detail}`);

  // Create a milestone (idempotency not assumed; suffix with timestamp)
  const milestoneName = `forge-e2e-${Date.now()}`;
  const project = await tracker.createProject(milestoneName, 'forge e2e');
  assert.ok(project.id);
  assert.ok(project.url);

  // Create issue with footers
  const forgeTaskId = `FORGE-E2E-${Date.now()}`;
  const issue = await tracker.createIssue({
    title: `[e2e] ${forgeTaskId}`,
    body: 'integration test body',
    forgeTaskId,
    ownerType: 'backend-dev',
    acceptance: ['must round-trip'],
    dependsOn: [],
  });

  const issueNumber = Number(issue.id);
  try {
    assert.equal(issue.forgeTaskId, forgeTaskId);

    // Round-trip via listActiveIssues
    const listed = await tracker.listActiveIssues();
    const found = listed.find((i) => i.id === issue.id);
    assert.ok(found, 'issue should appear in listActiveIssues');
    assert.equal(found?.forgeTaskId, forgeTaskId);

    // Claim
    const claim = await tracker.claim(issue.id, 'e2e-orchestrator');
    assert.equal(claim.ok, true);

    // Update state
    await tracker.updateState(issue.id, 'in_progress');
    await tracker.updateState(issue.id, 'in_review');

    // Comment
    await tracker.comment(issue.id, 'integration comment');

    // Release + close
    await tracker.releaseClaim(issue.id, 'e2e-orchestrator');
    await tracker.updateState(issue.id, 'done');
  } finally {
    await ghDeleteIssue(issueNumber);
  }
});

test('integration: concurrent claim — exactly one orchestrator wins', {
  skip: skip ? 'FORGE_E2E_GITHUB!=1 or FORGE_E2E_REPO unset' : false,
}, async () => {
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
  const issueNumber = Number(issue.id);

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
  } finally {
    await ghDeleteIssue(issueNumber);
  }
});

test('integration: setBlockedBy round-trips through listActiveIssues', {
  skip: skip ? 'FORGE_E2E_GITHUB!=1 or FORGE_E2E_REPO unset' : false,
}, async () => {
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
    const listed = await tracker.listActiveIssues();
    const reloadedB = listed.find((i) => i.id === issueB.id);
    assert.ok(reloadedB);
    assert.deepEqual(reloadedB?.blockerIds, [issueA.id]);
  } finally {
    await ghDeleteIssue(Number(issueA.id));
    await ghDeleteIssue(Number(issueB.id));
  }
});

test('integration: claim with full UUIDv7 runId succeeds — label fits under 50-char GitHub cap (FORGE-82)', {
  skip: skip ? 'FORGE_E2E_GITHUB!=1 or FORGE_E2E_REPO unset' : false,
}, async () => {
  const tracker = makeTracker();
  const runId = crypto.randomUUID();
  assert.equal(runId.length, 36, 'runId must be 36 chars (UUID with hyphens)');

  const forgeTaskId = `FORGE-82-E2E-${Date.now()}`;
  const issue = await tracker.createIssue({
    title: `[e2e label-cap] ${forgeTaskId}`,
    body: 'FORGE-82 label-cap integration test',
    forgeTaskId,
    ownerType: 'backend-dev',
    acceptance: [],
    dependsOn: [],
  });
  const issueNumber = Number(issue.id);

  try {
    const result = await tracker.claim(issue.id, runId);
    assert.equal(result.ok, true, `claim failed: ${JSON.stringify(result)}`);

    // Probe actual labels on GitHub to assert the stored form is under 50 chars
    const labelsJson = await execa('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      REPO,
      '--json',
      'labels',
    ]);
    const parsed = JSON.parse(labelsJson.stdout) as { labels: Array<{ name: string }> };
    const claimLabels = parsed.labels
      .map((l) => l.name)
      .filter((n) => n.startsWith('forge:claimed-by:'));
    assert.ok(claimLabels.length > 0, 'expected at least one forge:claimed-by:* label');
    for (const label of claimLabels) {
      assert.ok(
        label.length <= 50,
        `label "${label}" is ${label.length} chars — exceeds 50-char GitHub cap`,
      );
    }

    await tracker.releaseClaim(issue.id, runId);
  } finally {
    await ghDeleteIssue(issueNumber);
  }
});
