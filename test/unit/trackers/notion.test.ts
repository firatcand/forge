import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAIM_SETTLE_MS,
  NOTION_LIST_LIMIT,
  NOTION_RAW_PAGE_CAP,
  NotionTracker,
  TrackerError,
  classifyNotionError,
  parseNotionPageId,
  readRichText,
  readStatus,
  readTitle,
  type Logger,
  type McpCall,
  type McpToolResult,
} from '../../../src/trackers/index.ts';
import type { NotionTrackerConfig } from '../../../src/schemas/settings.ts';
import {
  DATA_SOURCE_ID,
  buildPage,
  databaseInfo,
  databaseQueryActive,
  databaseQueryPaged1,
  databaseQueryPaged2,
  errorResult,
  makeMcpError,
  newDatabase,
  okEmpty,
  okResult,
  pageArchived,
  pageClaimedByMe,
  pageClaimedByOther,
  pageEmpty,
  pageWithFooters,
  pageWithoutForgeTaskId,
} from '../../fixtures/trackers/notion-responses.ts';

// ─── Test infra ──────────────────────────────────────────────────────────────

const DB_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';

const notionConfig: NotionTrackerConfig = {
  type: 'notion',
  config: {
    database_id: DB_ID,
    mcp_command: ['npx', '-y', '@notionhq/notion-mcp-server'],
    mcp_env: {},
  },
};

function noopLogger(): Logger & {
  warnings: Array<{ event: string; fields?: unknown }>;
} {
  const warnings: Array<{ event: string; fields?: unknown }> = [];
  return {
    debug: () => {},
    info: () => {},
    warn: (event, fields) => {
      warnings.push({ event, fields });
    },
    error: () => {},
    warnings,
  };
}

type MockStep = McpToolResult | Error;

class MockMcp {
  private idx = 0;
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  constructor(private readonly steps: MockStep[]) {}
  call: McpCall = async (tool, args) => {
    this.calls.push({ tool, args });
    const step = this.steps[this.idx++];
    if (step === undefined) {
      throw new Error(`MockMcp: unexpected call #${this.idx}: ${tool}`);
    }
    if (step instanceof Error) throw step;
    return step;
  };
}

