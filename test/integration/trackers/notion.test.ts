// Integration tests for NotionTracker.
//
// Gated by FORGE_E2E_NOTION=1 — skipped by default. Requires:
//   - A throwaway Notion database with the schema documented in
//     docs/adapters/notion.md (Name title, forge_task_id / forge_claimed_by /
//     forge_blocked_by / forge_owner_type / forge_acceptance rich_text,
//     `state` status with options Todo/In Progress/In Review/Done/Cancelled/Blocked)
//   - env var FORGE_E2E_NOTION_DATABASE_ID
//   - the Notion CLI (`ntn`) installed and authenticated (`ntn login`) —
//     FORGE-117 replaced the MCP transport; no NOTION_TOKEN plumbing.
//
// The test creates one page, exercises the lifecycle, archives it on cleanup.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NOTION_API_VERSION,
  NotionTracker,
  defaultNtnExec,
  type Logger,
} from '../../../src/trackers/index.ts';
import type { NotionTrackerConfig } from '../../../src/schemas/settings.ts';

const E2E_ENABLED = process.env.FORGE_E2E_NOTION === '1';
const DATABASE_ID = process.env.FORGE_E2E_NOTION_DATABASE_ID ?? '';
const skip = !E2E_ENABLED || DATABASE_ID.length === 0;

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeTracker(): NotionTracker {
  const config: NotionTrackerConfig = {
    type: 'notion',
    config: { database_id: DATABASE_ID },
  };
  return new NotionTracker(config, noopLogger(), { ntn: defaultNtnExec });
}

test(
  'integration: full lifecycle createIssue → claim → updateState → comment → updateIssueBody → releaseClaim → updateState(done)',
  { skip: skip ? 'FORGE_E2E_NOTION!=1 or FORGE_E2E_NOTION_DATABASE_ID unset' : false },
  async () => {
    const tracker = makeTracker();

    const health = await tracker.healthCheck();
    assert.equal(health.ok, true, `ntn CLI not healthy: ${health.detail}`);

    const forgeTaskId = `FORGE-E2E-${Date.now()}`;
    const issue = await tracker.createIssue({
      title: `[e2e] ${forgeTaskId}`,
      body: 'integration test body',
      forgeTaskId,
      ownerType: 'backend-dev',
      acceptance: ['must round-trip'],
      dependsOn: [],
    });
    assert.equal(issue.forgeTaskId, forgeTaskId);

    const pageId = issue.id;
    try {
      const claim = await tracker.claim(pageId, 'e2e-agent');
      assert.equal(claim.ok, true);

      await tracker.updateState(pageId, 'in_progress');
      await tracker.comment(pageId, 'forge e2e: started');

      // FORGE-117: body replace — non-atomic delete+append; forgeTaskId is a
      // page property and must survive untouched.
      await tracker.updateIssueBody(pageId, 'replaced body via ntn transport');
      const afterBodyUpdate = await tracker.listActiveIssues();
      assert.equal(
        afterBodyUpdate.find((i) => i.id === pageId)?.forgeTaskId,
        forgeTaskId,
        'forgeTaskId must survive updateIssueBody',
      );

      await tracker.releaseClaim(pageId, 'e2e-agent');
      await tracker.updateState(pageId, 'done');

      const reFetch = await tracker.listActiveIssues();
      assert.equal(
        reFetch.find((i) => i.id === pageId),
        undefined,
        'done page should be filtered out of listActiveIssues',
      );
    } finally {
      // Archive the test page so reruns are clean.
      await defaultNtnExec(
        [
          'api',
          `v1/pages/${pageId}`,
          '-X',
          'PATCH',
          '--notion-version',
          NOTION_API_VERSION,
        ],
        { input: JSON.stringify({ archived: true }) },
      );
    }
  },
);
