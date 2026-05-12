// Canned Notion MCP tool result payloads + error shapes for NotionTracker
// unit tests. Each fixture mirrors what the Notion MCP server returns as the
// `content[0].text` JSON body of a CallToolResult.

import type { McpToolResult } from '../../../src/trackers/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function okResult(body: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}

export function okEmpty(): McpToolResult {
  return { content: [] };
}

export function errorResult(notionError: {
  code: string;
  message: string;
  status?: number;
  retry_after?: number;
}): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ object: 'error', ...notionError }),
      },
    ],
  };
}

// Constructs a McpError-shaped throwable (the SDK throws these on
// transport-level failures — we don't import the real class to keep tests
// independent of internal SDK shape).
export function makeMcpError(
  code: number,
  message: string,
  data?: unknown,
): Error & { code: number; data?: unknown } {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

// ─── Page builders ───────────────────────────────────────────────────────────

interface BuildPageOpts {
  id?: string;
  title?: string;
  state?: string;
  taskId?: string;
  claimedBy?: string;
  blockedBy?: string;
  ownerType?: string;
  acceptance?: string;
  lastEditedTime?: string;
  archived?: boolean;
  url?: string;
}

export function buildPage(opts: BuildPageOpts = {}): Record<string, unknown> {
  const id = opts.id ?? '11112222-3333-4444-5555-666677778888';
  return {
    object: 'page',
    id,
    url: opts.url ?? `https://www.notion.so/${id.replace(/-/g, '')}`,
    archived: opts.archived ?? false,
    last_edited_time: opts.lastEditedTime ?? '2026-05-12T00:00:00.000Z',
    properties: {
      Name: rt('title', opts.title ?? 'Untitled'),
      forge_task_id: rt('rich_text', opts.taskId ?? ''),
      forge_claimed_by: rt('rich_text', opts.claimedBy ?? ''),
      state: statusProp(opts.state ?? 'Todo'),
      forge_blocked_by: rt('rich_text', opts.blockedBy ?? ''),
      forge_owner_type: rt('rich_text', opts.ownerType ?? ''),
      forge_acceptance: rt('rich_text', opts.acceptance ?? ''),
    },
  };
}

function rt(
  kind: 'title' | 'rich_text',
  text: string,
): Record<string, unknown> {
  const items =
    text.length === 0 ? [] : [{ plain_text: text, text: { content: text } }];
  return kind === 'title'
    ? { type: 'title', title: items }
    : { type: 'rich_text', rich_text: items };
}

function statusProp(name: string): Record<string, unknown> {
  return { type: 'status', status: name === '' ? null : { name } };
}

// ─── Common fixtures ─────────────────────────────────────────────────────────

export const pageEmpty = buildPage();

export const pageClaimedByOther = buildPage({
  id: 'aaaa1111-2222-3333-4444-555566667777',
  claimedBy: 'agent-other',
  state: 'In Progress',
});

export const pageClaimedByMe = buildPage({
  id: 'aaaa1111-2222-3333-4444-555566667777',
  claimedBy: 'agent-me',
  state: 'In Progress',
});

export const pageArchived = buildPage({
  id: 'bbbb1111-2222-3333-4444-555566667777',
  archived: true,
});

export const pageWithFooters = buildPage({
  title: 'Sample',
  state: 'In Progress',
  taskId: 'FORGE-99',
  blockedBy: '11112222-3333-4444-5555-666677778881,11112222-3333-4444-5555-666677778882',
  ownerType: 'backend-dev',
});

export const pageWithoutForgeTaskId = buildPage({
  id: 'cccc1111-2222-3333-4444-555566667777',
  title: 'Outside-forge page',
});

// Database query response (listActiveIssues fixture).
export const databaseQueryActive = {
  results: [
    buildPage({
      id: '11112222-3333-4444-5555-666677778881',
      title: 'Active task A',
      state: 'Todo',
      taskId: 'FORGE-T1',
    }),
    buildPage({
      id: '11112222-3333-4444-5555-666677778882',
      title: 'Active task B',
      state: 'In Progress',
      taskId: 'FORGE-T2',
    }),
    buildPage({
      id: '11112222-3333-4444-5555-666677778883',
      title: 'Done task — filtered out',
      state: 'Done',
      taskId: 'FORGE-T3',
    }),
    buildPage({
      id: '11112222-3333-4444-5555-666677778884',
      title: 'Cancelled task — filtered out',
      state: 'Cancelled',
      taskId: 'FORGE-T4',
    }),
    buildPage({
      id: '11112222-3333-4444-5555-666677778885',
      title: 'Archived',
      state: 'Todo',
      archived: true,
    }),
  ],
  has_more: false,
  next_cursor: null,
};

// Paginated response: page 1 has has_more=true, cursor='page2'.
export const databaseQueryPaged1 = {
  results: [
    buildPage({
      id: '11112222-3333-4444-5555-66667777aaa1',
      title: 'Page-1 task',
      state: 'Todo',
    }),
  ],
  has_more: true,
  next_cursor: 'cursor-page-2',
};

export const databaseQueryPaged2 = {
  results: [
    buildPage({
      id: '11112222-3333-4444-5555-66667777aaa2',
      title: 'Page-2 task',
      state: 'Todo',
    }),
  ],
  has_more: false,
  next_cursor: null,
};

export const newDatabase = {
  object: 'database',
  id: 'dddd1111-2222-3333-4444-555566667777',
  url: 'https://www.notion.so/dddd11112222333344445555666677777',
};

// Response of API-retrieve-a-database for our fixture database. Used to
// resolve the data_source_id needed by API-query-data-source / API-post-page.
export const DATA_SOURCE_ID = '88888888-aaaa-bbbb-cccc-dddddddddddd';
export const databaseInfo = {
  object: 'database',
  id: '99999999-aaaa-bbbb-cccc-dddddddddddd',
  data_sources: [{ id: DATA_SOURCE_ID, name: 'forge fixture' }],
};