function makeTracker(steps: MockStep[]) {
  const mock = new MockMcp(steps);
  const logger = noopLogger();
  const sleepCalls: number[] = [];
  const tracker = new NotionTracker(notionConfig, logger, {
    mcp: mock.call,
    retry: { sleep: async () => {} },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
  return { tracker, mock, logger, sleepCalls };
}

// ─── classifyNotionError ─────────────────────────────────────────────────────

test('classifyNotionError: unauthorized → AUTH', () => {
  const hint = classifyNotionError({ code: 'unauthorized', message: 'bad token' });
  assert.equal(hint.code, 'AUTH');
});

test('classifyNotionError: restricted_resource → AUTH (before NOT_FOUND)', () => {
  const hint = classifyNotionError({
    code: 'restricted_resource',
    message: 'access denied',
  });
  assert.equal(hint.code, 'AUTH');
});

test('classifyNotionError: object_not_found → NOT_FOUND', () => {
  const hint = classifyNotionError({
    code: 'object_not_found',
    message: 'page gone',
  });
  assert.equal(hint.code, 'NOT_FOUND');
});

test('classifyNotionError: rate_limited carries retryAfterMs from retry_after', () => {
  const hint = classifyNotionError({
    code: 'rate_limited',
    message: 'slow down',
    retry_after: 5,
  });
  assert.equal(hint.code, 'RATE_LIMITED');
  assert.equal(hint.details?.retryAfterMs, 5000);
});

test('classifyNotionError: validation_error → VALIDATION (before CONFLICT)', () => {
  const hint = classifyNotionError({
    code: 'validation_error',
    message: 'thing already exists',
  });
  assert.equal(hint.code, 'VALIDATION');
});

test('classifyNotionError: conflict_error → CONFLICT', () => {
  const hint = classifyNotionError({
    code: 'conflict_error',
    message: 'concurrent edit',
  });
  assert.equal(hint.code, 'CONFLICT');
});

test('classifyNotionError: JSON-RPC ConnectionClosed → TRANSPORT', () => {
  const hint = classifyNotionError(makeMcpError(-32000, 'closed'));
  assert.equal(hint.code, 'TRANSPORT');
});

test('classifyNotionError: JSON-RPC RequestTimeout → TIMEOUT', () => {
  const hint = classifyNotionError(makeMcpError(-32001, 'timeout'));
  assert.equal(hint.code, 'TIMEOUT');
});

test('classifyNotionError: JSON-RPC ParseError → VALIDATION', () => {
  const hint = classifyNotionError(makeMcpError(-32700, 'parse'));
  assert.equal(hint.code, 'VALIDATION');
});

test('classifyNotionError: timeout in message → TIMEOUT fallback', () => {
  const hint = classifyNotionError(new Error('request timed out'));
  assert.equal(hint.code, 'TIMEOUT');
});

test('classifyNotionError: ECONNRESET in message → TRANSPORT fallback', () => {
  const hint = classifyNotionError(new Error('socket ECONNRESET'));
  assert.equal(hint.code, 'TRANSPORT');
});

test('classifyNotionError: unknown shape → UNKNOWN', () => {
  assert.equal(classifyNotionError('weird string').code, 'UNKNOWN');
  assert.equal(classifyNotionError(null).code, 'UNKNOWN');
  assert.equal(classifyNotionError(42).code, 'UNKNOWN');
});

test('classifyNotionError: McpError with embedded Notion error data → Notion wins (codex P2-4)', () => {
  // SDK can wrap a Notion provider error in a generic numeric JSON-RPC code.
  // Notion body takes precedence so adapter still maps object_not_found
  // → NOT_FOUND (drives version_conflict) instead of UNKNOWN (drives throw).
  const err = makeMcpError(-32603, 'tool failed', {
    object: 'error',
    code: 'object_not_found',
    message: 'page deleted',
  });
  const hint = classifyNotionError(err);
  assert.equal(hint.code, 'NOT_FOUND');
});

test('classifyNotionError: JSON-RPC numeric code used when no Notion body', () => {
  const err = makeMcpError(-32000, 'connection closed');
  assert.equal(classifyNotionError(err).code, 'TRANSPORT');
});

test('classifyNotionError: embedded rate_limited wrapped in JSON-RPC → RATE_LIMITED', () => {
  const err = makeMcpError(-32603, 'wrapped', {
    object: 'error',
    code: 'rate_limited',
    message: 'too many',
    retry_after: 3,
  });
  const hint = classifyNotionError(err);
  assert.equal(hint.code, 'RATE_LIMITED');
  assert.equal(hint.details?.retryAfterMs, 3000);
});

// ─── parseNotionPageId ───────────────────────────────────────────────────────

test('parseNotionPageId: accepts dashed UUID', () => {
  assert.equal(
    parseNotionPageId('11112222-3333-4444-5555-666677778888'),
    '11112222-3333-4444-5555-666677778888',
  );
});

test('parseNotionPageId: accepts undashed 32-char hex', () => {
  assert.equal(
    parseNotionPageId('11112222333344445555666677778888'),
    '11112222-3333-4444-5555-666677778888',
  );
});

test('parseNotionPageId: extracts UUID from full Notion URL', () => {
  assert.equal(
    parseNotionPageId(
      'https://www.notion.so/My-Page-11112222333344445555666677778888?source=copy_link',
    ),
    '11112222-3333-4444-5555-666677778888',
  );
});

test('parseNotionPageId: normalizes case', () => {
  assert.equal(
    parseNotionPageId('AAAA1111-2222-3333-4444-555566667777'),
    'aaaa1111-2222-3333-4444-555566667777',
  );
});

test('parseNotionPageId: throws VALIDATION on garbage', () => {
  assert.throws(
    () => parseNotionPageId('not-a-uuid'),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
});

// ─── Property accessors ──────────────────────────────────────────────────────

test('readRichText: returns concatenated plain_text', () => {
  assert.equal(readRichText(pageWithFooters as never, 'forge_task_id'), 'FORGE-99');
});

test('readRichText: returns empty when prop missing', () => {
  assert.equal(readRichText(pageEmpty as never, 'no_such_prop'), '');
});

test('readTitle: returns title text', () => {
  assert.equal(readTitle(pageWithFooters as never, 'Name'), 'Sample');
});

test('readStatus: returns status name', () => {
  assert.equal(readStatus(pageWithFooters as never, 'state'), 'In Progress');
});

test('readStatus: null when unset', () => {
  const p = buildPage({ state: '' });
  assert.equal(readStatus(p as never, 'state'), null);
});

// ─── healthCheck ─────────────────────────────────────────────────────────────

test('healthCheck: returns ok on successful get-users call', async () => {
  const { tracker, mock } = makeTracker([okResult({ results: [] })]);
  const r = await tracker.healthCheck();
  assert.equal(r.ok, true);
  assert.equal(mock.calls[0]?.tool, 'API-get-self');
});

test('healthCheck: returns ok:false on transport error; never throws', async () => {
  const { tracker } = makeTracker([makeMcpError(-32000, 'closed')]);
  const r = await tracker.healthCheck();
  assert.equal(r.ok, false);
  assert.ok(r.detail && r.detail.length > 0);
});

test('healthCheck: returns ok:false on AUTH error', async () => {
  const { tracker } = makeTracker([
    errorResult({ code: 'unauthorized', message: 'bad token' }),
  ]);
  const r = await tracker.healthCheck();
  assert.equal(r.ok, false);
  assert.match(r.detail ?? '', /AUTH/);
});

// ─── listActiveIssues ────────────────────────────────────────────────────────

test('listActiveIssues: maps pages → Issue[]; filters done/cancelled/archived', async () => {
  const { tracker } = makeTracker([
    okResult(databaseInfo),
    okResult(databaseQueryActive),
  ]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((i) => i.title),
    ['Active task A', 'Active task B'],
  );
  assert.equal(issues[0]?.forgeTaskId, 'FORGE-T1');
  assert.equal(issues[1]?.state, 'in_progress');
});

test('listActiveIssues: paginates via next_cursor', async () => {
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),
    okResult(databaseQueryPaged1),
    okResult(databaseQueryPaged2),
  ]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 2);
  // 1 db-info + 2 query calls
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[0]?.tool, 'API-retrieve-a-database');
  assert.equal(mock.calls[2]?.args.start_cursor, 'cursor-page-2');
  assert.equal(mock.calls[1]?.args.data_source_id, DATA_SOURCE_ID);
});

