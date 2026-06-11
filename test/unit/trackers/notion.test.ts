import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAIM_SETTLE_MS,
  NOTION_API_VERSION,
  NOTION_BODY_MAX_BYTES,
  NOTION_LIST_LIMIT,
  NOTION_RAW_PAGE_CAP,
  NotionTracker,
  TrackerError,
  bodyToParagraphBlocks,
  classifyNotionExecError,
  isRetriableTrackerErrorCode,
  parseNotionPageId,
  readRichText,
  readStatus,
  readTitle,
  type Logger,
  type NtnExec,
  type NtnExecResult,
} from '../../../src/trackers/index.ts';
import type { NotionTrackerConfig } from '../../../src/schemas/settings.ts';
import {
  DATA_SOURCE_ID,
  blockChildren,
  buildPage,
  databaseInfo,
  databaseQueryActive,
  databaseQueryPaged1,
  databaseQueryPaged2,
  errorResult,
  makeSpawnError,
  newDatabase,
  okEmpty,
  okResult,
  pageArchived,
  pageClaimedByMe,
  pageClaimedByOther,
  pageEmpty,
  pageWithFooters,
  pageWithoutForgeTaskId,
  timeoutResult,
  transportError,
} from '../../fixtures/trackers/notion-responses.ts';

// ─── Test infra ──────────────────────────────────────────────────────────────

const DB_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';

