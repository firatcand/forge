// Integration tests for NotionTracker.
//
// Gated by FORGE_E2E_NOTION=1 — skipped by default. Requires:
//   - A throwaway Notion database with the schema documented in
//     docs/adapters/notion.md (Name title, forge_task_id / forge_claimed_by /
//     forge_blocked_by / forge_owner_type / forge_acceptance rich_text,
//     `state` status with options Todo/In Progress/In Review/Done/Cancelled/Blocked)
//   - env var FORGE_E2E_NOTION_DATABASE_ID
//   - NOTION_TOKEN exported in the shell so the spawned MCP server can auth
//
// The test creates one page, exercises the lifecycle, archives it on cleanup.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  NotionTracker,
  createStdioMcpCall,
  type Logger,
  type StdioMcpHandle,
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

let handle: StdioMcpHandle | undefined;

function makeTracker(): NotionTracker {
  if (handle === undefined) {
    handle = createStdioMcpCall({
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
    });
  }
  const config: NotionTrackerConfig = {
    type: 'notion',
    config: {
      database_id: DATABASE_ID,
      mcp_command: ['npx', '-y', '@notionhq/notion-mcp-server'],
      mcp_env: {},
    },
  };
  return new NotionTracker(config, noopLogger(), { mcp: handle.call });
}

after(async () => {
  await handle?.close();
});

test(
  'integration: full lifecycle createIssue → claim → updateState → comment → releaseClaim → updateState(done)',
  { skip: skip ? 'FORGE_E2E_NOTION!=1 or FORGE_E2E_NOTION_DATABASE_ID unset' : false },
  async () => {
    const tracker = makeTracker();

    const health = await tracker.healthCheck();
    assert.equal(health.ok, true, `notion MCP not healthy: ${health.detail}`);

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
      await tracker.releaseClaim(pageId);
      await tracker.updateState(pageId, 'done');

      const reFetch = await tracker.listActiveIssues();
      assert.equal(
        reFetch.find((i) => i.id === pageId),
        undefined,
        'done page should be filtered out of listActiveIssues',
      );
    } finally {
      // Archive the test page so reruns are clean. notion-update-page with
      // archived: true is the closest thing to a delete.
      await handle?.call('notion-update-page', {
        page_id: pageId,
        archived: true,
      });
    }
  },
);