test('listActiveIssues: retries on RATE_LIMITED then succeeds', async () => {
  // The retry wraps the entire listActiveIssues body, including the lazy
  // data-source resolve. So the second attempt re-fetches the database too.
  const { tracker } = makeTracker([
    errorResult({ code: 'rate_limited', message: 'slow' }),
    okResult(databaseInfo),
    okResult(databaseQueryActive),
  ]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 2);
});

test('listActiveIssues: malformed response → VALIDATION', async () => {
  const { tracker } = makeTracker([
    okResult(databaseInfo),
    okResult({ wrong: 'shape' }),
  ]);
  await assert.rejects(
    () => tracker.listActiveIssues(),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'VALIDATION' &&
      e.details.reason === 'database-query-parse-failed',
  );
});

test('listActiveIssues: AUTH error → not retried; throws AUTH', async () => {
  const { tracker, mock } = makeTracker([
    errorResult({ code: 'unauthorized', message: 'bad' }),
  ]);
  await assert.rejects(
    () => tracker.listActiveIssues(),
    (e: unknown) => e instanceof TrackerError && e.code === 'AUTH',
  );
  assert.equal(mock.calls.length, 1);
});

// ─── claim ───────────────────────────────────────────────────────────────────

test('claim: empty forge_claimed_by → write → recheck shows ours → ok', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const initial = buildPage({ id: pageId, claimedBy: '', state: 'Todo' });
  const post = buildPage({ id: pageId, claimedBy: 'agent-me', state: 'Todo' });
  const { tracker, mock } = makeTracker([
    okResult(initial),
    okEmpty(),
    okResult(post),
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.deepEqual(r, { ok: true });
  assert.equal(mock.calls[0]?.tool, 'API-retrieve-a-page');
  assert.equal(mock.calls[1]?.tool, 'API-patch-page');
  assert.equal(mock.calls[2]?.tool, 'API-retrieve-a-page');
});

test('claim: already-claimed by other → already_claimed; no write', async () => {
  const { tracker, mock } = makeTracker([okResult(pageClaimedByOther)]);
  const r = await tracker.claim(
    'aaaa1111-2222-3333-4444-555566667777',
    'agent-me',
  );
  assert.deepEqual(r, {
    ok: false,
    reason: 'already_claimed',
    detail: 'agent-other',
  });
  assert.equal(mock.calls.length, 1);
});

test('claim: already-claimed by us (idempotent) → ok', async () => {
  const { tracker, mock } = makeTracker([okResult(pageClaimedByMe)]);
  const r = await tracker.claim(
    'aaaa1111-2222-3333-4444-555566667777',
    'agent-me',
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(mock.calls.length, 1);
});

test('claim: race — recheck shows different agent → version_conflict', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const initial = buildPage({ id: pageId, claimedBy: '' });
  const post = buildPage({
    id: pageId,
    claimedBy: 'agent-other',
    lastEditedTime: '2026-05-12T00:00:01.000Z',
  });
  // Two extra steps: the cleanup write for our lost-tiebreak.
  const { tracker, mock } = makeTracker([
    okResult(initial),
    okEmpty(),
    okResult(post),
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'version_conflict');
    assert.match(r.detail ?? '', /lost-tiebreak-to:agent-other/);
  }
  // We do NOT call tryClearClaim in the lost-tiebreak path here (the other
  // agent already overwrote us). Recheck happened; no cleanup write.
  assert.equal(mock.calls.length, 3);
});

test('claim: NOT_FOUND on initial fetch → version_conflict (clean)', async () => {
  const { tracker } = makeTracker([
    errorResult({ code: 'object_not_found', message: 'gone' }),
  ]);
  const r = await tracker.claim(
    'aaaa1111-2222-3333-4444-555566667777',
    'agent-me',
  );
  assert.deepEqual(r, {
    ok: false,
    reason: 'version_conflict',
    detail: 'page-not-found-on-initial-fetch',
  });
});

test('claim: NOT_FOUND on write → version_conflict', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const { tracker } = makeTracker([
    okResult(buildPage({ id: pageId, claimedBy: '' })),
    errorResult({ code: 'object_not_found', message: 'gone' }),
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'version_conflict');
    assert.equal(r.detail, 'page-not-found-on-write');
  }
});