const notionConfig: NotionTrackerConfig = {
  type: 'notion',
  config: { database_id: DB_ID },
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

type MockStep = NtnExecResult | Error;

interface RecordedCall {
  args: string[];
  input?: string;
}

class MockNtn {
  private idx = 0;
  readonly calls: RecordedCall[] = [];
  constructor(private readonly steps: MockStep[]) {}
  exec: NtnExec = async (args, opts) => {
    const call: RecordedCall = { args: [...args] };
    if (opts?.input !== undefined) call.input = opts.input;
    this.calls.push(call);
    const step = this.steps[this.idx++];
    if (step === undefined) {
      throw new Error(
        `MockNtn: unexpected call #${this.idx}: ntn ${args.join(' ')}`,
      );
    }
    if (step instanceof Error) throw step;
    return step;
  };
}

function makeTracker(steps: MockStep[]) {
  const mock = new MockNtn(steps);
  const logger = noopLogger();
  const sleepCalls: number[] = [];
  const tracker = new NotionTracker(notionConfig, logger, {
    ntn: mock.exec,
    retry: { sleep: async () => {} },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
  return { tracker, mock, logger, sleepCalls };
}

// Decompose an argv into { path, method }. Method defaults to GET (no -X).
function apiOf(call: RecordedCall): { path: string; method: string } {
  assert.equal(call.args[0], 'api', `expected 'api' verb, got: ${call.args.join(' ')}`);
  const path = call.args[1]!;
  const xIdx = call.args.indexOf('-X');
  const method = xIdx >= 0 ? call.args[xIdx + 1]! : 'GET';
  return { path, method };
}

function inputJson(call: RecordedCall): Record<string, unknown> {
  assert.ok(call.input !== undefined, 'expected a stdin body on this call');
  return JSON.parse(call.input!) as Record<string, unknown>;
}

function assertVersionPinned(call: RecordedCall): void {
  const idx = call.args.indexOf('--notion-version');
  assert.ok(idx >= 0, `--notion-version missing: ntn ${call.args.join(' ')}`);
  assert.equal(call.args[idx + 1], NOTION_API_VERSION);
}

// ─── classifyNotionExecError ─────────────────────────────────────────────────

test('classifyNotionExecError: ENOENT spawn error → TRANSPORT with install hint', () => {
  const hint = classifyNotionExecError(
    makeSpawnError('ENOENT', 'spawn ntn ENOENT'),
  );
  assert.equal(hint.code, 'TRANSPORT');
  assert.equal(hint.details?.reason, 'ntn-not-installed');
  assert.match(String(hint.details?.hint ?? ''), /ntn login/);
});

test('classifyNotionExecError: unauthorized → AUTH', () => {
  const hint = classifyNotionExecError(
    errorResult({ code: 'unauthorized', message: 'bad token' }),
  );
  assert.equal(hint.code, 'AUTH');
});

test('classifyNotionExecError: restricted_resource → AUTH (before NOT_FOUND)', () => {
  const hint = classifyNotionExecError(
    errorResult({ code: 'restricted_resource', message: 'access denied' }),
  );
  assert.equal(hint.code, 'AUTH');
});

test('classifyNotionExecError: object_not_found → NOT_FOUND', () => {
  const hint = classifyNotionExecError(
    errorResult({ code: 'object_not_found', message: 'page gone' }),
  );
  assert.equal(hint.code, 'NOT_FOUND');
});

test('classifyNotionExecError: rate_limited carries retryAfterMs from retry_after', () => {
  const hint = classifyNotionExecError(
    errorResult({ code: 'rate_limited', message: 'slow down', retry_after: 5 }),
  );
  assert.equal(hint.code, 'RATE_LIMITED');
  assert.equal(hint.details?.retryAfterMs, 5000);
});

test('classifyNotionExecError: official transient codes stay retriable (Codex impl-review)', () => {
  // database_connection_unavailable → TRANSPORT (5xx-class outage)
  assert.equal(
    classifyNotionExecError(
      errorResult({ code: 'database_connection_unavailable', message: 'db down' }),
    ).code,
    'TRANSPORT',
  );
  // gateway_timeout → TIMEOUT (504-class)
  assert.equal(
    classifyNotionExecError(
      errorResult({ code: 'gateway_timeout', message: 'upstream timeout' }),
    ).code,
    'TIMEOUT',
  );
  // service_overload → RATE_LIMITED ("slow down" semantics, retry_after honored)
  const overload = classifyNotionExecError(
    errorResult({ code: 'service_overload', message: 'overloaded', retry_after: 30 }),
  );
  assert.equal(overload.code, 'RATE_LIMITED');
  assert.equal(overload.details?.retryAfterMs, 30_000);
});

test('classifyNotionExecError: validation family → VALIDATION (before CONFLICT)', () => {
  for (const code of [
    'validation_error',
    'invalid_request',
    'invalid_json',
    'invalid_request_url',
  ]) {
    const hint = classifyNotionExecError(
      errorResult({ code, message: 'thing already exists' }),
    );
    assert.equal(hint.code, 'VALIDATION', `notion code ${code}`);
  }
});

test('classifyNotionExecError: conflict family → CONFLICT', () => {
  for (const code of ['conflict_error', 'concurrent_edit']) {
    const hint = classifyNotionExecError(
      errorResult({ code, message: 'concurrent edit' }),
    );
    assert.equal(hint.code, 'CONFLICT', `notion code ${code}`);
  }
});

test('classifyNotionExecError: 5xx provider codes → TRANSPORT (retriable)', () => {
  for (const code of [
    'internal_server_error',
    'service_unavailable',
    'bad_gateway',
  ]) {
    const hint = classifyNotionExecError(
      errorResult({ code, message: 'upstream sad' }),
    );
    assert.equal(hint.code, 'TRANSPORT', `notion code ${code}`);
  }
});

test('classifyNotionExecError: timeouts → TIMEOUT (returned and thrown shapes)', () => {
  assert.equal(classifyNotionExecError(timeoutResult()).code, 'TIMEOUT');
  assert.equal(
    classifyNotionExecError(makeSpawnError('ETIMEDOUT', 'it died')).code,
    'TIMEOUT',
  );
  assert.equal(
    classifyNotionExecError(new Error('request timed out')).code,
    'TIMEOUT',
  );
});

test('classifyNotionExecError: connection failures → TRANSPORT fallback', () => {
  assert.equal(classifyNotionExecError(transportError()).code, 'TRANSPORT');
  assert.equal(
    classifyNotionExecError({ exitCode: 1, stdout: '', stderr: 'connection refused' }).code,
    'TRANSPORT',
  );
});

test('classifyNotionExecError: unknown nonzero exit → UNKNOWN (not retriable TRANSPORT)', () => {
  const hint = classifyNotionExecError({
    exitCode: 1,
    stdout: '',
    stderr: 'something inscrutable happened',
  });
  assert.equal(hint.code, 'UNKNOWN');
});

test('classifyNotionExecError: unknown notion error code → UNKNOWN', () => {
  const hint = classifyNotionExecError(
    errorResult({ code: 'mystery_code', message: 'new in some future API' }),
  );
  assert.equal(hint.code, 'UNKNOWN');
  assert.equal(hint.details?.notionCode, 'mystery_code');
});

test('classifyNotionExecError: notion body passed directly (thrown shape) → mapped', () => {
  const hint = classifyNotionExecError({
    object: 'error',
    code: 'object_not_found',
    message: 'page deleted',
  });
  assert.equal(hint.code, 'NOT_FOUND');
});

test('classifyNotionExecError: error body on stderr instead of stdout → mapped', () => {
  const hint = classifyNotionExecError({
    exitCode: 1,
    stdout: '',
    stderr: JSON.stringify({
      object: 'error',
      code: 'unauthorized',
      message: 'no',
    }),
  });
  assert.equal(hint.code, 'AUTH');
});

test('classifyNotionExecError: unknown shape → UNKNOWN', () => {
  assert.equal(classifyNotionExecError('weird string').code, 'UNKNOWN');
  assert.equal(classifyNotionExecError(null).code, 'UNKNOWN');
  assert.equal(classifyNotionExecError(42).code, 'UNKNOWN');
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

// ─── bodyToParagraphBlocks ───────────────────────────────────────────────────

test('bodyToParagraphBlocks: empty body → no blocks', () => {
  assert.deepEqual(bodyToParagraphBlocks(''), []);
});

test('bodyToParagraphBlocks: chunks rich_text items at 2000 chars', () => {
  const blocks = bodyToParagraphBlocks('x'.repeat(4500));
  assert.equal(blocks.length, 1);
  const rt = (blocks[0] as { paragraph: { rich_text: Array<{ text: { content: string } }> } })
    .paragraph.rich_text;
  assert.deepEqual(
    rt.map((i) => i.text.content.length),
    [2000, 2000, 500],
  );
});

test('bodyToParagraphBlocks: splits into multiple paragraphs past 100 items', () => {
  // 100 * 2000 = 200_000 chars fills the first block; +500 spills into a 2nd
  // paragraph. NOTE: unreachable via updateIssueBody (64 KiB byte cap admits
  // at most 33 items) but reachable via createIssue, whose body is uncapped.
  const blocks = bodyToParagraphBlocks('x'.repeat(200_500));
  assert.equal(blocks.length, 2);
  const items = (b: unknown) =>
    (b as { paragraph: { rich_text: unknown[] } }).paragraph.rich_text.length;
  assert.equal(items(blocks[0]), 100);
  assert.equal(items(blocks[1]), 1);
});

// ─── healthCheck ─────────────────────────────────────────────────────────────

test('healthCheck: returns ok on successful users/me call', async () => {
  const { tracker, mock } = makeTracker([okResult({ object: 'user', id: 'u1' })]);
  const r = await tracker.healthCheck();
  assert.equal(r.ok, true);
  assert.deepEqual(apiOf(mock.calls[0]!), { path: 'v1/users/me', method: 'GET' });
  assertVersionPinned(mock.calls[0]!);
});

test('healthCheck: returns ok:false on transport error; never throws', async () => {
  const { tracker } = makeTracker([transportError()]);
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
  const { tracker, mock } = makeTracker([
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
  assert.deepEqual(apiOf(mock.calls[0]!), {
    path: `v1/databases/${DB_ID}`,
    method: 'GET',
  });
  assert.deepEqual(apiOf(mock.calls[1]!), {
    path: `v1/data_sources/${DATA_SOURCE_ID}/query`,
    method: 'POST',
  });
  assert.deepEqual(inputJson(mock.calls[1]!), { page_size: 100 });
  for (const call of mock.calls) assertVersionPinned(call);
});

test('listActiveIssues: paginates via next_cursor (cursor in stdin body)', async () => {
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),
    okResult(databaseQueryPaged1),
    okResult(databaseQueryPaged2),
  ]);
  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 2);
  // 1 db-info + 2 query calls
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(inputJson(mock.calls[2]!), {
    page_size: 100,
    start_cursor: 'cursor-page-2',
  });
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
  assert.deepEqual(apiOf(mock.calls[0]!), {
    path: `v1/pages/${pageId}`,
    method: 'GET',
  });
  assert.deepEqual(apiOf(mock.calls[1]!), {
    path: `v1/pages/${pageId}`,
    method: 'PATCH',
  });
  const writeBody = inputJson(mock.calls[1]!) as {
    properties: Record<string, { rich_text: Array<{ text: { content: string } }> }>;
  };
  assert.equal(
    writeBody.properties.forge_claimed_by?.rich_text[0]?.text.content,
    'agent-me',
  );
  assert.deepEqual(apiOf(mock.calls[2]!), {
    path: `v1/pages/${pageId}`,
    method: 'GET',
  });
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
  const { tracker } = makeTracker([
    transportError(),
    transportError(),
    transportError(),
  ]);
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
  const pageId = 'aaaa1111-2222-3333-4444-555566667777';
  const { tracker, mock } = makeTracker([okEmpty()]);
  await tracker.releaseClaim(pageId, 'run-me');
  assert.deepEqual(apiOf(mock.calls[0]!), {
    path: `v1/pages/${pageId}`,
    method: 'PATCH',
  });
  const props = (inputJson(mock.calls[0]!) as { properties: Record<string, unknown> })
    .properties;
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
    const props = (inputJson(mock.calls[0]!) as {
      properties: { state: { status: { name: string } } };
    }).properties;
    assert.equal(props.state.status.name, expected);
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

test('comment: POSTs v1/comments with rich_text body via stdin', async () => {
  const { tracker, mock } = makeTracker([okEmpty()]);
  await tracker.comment(
    'aaaa1111-2222-3333-4444-555566667777',
    'Claimed by agent-me',
  );
  assert.deepEqual(apiOf(mock.calls[0]!), {
    path: 'v1/comments',
    method: 'POST',
  });
  const body = inputJson(mock.calls[0]!) as {
    parent: { page_id: string };
    rich_text: Array<{ text: { content: string } }>;
  };
  assert.equal(body.parent.page_id, 'aaaa1111-2222-3333-4444-555566667777');
  assert.equal(body.rich_text[0]?.text.content, 'Claimed by agent-me');
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

test('createProject: POST v1/databases with initial_data_source; returns database { id, url }', async () => {
  process.env.FORGE_NOTION_PARENT_PAGE_ID =
    'cccc1111-2222-3333-4444-555566667777';
  try {
    const { tracker, mock } = makeTracker([okResult(newDatabase)]);
    const r = await tracker.createProject('my project', 'desc');
    assert.equal(r.id, newDatabase.id);
    assert.equal(r.url, newDatabase.url);
    // API 2026-03-11: new database under a page = POST v1/databases (NOT
    // v1/data_sources, which only adds a source to an existing database).
    assert.deepEqual(apiOf(mock.calls[0]!), {
      path: 'v1/databases',
      method: 'POST',
    });
    const body = inputJson(mock.calls[0]!) as {
      parent: { type: string; page_id: string };
      initial_data_source?: { properties?: Record<string, unknown> };
      properties?: unknown;
    };
    assert.equal(body.parent.type, 'page_id');
    // Column schema rides in initial_data_source, not top-level properties.
    assert.ok(body.initial_data_source?.properties);
    assert.equal(body.properties, undefined);
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
  assert.deepEqual(apiOf(mock.calls[1]!), { path: 'v1/pages', method: 'POST' });
  const body = inputJson(mock.calls[1]!) as {
    parent: { type: string; data_source_id: string };
    children?: Array<{ type: string }>;
  };
  assert.equal(body.parent.type, 'data_source_id');
  assert.equal(body.parent.data_source_id, DATA_SOURCE_ID);
  const children = body.children ?? [];
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
  const updateBody = inputJson(mock.calls[1]!) as {
    properties: Record<string, { rich_text: Array<{ text: { content: string } }> }>;
  };
  const newVal =
    updateBody.properties.forge_blocked_by?.rich_text[0]?.text.content;
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

// ─── updateIssueBody (FORGE-117) ─────────────────────────────────────────────

const UIB_PAGE_ID = 'aaaa1111-2222-3333-4444-555566667777';
const uibPage = () => buildPage({ id: UIB_PAGE_ID, taskId: 'FORGE-9' });

test('updateIssueBody: happy path — list children → delete each → append paragraphs', async () => {
  const { tracker, mock } = makeTracker([
    okResult(uibPage()),                       // fetch page (precondition)
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002'])),
    okEmpty(),                                 // delete child 1
    okEmpty(),                                 // delete child 2
    okEmpty(),                                 // append
  ]);
  await tracker.updateIssueBody(UIB_PAGE_ID, 'fresh body');

  assert.equal(mock.calls.length, 5);
  assert.deepEqual(apiOf(mock.calls[0]!), {
    path: `v1/pages/${UIB_PAGE_ID}`,
    method: 'GET',
  });
  // Children list — pagination via QUERY ARGS, not stdin.
  assert.deepEqual(apiOf(mock.calls[1]!), {
    path: `v1/blocks/${UIB_PAGE_ID}/children`,
    method: 'GET',
  });
  assert.ok(mock.calls[1]!.args.includes('page_size==100'));
  assert.equal(mock.calls[1]!.input, undefined, 'GET children carries no stdin body');
  // Deletes — one per child.
  assert.deepEqual(apiOf(mock.calls[2]!), {
    path: 'v1/blocks/cccc0000-0000-0000-0000-000000000001',
    method: 'DELETE',
  });
  assert.deepEqual(apiOf(mock.calls[3]!), {
    path: 'v1/blocks/cccc0000-0000-0000-0000-000000000002',
    method: 'DELETE',
  });
  // Append — replacement paragraph blocks via stdin.
  assert.deepEqual(apiOf(mock.calls[4]!), {
    path: `v1/blocks/${UIB_PAGE_ID}/children`,
    method: 'PATCH',
  });
  const appendBody = inputJson(mock.calls[4]!) as {
    children: Array<{
      object: string;
      type: string;
      paragraph: { rich_text: Array<{ text: { content: string } }> };
    }>;
  };
  assert.equal(appendBody.children.length, 1);
  assert.equal(appendBody.children[0]?.type, 'paragraph');
  assert.equal(
    appendBody.children[0]?.paragraph.rich_text[0]?.text.content,
    'fresh body',
  );
  for (const call of mock.calls) assertVersionPinned(call);
});

test('updateIssueBody: validation trio — non-string, forge footer, >64KiB; no calls issued', async () => {
  const { tracker, mock } = makeTracker([]);
  // 1. non-string input (programmer error)
  await assert.rejects(
    () => tracker.updateIssueBody(UIB_PAGE_ID, 42 as unknown as string),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  // 2. forge-managed footer in the body
  await assert.rejects(
    () =>
      tracker.updateIssueBody(
        UIB_PAGE_ID,
        'body with <!-- forge:task=FORGE-1 --> footer',
      ),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  // 3. byte cap
  await assert.rejects(
    () =>
      tracker.updateIssueBody(UIB_PAGE_ID, 'x'.repeat(NOTION_BODY_MAX_BYTES + 1)),
    (e: unknown) => e instanceof TrackerError && e.code === 'VALIDATION',
  );
  assert.equal(mock.calls.length, 0, 'must reject before issuing any ntn call');
});

test('updateIssueBody: missing forge_task_id → PRECONDITION_FAILED after fetch only', async () => {
  const { tracker, mock } = makeTracker([okResult(pageWithoutForgeTaskId)]);
  await assert.rejects(
    () =>
      tracker.updateIssueBody('cccc1111-2222-3333-4444-555566667777', 'body'),
    (e: unknown) =>
      e instanceof TrackerError && e.code === 'PRECONDITION_FAILED',
  );
  assert.equal(mock.calls.length, 1, 'no block mutation after failed precondition');
});

test('updateIssueBody: paginates children via start_cursor query arg', async () => {
  const { tracker, mock } = makeTracker([
    okResult(uibPage()),
    okResult(
      blockChildren(['cccc0000-0000-0000-0000-000000000001'], {
        nextCursor: 'cur-2',
      }),
    ),
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000002'])),
    okEmpty(), // delete 1
    okEmpty(), // delete 2
    okEmpty(), // append
  ]);
  await tracker.updateIssueBody(UIB_PAGE_ID, 'b');
  assert.ok(mock.calls[2]!.args.includes('start_cursor==cur-2'));
  const deletes = mock.calls.filter((c) => apiOf(c).method === 'DELETE');
  assert.equal(deletes.length, 2);
});

test('updateIssueBody: partial failure mid-delete → retriable error; re-run completes', async () => {
  // First run: delete of child 2 dies on transport. The page is now partial —
  // by design (no atomic replace on Notion); the op is idempotently
  // re-runnable.
  const { tracker } = makeTracker([
    okResult(uibPage()),
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002'])),
    okEmpty(),        // delete child 1 ok
    transportError(), // delete child 2 dies
  ]);
  await assert.rejects(
    () => tracker.updateIssueBody(UIB_PAGE_ID, 'body'),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'TRANSPORT' &&
      isRetriableTrackerErrorCode(e.code),
  );

  // Re-run (fresh state): lists whatever children remain, deletes, appends.
  const second = makeTracker([
    okResult(uibPage()),
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000002'])),
    okEmpty(), // delete remaining child
    okEmpty(), // append
  ]);
  await second.tracker.updateIssueBody(UIB_PAGE_ID, 'body');
  assert.equal(second.mock.calls.length, 4);
});

test('updateIssueBody: >2000-char body chunks rich_text items in the append', async () => {
  const { tracker, mock } = makeTracker([
    okResult(uibPage()),
    okResult(blockChildren([])),
    okEmpty(), // append (no deletes — page had no children)
  ]);
  await tracker.updateIssueBody(UIB_PAGE_ID, 'x'.repeat(4500));
  const appendBody = inputJson(mock.calls[2]!) as {
    children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
  };
  assert.equal(appendBody.children.length, 1);
  assert.deepEqual(
    appendBody.children[0]?.paragraph.rich_text.map((i) => i.text.content.length),
    [2000, 2000, 500],
  );
});

test('updateIssueBody: empty body deletes children and appends nothing', async () => {
  const { tracker, mock } = makeTracker([
    okResult(uibPage()),
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000001'])),
    okEmpty(), // delete
    // NO append step — MockNtn would throw on an unexpected call.
  ]);
  await tracker.updateIssueBody(UIB_PAGE_ID, '');
  assert.equal(mock.calls.length, 3);
});

test('updateIssueBody: forge metadata is untouched (no page-properties PATCH)', async () => {
  // forgeTaskId/blockerIds live in PAGE PROPERTIES on Notion, not body
  // footers — the block replace must never PATCH v1/pages.
  const { tracker, mock } = makeTracker([
    okResult(uibPage()),
    okResult(blockChildren(['cccc0000-0000-0000-0000-000000000001'])),
    okEmpty(),
    okEmpty(),
  ]);
  await tracker.updateIssueBody(UIB_PAGE_ID, 'new body');
  const pagePatches = mock.calls.filter(
    (c) => apiOf(c).path.startsWith('v1/pages/') && apiOf(c).method === 'PATCH',
  );
  assert.equal(pagePatches.length, 0);
});

// ─── setClaimFence — NOT_IMPLEMENTED stub (scope-dropped from FORGE-117) ─────

test('setClaimFence throws NOT_IMPLEMENTED pointing to the FORGE-167 follow-up', async () => {
  const { tracker, mock } = makeTracker([]);
  await assert.rejects(
    () =>
      tracker.setClaimFence('aaaa1111-2222-3333-4444-555566667777', {
        claimId: 'c1',
        generation: 0,
        ownerRunId: 'run-1',
      }),
    (e: unknown) =>
      e instanceof TrackerError &&
      e.code === 'NOT_IMPLEMENTED' &&
      /FORGE-167/.test(e.message) &&
      e.details?.followUpIssue === 'FORGE-167',
  );
  assert.equal(mock.calls.length, 0, 'must throw before issuing any ntn call');
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
    okResult(created),        // createIssue → POST v1/pages
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

  assert.deepEqual(
    mock.calls.map((c2) => apiOf(c2)),
    [
      { path: `v1/databases/${DB_ID}`, method: 'GET' },
      { path: 'v1/pages', method: 'POST' },
      { path: `v1/pages/${pageId}`, method: 'GET' },
      { path: `v1/pages/${pageId}`, method: 'PATCH' },
      { path: `v1/pages/${pageId}`, method: 'GET' },
      { path: `v1/pages/${pageId}`, method: 'PATCH' },
      { path: 'v1/comments', method: 'POST' },
      { path: `v1/pages/${pageId}`, method: 'PATCH' },
      { path: `v1/pages/${pageId}`, method: 'PATCH' },
    ],
  );
  for (const call of mock.calls) assertVersionPinned(call);
});

// ─── round-trip: createIssue → updateIssueBody → listActiveIssues ────────────

test('round-trip: updateIssueBody preserves forgeTaskId through listActiveIssues', async () => {
  const pageId = 'eeee1111-2222-3333-4444-555566667777';
  const page = buildPage({
    id: pageId,
    title: 'RT task',
    taskId: 'FORGE-RT',
    state: 'Todo',
  });
  const { tracker, mock } = makeTracker([
    okResult(databaseInfo),                    // createIssue → resolve data source
    okResult(page),                            // createIssue → POST v1/pages
    okResult(page),                            // updateIssueBody → fetch page
    okResult(blockChildren(['cccc0000-0000-0000-0000-00000000000a'])),
    okEmpty(),                                 // delete old child
    okEmpty(),                                 // append new body
    okResult({ results: [page], has_more: false, next_cursor: null }), // query (cached data source)
  ]);

  const created = await tracker.createIssue({
    title: 'RT task',
    body: 'original body',
    forgeTaskId: 'FORGE-RT',
    ownerType: 'backend-dev',
    acceptance: [],
    dependsOn: [],
  });
  assert.equal(created.forgeTaskId, 'FORGE-RT');

  await tracker.updateIssueBody(pageId, 'replaced body');

  const issues = await tracker.listActiveIssues();
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.forgeTaskId, 'FORGE-RT');

  // The body replace touched only block endpoints — page properties (where
  // forgeTaskId lives) were never PATCHed.
  const pagePatches = mock.calls.filter(
    (c) => apiOf(c).path.startsWith('v1/pages/') && apiOf(c).method === 'PATCH',
  );
  assert.equal(pagePatches.length, 0);
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
  const steps: MockStep[] = [okResult(databaseInfo)];
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
  //   → adapter must NOT issue a clearing patch call
  const competitorWon = buildPage({ id: pageId, claimedBy: 'agent-winner' });
  const { tracker, mock } = makeTracker([
    okResult(initial),       // claim.fetch
    okEmpty(),               // claim.write
    transportError(),        // claim.recheck attempt 1
    transportError(),        // claim.recheck attempt 2
    transportError(),        // claim.recheck attempt 3
    okResult(competitorWon), // cleanup-fetch
    // NO further steps: if adapter tried to clear, MockNtn would throw
    // "unexpected call".
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, 'transient_error');
  // 1 fetch + 1 write + 3 recheck-fetch + 1 cleanup-fetch = 6 calls
  // total, NO second PATCH (that would be the clear).
  const patchCount = mock.calls.filter((c) => apiOf(c).method === 'PATCH').length;
  assert.equal(patchCount, 1, 'only the initial claim write should occur');
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
  const stillOurs = buildPage({ id: pageId, claimedBy: 'agent-me' });
  const { tracker, mock } = makeTracker([
    okResult(initial),
    okEmpty(),
    transportError(),
    transportError(),
    transportError(),
    okResult(stillOurs), // cleanup-fetch shows we still own it
    okEmpty(),           // cleanup write — clear it
  ]);
  const r = await tracker.claim(pageId, 'agent-me');
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.reason, 'transient_error');
  const patchCount = mock.calls.filter((c) => apiOf(c).method === 'PATCH').length;
  assert.equal(patchCount, 2, 'initial claim write + conditional cleanup');
});

// ─── constants ───────────────────────────────────────────────────────────────

test('NOTION_* constants + CLAIM_SETTLE_MS exported', () => {
  assert.equal(typeof NOTION_LIST_LIMIT, 'number');
  assert.ok(NOTION_LIST_LIMIT > 0);
  assert.equal(typeof NOTION_RAW_PAGE_CAP, 'number');
  assert.ok(NOTION_RAW_PAGE_CAP > 0);
  assert.equal(typeof CLAIM_SETTLE_MS, 'number');
  assert.ok(CLAIM_SETTLE_MS > 0);
  assert.equal(NOTION_BODY_MAX_BYTES, 65_536);
  assert.equal(NOTION_API_VERSION, '2026-03-11');
});