test('claim: TRANSPORT mid-flow → transient_error', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  // Need 3 retries' worth before withRetry exhausts: send 3 transport errors.
  const t1 = makeMcpError(-32000, 'closed');
  const t2 = makeMcpError(-32000, 'closed');
  const t3 = makeMcpError(-32000, 'closed');
  const { tracker } = makeTracker([t1, t2, t3]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, 'transient_error');
});

test('claim: page archived between fetches → version_conflict', async () => {
  const { tracker } = makeTracker([okResult(pageArchived)]);
  const r = await tracker.claim(
    'bbbb1111-2222-3333-4444-555566667777',
    'agent-me',
  );
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'version_conflict');
    assert.equal(r.detail, 'page-archived');
  }
});

test('claim: rejects empty issueId / runId via VALIDATION', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.claim('', 'agent-me'),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  await assert.rejects(
    () => tracker.claim('aaaa1111-2222-3333-4444-555566667777', '  '),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
});

// ─── releaseClaim ────────────────────────────────────────────────────────────

test('releaseClaim: clears forge_claimed_by', async () => {
  const { tracker, mock } = makeTracker([okEmpty()]);
  await tracker.releaseClaim('aaaa1111-2222-3333-4444-555566667777', 'run-me');
  assert.equal(mock.calls[0]?.tool, 'API-patch-page');
  const props = mock.calls[0]?.args.properties as Record<string, unknown>;
  assert.ok('forge_claimed_by' in props);
});

test('releaseClaim: idempotent on NOT_FOUND', async () => {
  const { tracker } = makeTracker([
    errorResult({ code: 'object_not_found', message: 'gone' }),
  ]);
  await tracker.releaseClaim('aaaa1111-2222-3333-4444-555566667777', 'run-me');
});

test('releaseClaim: AUTH error bubbles up', async () => {
  const { tracker } = makeTracker([
    errorResult({ code: 'unauthorized', message: 'bad' }),
  ]);
  await assert.rejects(
    () => tracker.releaseClaim('aaaa1111-2222-3333-4444-555566667777', 'run-me'),
    (e: unknown) => e instanceof TrackerError && e.code === 'AUTH',
  );
});

// ─── updateState ─────────────────────────────────────────────────────────────

test('updateState: maps each IssueState to Notion status name', async () => {
  const cases: Array<[Parameters<NotionTracker['updateState']>[1], string]> = [
    ['todo', 'Todo'],
    ['in_progress', 'In Progress'],
    ['in_review', 'In Review'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
    ['blocked', 'Blocked'],
  ];
  for (const [state, expected] of cases) {
    const { tracker, mock } = makeTracker([okEmpty()]);
    await tracker.updateState('aaaa1111-2222-3333-4444-555566667777', state);
    const props = mock.calls[0]?.args.properties as Record<string, unknown>;
    const statusProp = props.state as { status: { name: string } };
    assert.equal(statusProp.status.name, expected);
  }
});

test('updateState: rejects empty issueId', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.updateState('', 'done'),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
});

// ─── comment ─────────────────────────────────────────────────────────────────

test('comment: posts API-create-a-comment with rich_text body', async () => {
  const { tracker, mock } = makeTracker([okEmpty()]);
  await tracker.comment(
    'aaaa1111-2222-3333-4444-555566667777',
    'Claimed by agent-me',
  );
  assert.equal(mock.calls[0]?.tool, 'API-create-a-comment');
  const args = mock.calls[0]?.args as {
    parent: { page_id: string };
    rich_text: Array<{ text: { content: string } }>;
  };
  assert.equal(args.parent.page_id, 'aaaa1111-2222-3333-4444-555566667777');
  assert.equal(args.rich_text[0]?.text.content, 'Claimed by agent-me');
});

test('comment: rejects empty body', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () => tracker.comment('aaaa1111-2222-3333-4444-555566667777', ''),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
});

test('comment: VALIDATION error not retried', async () => {
  const { tracker, mock } = makeTracker([
    errorResult({ code: 'validation_error', message: 'bad' }),
  ]);
  await assert.rejects(
    () => tracker.comment('aaaa1111-2222-3333-4444-555566667777', 'hi'),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  assert.equal(mock.calls.length, 1);
});

// ─── createProject ───────────────────────────────────────────────────────────

test('createProject: requires FORGE_NOTION_PARENT_PAGE_ID', async () => {
  const prev = process.env.FORGE_NOTION_PARENT_PAGE_ID;
  delete process.env.FORGE_NOTION_PARENT_PAGE_ID;
  try {
    const { tracker } = makeTracker([]);
    await assert.rejects(
      () => tracker.createProject('my project'),
      (e: unknown) =>
        e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
    );
  } finally {
    if (prev !== undefined) process.env.FORGE_NOTION_PARENT_PAGE_ID = prev;
  }
});

test('createProject: returns { id, url } from new database', async () => {
  process.env.FORGE_NOTION_PARENT_PAGE_ID =
    'cccc1111-2222-3333-4444-555566667777';
  try {
    const { tracker, mock } = makeTracker([okResult(newDatabase)]);
    const r = await tracker.createProject('my project', 'desc');
    assert.equal(r.id, newDatabase.id);
    assert.equal(r.url, newDatabase.url);
    assert.equal(mock.calls[0]?.tool, 'API-create-a-data-source');
  } finally {
    delete process.env.FORGE_NOTION_PARENT_PAGE_ID;
  }
});

// ─── createIssue ─────────────────────────────────────────────────────────────

test('createIssue: maps payload → page properties + body blocks', async () => {
  const createdPage = buildPage({
    id: 'eeee1111-2222-3333-4444-555566667777',
    title: 'New issue',
    state: 'Todo',
    taskId: 'FORGE-99',
    ownerType: 'backend-dev',
    acceptance: 'must work',
  });
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),
    okResult(createdPage),
  ]);
  const issue = await tracker.createIssue({
    title: 'New issue',
    body: 'description text',
    forgeTaskId: 'FORGE-99',
    ownerType: 'backend-dev',
    acceptance: ['must work', 'must round-trip'],
    dependsOn: [],
  });
  assert.equal(issue.title, 'New issue');
  assert.equal(issue.forgeTaskId, 'FORGE-99');
  assert.equal(issue.state, 'todo');
  // API-post-page takes a single page, parented to a data_source_id,
  // with children as plain block objects (the schema declares strings
  // but the server rejects strings; verified live).
  const args = mock.calls[1]?.args as {
    parent: { type: string; data_source_id: string };
    children?: Array<{ type: string }>;
  };
  assert.equal(args.parent.type, 'data_source_id');
  assert.equal(args.parent.data_source_id, DATA_SOURCE_ID);
  const children = args.children ?? [];
  assert.ok(children.length >= 3); // paragraph + heading + to_do
  assert.ok(children.some((c) => c.type === 'paragraph'));
  assert.ok(children.some((c) => c.type === 'heading_2'));
  assert.ok(children.some((c) => c.type === 'to_do'));
});

test('createIssue: rejects empty title / forgeTaskId / ownerType', async () => {
  const { tracker } = makeTracker([]);
  for (const bad of [
    {
      title: '',
      body: '',
      forgeTaskId: 'X',
      ownerType: 'X',
      acceptance: [],
      dependsOn: [],
    },
    {
      title: 'T',
      body: '',
      forgeTaskId: '',
      ownerType: 'X',
      acceptance: [],
      dependsOn: [],
    },
    {
      title: 'T',
      body: '',
      forgeTaskId: 'X',
      ownerType: '',
      acceptance: [],
      dependsOn: [],
    },
  ]) {
    await assert.rejects(
      () => tracker.createIssue(bad),
      (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
    );
  }
});

// ─── setBlockedBy ────────────────────────────────────────────────────────────

test('setBlockedBy: appends new blocker, dedups existing', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const blockerId = '11112222-3333-4444-5555-666677778881';
  const { tracker, mock } = makeTracker([
    okResult(buildPage({ id: pageId, taskId: 'FORGE-7', blockedBy: '' })),
    okEmpty(),
  ]);
  await tracker.setBlockedBy(pageId, blockerId);
  const updateArgs = mock.calls[1]?.args as {
    properties: Record<string, { rich_text: Array<{ text: { content: string } }> }>;
  };
  const newVal =
    updateArgs.properties.forge_blocked_by?.rich_text[0]?.text.content;
  assert.equal(newVal, blockerId);
});

test('setBlockedBy: dedup short-circuits (no write)', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const existing = '11112222-3333-4444-5555-666677778881';
  const { tracker, mock } = makeTracker([
    okResult(
      buildPage({
        id: pageId,
        taskId: 'FORGE-7',
        blockedBy: existing,
      }),
    ),
  ]);
  await tracker.setBlockedBy(pageId, existing);
  assert.equal(mock.calls.length, 1); // fetch only, no update
});

test('setBlockedBy: missing forge_task_id → PRECONDITION_FAILED', async () => {
  const pageId = 'cccc1111-2222-3333-4444-555566667777';
  const { tracker } = makeTracker([okResult(pageWithoutForgeTaskId)]);
  await assert.rejects(
    () =>
      tracker.setBlockedBy(
        pageId,
        '11112222-3333-4444-5555-666677778881',
      ),
    (e: unknown) =>
      e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
  );
});

test('setBlockedBy: rejects non-UUID blockerId', async () => {
  const { tracker } = makeTracker([]);
  await assert.rejects(
    () =>
      tracker.setBlockedBy(
        'aaaa1111-2222-3333-4444-555566667777',
        'not-a-uuid',
      ),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
});

// ─── full lifecycle (acceptance bullet 4) ────────────────────────────────────

test('full lifecycle: createIssue → claim → updateState → comment → releaseClaim → updateState(done)', async () => {
  const pageId = 'eeee1111-2222-3333-4444-555566667777';
  const created = buildPage({
    id: pageId,
    title: 'Lifecycle task',
    taskId: 'FORGE-99',
    ownerType: 'backend-dev',
    state: 'Todo',
  });
  const claimedFetch = buildPage({
    id: pageId,
    title: 'Lifecycle task',
    taskId: 'FORGE-99',
    state: 'Todo',
  });
  const claimedRecheck = buildPage({
    id: pageId,
    title: 'Lifecycle task',
    taskId: 'FORGE-99',
    claimedBy: 'agent-me',
    state: 'Todo',
    lastEditedTime: '2026-05-12T00:00:01.000Z',
  });
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),   // createIssue → resolveDataSourceId
    okResult(created),        // createIssue → API-post-page
    okResult(claimedFetch),   // claim.fetch
    okEmpty(),                // claim.write
    okResult(claimedRecheck), // claim.recheck (after settle delay)
    okEmpty(),                // updateState in_progress
    okEmpty(),                // comment
    okEmpty(),                // releaseClaim
    okEmpty(),                // updateState done
  ]);

  const issue = await tracker.createIssue({
    title: 'Lifecycle task',
    body: 'desc',
    forgeTaskId: 'FORGE-99',
    ownerType: 'backend-dev',
    acceptance: ['done means done'],
    dependsOn: [],
  });
  assert.equal(issue.id, pageId);

  const c = await tracker.claim(pageId, 'agent-me');
  assert.equal(c.ok, true);

  await tracker.updateState(pageId, 'in_progress');
  await tracker.comment(pageId, 'starting work');
  await tracker.releaseClaim(pageId, 'agent-me');
  await tracker.updateState(pageId, 'done');

  const tools = mock.calls.map((c) => c.tool);
  assert.deepEqual(tools, [
    'API-retrieve-a-database',
    'API-post-page',
    'API-retrieve-a-page',
    'API-patch-page',
    'API-retrieve-a-page',
    'API-patch-page',
    'API-create-a-comment',
    'API-patch-page',
    'API-patch-page',
  ]);
});

// ─── regressions ─────────────────────────────────────────────────────────────

test('listActiveIssues: paginates past Done-heavy front pages (codex P2-1)', async () => {
  // Front 2 pages are all Done; page 3 has 5 active. Previous bug: maxPages=2
  // would stop after page 2 and return 0 active. After fix: pagination
  // continues until active accumulated OR has_more=false.
  const donePage = (cursorKey: string) => ({
    results: Array.from({ length: 100 }, (_, i) =>
      buildPage({
        id: `${cursorKey}1111-2222-3333-4444-${String(i).padStart(12, '0')}`,
        state: 'Done',
      }),
    ),
    has_more: true,
    next_cursor: `cursor-${cursorKey}-next`,
  });
  const activePage = {
    results: Array.from({ length: 5 }, (_, i) =>
      buildPage({
        id: `aaaa1111-2222-3333-4444-${String(i).padStart(12, '0')}`,
        title: `active-${i}`,
        state: 'Todo',
      }),
    ),
    has_more: false,
    next_cursor: null,
  };
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),
    okResult(donePage('a')),
    okResult(donePage('b')),
    okResult(activePage),
  ]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 5);
  // 1 db-info + 3 query pages
  assert.equal(mock.calls.length, 4);
});

test('listActiveIssues: hits raw-page cap and warns', async () => {
  // Every page is Done with has_more=true forever. Loop must exit at
  // NOTION_RAW_PAGE_CAP.
  const donePage = {
    results: Array.from({ length: 100 }, (_, i) =>
      buildPage({
        id: `cccc1111-2222-3333-4444-${String(i).padStart(12, '0')}`,
        state: 'Done',
      }),
    ),
    has_more: true,
    next_cursor: 'cursor-loop',
  };
  const steps: Array<ReturnType<typeof okResult>> = [okResult(databaseInfo)];
  for (let i = 0; i < NOTION_RAW_PAGE_CAP; i++) steps.push(okResult(donePage));
  const { tracker, mock, logger } = makeTracker(steps);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 0);
  // 1 db-info + NOTION_RAW_PAGE_CAP queries
  assert.equal(mock.calls.length, NOTION_RAW_PAGE_CAP + 1);
  assert.ok(
    logger.warnings.some(
      (w) =>
        w.event === 'tracker.listActiveIssues' &&
        (w.fields as { reason?: string })?.reason === 'raw-page-cap-hit',
    ),
  );
});

test('claim cleanup: does NOT clear when field now holds another agent (codex P2-2)', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const initial = buildPage({ id: pageId, claimedBy: '' });
  // Step sequence:
  //   1. claim.fetch → empty
  //   2. claim.write → ok
  //   3. claim.recheck → throws TRANSPORT (3 retries each throw)
  //   4. tryClearClaimIfOwned fetch → shows 'agent-winner' (NOT us)
  //   → adapter must NOT issue a clearing update-page call
  const transportErr = makeMcpError(-32000, 'closed');
  const competitorWon = buildPage({ id: pageId, claimedBy: 'agent-winner' });
  const { tracker, mock } = makeTracker([
    okResult(initial),     // claim.fetch
    okEmpty(),             // claim.write
    transportErr,          // claim.recheck attempt 1
    transportErr,          // claim.recheck attempt 2
    transportErr,          // claim.recheck attempt 3
    okResult(competitorWon), // cleanup-fetch
    // NO further steps: if adapter tried to clear, MockMcp would throw
    // "unexpected call".
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, 'transient_error');
  const tools = mock.calls.map((c) => c.tool);
  // 1 fetch + 1 write + 3 recheck-fetch + 1 cleanup-fetch = 6 fetches
  // total, NO second update-page (that would be the clear).
  const updateCount = tools.filter((t) => t === 'API-patch-page').length;
  assert.equal(updateCount, 1, 'only the initial claim write should occur');
});

test('claim: applies CLAIM_SETTLE_MS sleep between write and recheck (codex P1)', async () => {
  // Without the settle delay, two near-simultaneous claims can both pass
  // their recheck before seeing each other's writes. The delay is the
  // single mitigation forge can offer for Notion's missing CAS — assert it
  // actually fires and uses CLAIM_SETTLE_MS.
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const { tracker, sleepCalls } = makeTracker([
    okResult(buildPage({ id: pageId, claimedBy: '' })),
    okEmpty(),
    okResult(buildPage({ id: pageId, claimedBy: 'agent-me' })),
  ]);
  await tracker.claim(pageId, 'agent-me');
  assert.ok(
    sleepCalls.includes(CLAIM_SETTLE_MS),
    `expected sleep(${CLAIM_SETTLE_MS}) between write and recheck; got: ${sleepCalls.join(',')}`,
  );
});

test('claim: settle delay catches concurrent overwriter — second agent loses (codex P1)', async () => {
  // Simulate the race: A's write lands first; the settle window lets B's
  // overwrite arrive before A's recheck; A's recheck sees B's value and
  // correctly returns version_conflict instead of double-winning.
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const { tracker } = makeTracker([
    okResult(buildPage({ id: pageId, claimedBy: '' })),    // A.fetch
    okEmpty(),                                              // A.write
    okResult(buildPage({                                   // A.recheck — B wrote during settle
      id: pageId,
      claimedBy: 'agent-other',
      lastEditedTime: '2026-05-12T00:00:02.000Z',
    })),
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'version_conflict');
    assert.match(r.detail ?? '', /lost-tiebreak-to:agent-other/);
  }
});

test('claim recheck: NOT_FOUND returns version_conflict, not thrown (codex P2-3)', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const initial = buildPage({ id: pageId, claimedBy: '' });
  const { tracker } = makeTracker([
    okResult(initial),                                              // claim.fetch
    okEmpty(),                                                      // claim.write
    errorResult({ code: 'object_not_found', message: 'archived' }), // claim.recheck (single throw since NOT_FOUND is not retriable)
    // tryClearClaimIfOwned then runs:
    errorResult({ code: 'object_not_found', message: 'archived' }), //   cleanup-fetch — page is gone, abort cleanup
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.equal(r.reason, 'version_conflict');
    assert.equal(r.detail, 'page-not-found-on-recheck');
  }
});

test('claim cleanup: DOES clear when field still owned by us (codex P2-2)', async () => {
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const initial = buildPage({ id: pageId, claimedBy: '' });
  const transportErr = makeMcpError(-32000, 'closed');
  const stillOurs = buildPage({ id: pageId, claimedBy: 'agent-me' });
  const { tracker, mock } = makeTracker([
    okResult(initial),
    okEmpty(),
    transportErr,
    transportErr,
    transportErr,
    okResult(stillOurs), // cleanup-fetch shows we still own it
    okEmpty(),           // cleanup write — clear it
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, 'transient_error');
  const updateCount = mock.calls.filter(
    (c) => c.tool === 'API-patch-page',
  ).length;
  assert.equal(updateCount, 2, 'initial claim write + conditional cleanup');
});

// ─── constants ───────────────────────────────────────────────────────────────

test('NOTION_LIST_LIMIT + NOTION_RAW_PAGE_CAP + CLAIM_SETTLE_MS exported', () => {
  assert.equal(typeof NOTION_LIST_LIMIT, 'number');
  assert.ok(NOTION_LIST_LIMIT > 0);
  assert.equal(typeof NOTION_RAW_PAGE_CAP, 'number');
  assert.ok(NOTION_RAW_PAGE_CAP > 0);
  assert.equal(typeof CLAIM_SETTLE_MS, 'number');
  assert.ok(CLAIM_SETTLE_MS > 0);
});
