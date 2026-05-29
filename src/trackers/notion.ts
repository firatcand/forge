import { z } from 'zod';

import type { NotionTrackerConfig } from '../schemas/settings.ts';
import {
  NotionDatabaseQueryResponseSchema,
  NotionDatabaseSchema,
  NotionPageSchema,
  type NotionPage,
} from '../schemas/trackers.ts';
import {
  BaseTracker,
  type Logger,
  type NormalizeErrorHint,
  type WithRetryOpts,
} from './base.ts';
import type { ClaimFenceData } from './claim-fence.ts';
import { TrackerError } from './errors.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueListPage,
  IssueState,
} from './types.ts';

// ─── Public exec contract ────────────────────────────────────────────────────
//
// `McpCall` is the test seam — mocks pass a sequenced harness; production
// passes a Client+StdioClientTransport closure from notion-mcp-transport.ts.

export interface McpToolResult {
  isError?: boolean;
  content?: ReadonlyArray<{
    type: string;
    text?: string;
    [k: string]: unknown;
  }>;
  structuredContent?: unknown;
}

export type McpCall = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOTION_LIST_LIMIT = 200;
// Hard ceiling on raw pages fetched before we stop — defensive against runaway
// databases. With page_size=100 this is 5000 raw rows. Independent of
// NOTION_LIST_LIMIT, which caps the *active* rows we return.
export const NOTION_RAW_PAGE_CAP = 50;

// Property names. The adapter expects the user's database to have these
// columns. Schema requirements documented in docs/adapters/notion.md.
const PROP_TITLE = 'Name';
const PROP_TASK_ID = 'forge_task_id';
const PROP_CLAIMED_BY = 'forge_claimed_by';
const PROP_STATE = 'state';
const PROP_BLOCKED_BY = 'forge_blocked_by';
const PROP_OWNER_TYPE = 'forge_owner_type';
const PROP_ACCEPTANCE = 'forge_acceptance';

const STATE_TO_NOTION: Readonly<Record<IssueState, string>> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
};

const NOTION_TO_STATE: Readonly<Record<string, IssueState>> = {
  Todo: 'todo',
  'In Progress': 'in_progress',
  'In Review': 'in_review',
  Done: 'done',
  Cancelled: 'cancelled',
  Blocked: 'blocked',
};

// ─── Error classification (per-adapter; BaseTracker stays generic) ───────────
//
// Notion tool results signal errors two ways:
//  1. JSON-RPC level: SDK throws McpError with a numeric code (transport,
//     timeout, parse error, ...). Caught as a thrown error.
//  2. Tool level: result has `isError: true` and content[0].text contains a
//     Notion error JSON (`{ object: 'error', code, message }`).
//
// `runTool()` collapses (2) into a thrown TrackerError so callers see a
// single error model. classifyNotionError() handles both forms.
//
// Branch order is load-bearing — mirrors github.ts comment:
//   AUTH before NOT_FOUND (Notion sometimes returns generic "not found"
//   for permission denials to avoid leaking existence).
//   VALIDATION before CONFLICT (validation errors can mention conflicts).

export interface NotionErrorBody {
  object?: string;
  code?: string;
  message?: string;
  status?: number;
  retry_after?: number;
}

interface ErrorLike {
  code?: string | number;
  message?: string;
  data?: unknown;
}

function isErrorLike(err: unknown): err is ErrorLike {
  return typeof err === 'object' && err !== null;
}

const JSONRPC_CONNECTION_CLOSED = -32000;
const JSONRPC_REQUEST_TIMEOUT = -32001;
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export function classifyNotionError(err: unknown): NormalizeErrorHint {
  if (!isErrorLike(err)) return { code: 'UNKNOWN' };

  // Notion errors take precedence: when the MCP SDK throws a JSON-RPC error
  // it can still carry the provider error body in `data` (e.g. -32603
  // Internal Error wrapping `object_not_found` / `rate_limited`). Always
  // check the embedded Notion code first; fall back to JSON-RPC numeric
  // codes only when no provider body is present.
  const body = extractNotionErrorBody(err);
  if (body?.code !== undefined) {
    const notionCode = body.code;

    if (notionCode === 'unauthorized' || notionCode === 'restricted_resource') {
      return { code: 'AUTH', details: { notionCode, message: body.message } };
    }
    if (notionCode === 'object_not_found') {
      return {
        code: 'NOT_FOUND',
        details: { notionCode, message: body.message },
      };
    }
    if (notionCode === 'rate_limited') {
      const retryAfterMs =
        typeof body.retry_after === 'number'
          ? body.retry_after * 1000
          : undefined;
      return {
        code: 'RATE_LIMITED',
        details: {
          notionCode,
          message: body.message,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      };
    }
    if (
      notionCode === 'validation_error' ||
      notionCode === 'invalid_request_url' ||
      notionCode === 'invalid_json' ||
      notionCode === 'invalid_request'
    ) {
      return {
        code: 'VALIDATION',
        details: { notionCode, message: body.message },
      };
    }
    if (
      notionCode === 'conflict_error' ||
      notionCode === 'concurrent_edit'
    ) {
      return {
        code: 'CONFLICT',
        details: { notionCode, message: body.message },
      };
    }
    return {
      code: 'UNKNOWN',
      details: { notionCode, message: body.message },
    };
  }

  // No embedded Notion body — fall back to JSON-RPC numeric codes.
  if (typeof err.code === 'number') {
    switch (err.code) {
      case JSONRPC_CONNECTION_CLOSED:
        return { code: 'TRANSPORT', details: { reason: 'connection-closed' } };
      case JSONRPC_REQUEST_TIMEOUT:
        return { code: 'TIMEOUT', details: { reason: 'request-timeout' } };
      case JSONRPC_PARSE_ERROR:
      case JSONRPC_INVALID_REQUEST:
      case JSONRPC_INVALID_PARAMS:
        return { code: 'VALIDATION', details: { jsonrpcCode: err.code } };
      case JSONRPC_INTERNAL_ERROR:
      default:
        return { code: 'UNKNOWN', details: { jsonrpcCode: err.code } };
    }
  }

  const message = String(err.message ?? '');
  if (/timeout|timed[\s_-]?out/i.test(message)) {
    return { code: 'TIMEOUT', details: { message } };
  }
  if (
    /connection (?:refused|reset|closed)|ECONNRESET|EAI_AGAIN|spawn/i.test(
      message,
    )
  ) {
    return { code: 'TRANSPORT', details: { message } };
  }

  return { code: 'UNKNOWN', details: { message } };
}

function extractNotionErrorBody(err: unknown): NotionErrorBody | undefined {
  if (!isErrorLike(err)) return undefined;
  // McpError carries data with the tool's error payload.
  if (err.data !== undefined && isErrorLike(err.data)) {
    if (err.data.code !== undefined || err.data.message !== undefined) {
      return err.data as NotionErrorBody;
    }
  }
  // Raw Notion error body passed through (test fixtures).
  if ('object' in (err as object) && (err as NotionErrorBody).object === 'error') {
    return err as NotionErrorBody;
  }
  // Heuristic: object with `code` string + `message` string. Pass through
  // retry_after / status when present so the classifier sees the full body.
  if (typeof err.code === 'string' && typeof err.message === 'string') {
    const body: NotionErrorBody = { code: err.code, message: err.message };
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.retry_after === 'number') {
      body.retry_after = anyErr.retry_after;
    }
    if (typeof anyErr.status === 'number') {
      body.status = anyErr.status;
    }
    return body;
  }
  return undefined;
}

// ─── Property accessors (pure) ───────────────────────────────────────────────

export function readRichText(page: NotionPage, propName: string): string {
  const prop = page.properties[propName];
  if (prop === undefined) return '';
  if (prop.type !== 'rich_text') return '';
  // narrowed via discriminator
  const items = (prop as { type: 'rich_text'; rich_text: Array<{ plain_text: string }> }).rich_text;
  return items.map((i) => i.plain_text).join('');
}

export function readTitle(page: NotionPage, propName: string): string {
  const prop = page.properties[propName];
  if (prop === undefined) return '';
  if (prop.type !== 'title') return '';
  const items = (prop as { type: 'title'; title: Array<{ plain_text: string }> }).title;
  return items.map((i) => i.plain_text).join('');
}

export function readStatus(page: NotionPage, propName: string): string | null {
  const prop = page.properties[propName];
  if (prop === undefined) return null;
  if (prop.type !== 'status') return null;
  const v = (prop as { type: 'status'; status: { name: string } | null }).status;
  return v?.name ?? null;
}

// ─── Forge metadata serializers (pure) ───────────────────────────────────────

function richTextPayload(text: string): Array<{ text: { content: string } }> {
  if (text.length === 0) return [];
  // Notion caps each rich_text element at 2000 chars; chunk defensively.
  const chunks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

function richTextProp(text: string): Record<string, unknown> {
  return { rich_text: richTextPayload(text) };
}

function titleProp(text: string): Record<string, unknown> {
  return { title: richTextPayload(text) };
}

function statusProp(name: string): Record<string, unknown> {
  return { status: { name } };
}

function parseBlockerList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─── Issue mapping ───────────────────────────────────────────────────────────

function pageToIssue(page: NotionPage, dbId: string): Issue {
  const title = readTitle(page, PROP_TITLE);
  const stateName = readStatus(page, PROP_STATE);
  const state: IssueState =
    stateName !== null && NOTION_TO_STATE[stateName] !== undefined
      ? NOTION_TO_STATE[stateName]
      : 'todo';
  const forgeTaskId = readRichText(page, PROP_TASK_ID);
  const blockerRaw = readRichText(page, PROP_BLOCKED_BY);
  const issue: Issue = {
    id: page.id,
    identifier: shortIdentifier(page.id, dbId),
    title,
    state,
    blockerIds: parseBlockerList(blockerRaw),
  };
  if (page.url !== undefined) issue.url = page.url;
  if (forgeTaskId.length > 0) issue.forgeTaskId = forgeTaskId;
  return issue;
}

// Notion page IDs are dash-stripped UUIDs in the API but are formatted with
// dashes in URLs. Use the last 8 hex chars as the short identifier — same
// convention Notion itself uses in its UI.
function shortIdentifier(pageId: string, _dbId: string): string {
  const cleaned = pageId.replace(/-/g, '');
  return `notion-${cleaned.slice(-8)}`;
}

// ─── Page-ID parsing ─────────────────────────────────────────────────────────
//
// Accept either a bare 32-char hex ID (with or without dashes) or a full
// Notion URL containing one. Mirrors GitHubTracker.parseIssueNumber.

const UUID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

export function parseNotionPageId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = trimmed.match(UUID_RE);
  if (match === null) {
    throw new TrackerError(
      'VALIDATION',
      `Could not parse Notion page ID from: ${idOrUrl}`,
      { issueId: idOrUrl },
    );
  }
  // Canonical form: lowercase with dashes (8-4-4-4-12).
  const cleaned = match[0].replace(/-/g, '').toLowerCase();
  return [
    cleaned.slice(0, 8),
    cleaned.slice(8, 12),
    cleaned.slice(12, 16),
    cleaned.slice(16, 20),
    cleaned.slice(20, 32),
  ].join('-');
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface NotionTrackerOptions {
  mcp: McpCall;
  retry?: WithRetryOpts;
  // Override for tests; default is real setTimeout.
  sleep?: (ms: number) => Promise<void>;
}

// Post-write settle delay before claim recheck. Notion has no true CAS; this
// window lets a near-simultaneous competing write land before we re-read.
// 250ms is empirical — matches the typical inter-agent gap when two
// orchestrators on the same DB tick close together. See docs/adapters/notion.md
// for the residual race window that remains for orchestrators offset by more
// than CLAIM_SETTLE_MS.
export const CLAIM_SETTLE_MS = 250;

export class NotionTracker extends BaseTracker<NotionTrackerConfig> {
  readonly type = 'notion' as const;

  private readonly mcp: McpCall;
  private readonly databaseId: string;
  private readonly retryOpts: WithRetryOpts;
  private readonly sleep: (ms: number) => Promise<void>;
  // Cache of the database's primary data_source_id. Notion's 2025-09 schema
  // splits databases into containers + data sources; pages live under a data
  // source, not the database. We discover this lazily so callers configure
  // only database_id in settings.yaml (familiar UX) — first call resolves.
  private dataSourceIdCache: string | undefined;

  constructor(
    config: NotionTrackerConfig,
    logger: Logger,
    options: NotionTrackerOptions,
  ) {
    super(config, logger);
    this.mcp = options.mcp;
    this.databaseId = config.config.database_id;
    this.retryOpts = options.retry ?? {};
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // Resolves the database's primary data_source_id. Cached after first call.
  // Throws PRECONDITION_FAILED if the database has no data sources, or if it
  // has multiple (ambiguous — settings should call out which one).
  private async resolveDataSourceId(op: string): Promise<string> {
    if (this.dataSourceIdCache !== undefined) return this.dataSourceIdCache;
    const raw = await this.runTool(
      'API-retrieve-a-database',
      { database_id: this.databaseId },
      op,
    );
    if (raw === null || typeof raw !== 'object') {
      throw new TrackerError(
        'VALIDATION',
        `${op}: API-retrieve-a-database returned unexpected shape`,
        { databaseId: this.databaseId },
      );
    }
    const sources = (raw as { data_sources?: Array<{ id: string }> }).data_sources;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `${op}: database ${this.databaseId} has no data sources`,
        { databaseId: this.databaseId },
      );
    }
    if (sources.length > 1) {
      // Multiple data sources — pick the first but log warning. Future config
      // could add an explicit data_source_id override.
      this.logger.warn('tracker.resolveDataSourceId', {
        reason: 'multiple-data-sources',
        count: sources.length,
        chose: sources[0]?.id,
      });
    }
    const id = sources[0]?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TrackerError(
        'VALIDATION',
        `${op}: data_sources[0].id missing`,
        { databaseId: this.databaseId },
      );
    }
    this.dataSourceIdCache = id;
    return id;
  }

  // ─── runTool — central seam invoker ────────────────────────────────────────
  //
  // Calls the MCP tool, normalizes tool-level isError into a thrown
  // TrackerError, and returns the parsed JSON body of content[0].text if
  // present. Returns null for tools with no body content (e.g. acks).

  private async runTool(
    toolName: string,
    args: Record<string, unknown>,
    op: string,
  ): Promise<unknown> {
    let result: McpToolResult;
    try {
      result = await this.mcp(toolName, args);
    } catch (err) {
      throw this.normalizeError(op, err, classifyNotionError(err));
    }

    if (result.isError === true) {
      const text = readToolText(result);
      const parsed = tryParseJson(text);
      const hint = classifyNotionError(parsed ?? { message: text });
      throw this.normalizeError(op, parsed ?? new Error(text), hint);
    }

    if (result.structuredContent !== undefined) return result.structuredContent;

    const text = readToolText(result);
    if (text.length === 0) return null;
    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      throw this.normalizeError(op, new Error('tool-result-not-json'), {
        code: 'VALIDATION',
        details: { reason: 'tool-result-not-json', preview: text.slice(0, 500) },
      });
    }
    // The Notion MCP server returns Notion error bodies (status >= 400) as
    // *successful* tool calls — isError is undefined, content[0].text is the
    // error JSON. Detect by shape (`object: 'error'`) and route through the
    // same error path as McpError-thrown failures.
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { object?: string }).object === 'error'
    ) {
      const hint = classifyNotionError(parsed);
      throw this.normalizeError(op, parsed, hint);
    }
    return parsed;
  }

  // ─── healthCheck — never throws ────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.runTool('API-get-self', {}, 'healthCheck');
      return { ok: true };
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'unknown error';
      return { ok: false, detail };
    }
  }

  // ─── listActiveIssues ──────────────────────────────────────────────────────
  //
  // Queries the database. Filters out archived + done/cancelled states so the
  // orchestrator's eligibility pass doesn't have to.

  async listActiveIssues(): Promise<Issue[]> {
    const page = await this.listFiltered(false, 'listActiveIssues');
    return page.issues;
  }

  // All issues incl. done/cancelled (still excludes archived/trashed pages,
  // which are genuinely removed) — see Tracker.listAllIssues.
  async listAllIssues(): Promise<IssueListPage> {
    return this.listFiltered(true, 'listAllIssues');
  }

  private async listFiltered(
    includeTerminal: boolean,
    op: string,
  ): Promise<IssueListPage> {
    return this.withRetry(
      op,
      async () => {
        const dataSourceId = await this.resolveDataSourceId(op);
        const issues: Issue[] = [];
        let cursor: string | undefined;
        let rawPagesFetched = 0;
        const pageSize = 100;

        // Paginate until: (a) we accumulate NOTION_LIST_LIMIT matching issues,
        // (b) the database has no more results, or (c) we hit the raw-page
        // safety cap. Stopping early based on raw-page count (the prior bug)
        // could miss active work in databases with many Done/Cancelled rows
        // at the front of the result order — filtering happens client-side.
        while (
          issues.length < NOTION_LIST_LIMIT &&
          rawPagesFetched < NOTION_RAW_PAGE_CAP
        ) {
          const args: Record<string, unknown> = {
            data_source_id: dataSourceId,
            page_size: pageSize,
          };
          if (cursor !== undefined) args.start_cursor = cursor;

          const raw = await this.runTool('API-query-data-source', args, op);

          let parsed;
          try {
            parsed = NotionDatabaseQueryResponseSchema.parse(raw);
          } catch (err) {
            throw this.normalizeError(op, err, {
              code: 'VALIDATION',
              details: { reason: 'database-query-parse-failed' },
            });
          }

          for (const page of parsed.results) {
            if (page.archived === true) continue;
            const issue = pageToIssue(page, this.databaseId);
            const terminal =
              issue.state === 'done' || issue.state === 'cancelled';
            if (includeTerminal || !terminal) {
              issues.push(issue);
              if (issues.length >= NOTION_LIST_LIMIT) break;
            }
          }

          rawPagesFetched++;
          if (parsed.has_more === true && parsed.next_cursor) {
            cursor = parsed.next_cursor;
          } else {
            break;
          }
        }

        const limitHit = issues.length >= NOTION_LIST_LIMIT;
        const capHit = rawPagesFetched >= NOTION_RAW_PAGE_CAP;
        if (limitHit) {
          this.logger.warn(`tracker.${op}`, {
            reason: 'limit-hit',
            limit: NOTION_LIST_LIMIT,
            databaseId: this.databaseId,
          });
        } else if (capHit) {
          this.logger.warn(`tracker.${op}`, {
            reason: 'raw-page-cap-hit',
            cap: NOTION_RAW_PAGE_CAP,
            databaseId: this.databaseId,
          });
        }

        return {
          issues: issues.slice(0, NOTION_LIST_LIMIT),
          truncated: limitHit || capHit,
        };
      },
      this.retryOpts,
    );
  }

  // ─── claim — load-bearing atomic-with-tiebreak primitive ───────────────────
  //
  // Notion has no true CAS. Pattern (mirrors GitHubTracker.claim):
  //   1. Fetch page; read forge_claimed_by and last_edited_time T1
  //   2. If claimed by someone else → already_claimed (no write)
  //   3. Write forge_claimed_by = runId
  //   4. Re-fetch; if our value sticks → ok; else lost-tiebreak
  //
  // T1/T2 are recorded in the result detail for debuggability but the
  // arbitration is purely value-based: last-write-wins per field is what
  // Notion guarantees, so the re-read is what arbitrates.

  async claim(issueId: string, runId: string): Promise<ClaimResult> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    const pageId = parseNotionPageId(issueId);

    // Step 1: fetch.
    let initial: NotionPage;
    try {
      initial = await this.withRetry(
        'claim.fetch',
        () => this.fetchPage(pageId),
        this.retryOpts,
      );
    } catch (err) {
      if (err instanceof TrackerError) {
        if (err.code === 'NOT_FOUND') {
          return {
            ok: false,
            reason: 'version_conflict',
            detail: 'page-not-found-on-initial-fetch',
          };
        }
        if (isTransientCode(err.code)) {
          return { ok: false, reason: 'transient_error', detail: err.message };
        }
      }
      throw err;
    }

    if (initial.archived === true) {
      return {
        ok: false,
        reason: 'version_conflict',
        detail: 'page-archived',
      };
    }

    const existing = readRichText(initial, PROP_CLAIMED_BY);
    if (existing.length > 0 && existing !== runId) {
      return {
        ok: false,
        reason: 'already_claimed',
        detail: existing,
      };
    }
    if (existing === runId) {
      // Idempotent: already ours.
      return { ok: true };
    }

    // Step 2: write.
    try {
      await this.runTool(
        'API-patch-page',
        {
          page_id: pageId,
          properties: { [PROP_CLAIMED_BY]: richTextProp(runId) },
        },
        'claim.write',
      );
    } catch (err) {
      if (err instanceof TrackerError) {
        if (err.code === 'NOT_FOUND') {
          return {
            ok: false,
            reason: 'version_conflict',
            detail: 'page-not-found-on-write',
          };
        }
        if (isTransientCode(err.code)) {
          return { ok: false, reason: 'transient_error', detail: err.message };
        }
      }
      throw err;
    }

    // Settle delay before recheck. Without this, A and B can each write,
    // immediately re-fetch their own value, and both return ok before either
    // sees the other. CLAIM_SETTLE_MS gives a near-simultaneous competing
    // write time to land. Residual race for writes offset by > CLAIM_SETTLE_MS
    // is documented in docs/adapters/notion.md.
    await this.sleep(CLAIM_SETTLE_MS);

    // Step 3: re-fetch.
    let post: NotionPage;
    try {
      post = await this.withRetry(
        'claim.recheck',
        () => this.fetchPage(pageId),
        this.retryOpts,
      );
    } catch (err) {
      // Conditional cleanup: only clear if the field is still our runId.
      // Unconditional clearing here could erase a winning competitor's claim
      // — there is only one forge_claimed_by field, not a per-run label.
      await this.tryClearClaimIfOwned(pageId, runId);
      if (err instanceof TrackerError) {
        if (err.code === 'NOT_FOUND') {
          // Page archived/deleted between our write and the recheck. Same
          // recoverable shape the initial-fetch/write paths use.
          return {
            ok: false,
            reason: 'version_conflict',
            detail: 'page-not-found-on-recheck',
          };
        }
        if (isTransientCode(err.code)) {
          return { ok: false, reason: 'transient_error', detail: err.message };
        }
      }
      throw err;
    }

    const winner = readRichText(post, PROP_CLAIMED_BY);
    if (winner === runId) return { ok: true };
    if (winner.length === 0) {
      // Our write didn't stick. Treat as version_conflict; let the poll loop
      // retry on the next tick.
      return {
        ok: false,
        reason: 'version_conflict',
        detail: 'write-not-visible',
      };
    }
    // Someone else won (or wrote a different value over ours).
    return {
      ok: false,
      reason: 'version_conflict',
      detail: `lost-tiebreak-to:${winner}`,
    };
  }

  // ─── releaseClaim — idempotent ─────────────────────────────────────────────
  //
  // v2 contract (FORGE-72): accepts (issueId, runId). runId is validated but
  // NOT YET USED to scope removal — explicit AC-permitted stub. Targeted
  // removal (clear only if the page's forge_claimed_by matches the caller's
  // runId) lands in a follow-up alongside Notion's verify-on-readback CAS.
  //
  // Stub behavior: clears the forge_claimed_by property unconditionally.
  // Same broad-clear policy as GitHubTracker/LinearTracker. The orchestrator
  // only invokes this on issues it owns or is explicitly cleaning up.

  async releaseClaim(issueId: string, runId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    // TODO: use runId to scope removal to claims this run actually owns.
    void runId;
    const pageId = parseNotionPageId(issueId);
    try {
      await this.runTool(
        'API-patch-page',
        {
          page_id: pageId,
          properties: { [PROP_CLAIMED_BY]: richTextProp('') },
        },
        'releaseClaim',
      );
    } catch (err) {
      if (err instanceof TrackerError && err.code === 'NOT_FOUND') {
        return; // page archived/gone — nothing to release
      }
      throw err;
    }
  }

  // ─── updateState ───────────────────────────────────────────────────────────

  async updateState(issueId: string, state: IssueState): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    const pageId = parseNotionPageId(issueId);
    const notionState = STATE_TO_NOTION[state];
    try {
      await this.runTool(
        'API-patch-page',
        {
          page_id: pageId,
          properties: { [PROP_STATE]: statusProp(notionState) },
        },
        'updateState',
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('updateState', err, classifyNotionError(err));
    }
  }

  // ─── comment ───────────────────────────────────────────────────────────────

  async comment(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(body, 'body');
    const pageId = parseNotionPageId(issueId);
    try {
      await this.runTool(
        'API-create-a-comment',
        {
          parent: { page_id: pageId },
          rich_text: richTextPayload(body),
        },
        'comment',
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('comment', err, classifyNotionError(err));
    }
  }

  // ─── createProject → Notion database ───────────────────────────────────────
  //
  // Creates a child database under a parent page. The caller passes
  // `parent_page_id` via the `description` slot is awkward — instead we
  // require it via config or the spec's `/push-to-tracker` flow. Here we
  // assume the parent page ID is the configured database_id's parent — but
  // since we don't always know that, accept it via env var
  // `FORGE_NOTION_PARENT_PAGE_ID` for the bootstrap call.
  //
  // This is the same pattern as GitHubTracker.createProject, which depends
  // on the configured repo being writable. For Notion, the parent page must
  // exist and be in the user's workspace.

  async createProject(
    name: string,
    description?: string,
  ): Promise<{ id: string; url: string }> {
    this.assertNonEmpty(name, 'name');

    const parentPageId = process.env.FORGE_NOTION_PARENT_PAGE_ID;
    if (parentPageId === undefined || parentPageId.length === 0) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        'createProject: set FORGE_NOTION_PARENT_PAGE_ID to the page under which the new database should be created',
      );
    }

    // Notion's 2025-09 schema requires creating a data source under a page;
    // the data source itself owns the parent database. Construct properties
    // matching the forge schema (status options + rich_text columns).
    const args: Record<string, unknown> = {
      parent: { type: 'page_id', page_id: parseNotionPageId(parentPageId) },
      title: richTextPayload(name),
      properties: defaultDatabaseProperties(),
    };
    if (description !== undefined && description.length > 0) {
      args.description = richTextPayload(description);
    }

    let raw: unknown;
    try {
      raw = await this.runTool(
        'API-create-a-data-source',
        args,
        'createProject',
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError(
        'createProject',
        err,
        classifyNotionError(err),
      );
    }

    let parsed;
    try {
      parsed = NotionDatabaseSchema.parse(raw);
    } catch (err) {
      throw this.normalizeError('createProject', err, {
        code: 'VALIDATION',
        details: { reason: 'database-parse-failed' },
      });
    }

    return {
      id: parsed.id,
      url: parsed.url ?? `https://www.notion.so/${parsed.id.replace(/-/g, '')}`,
    };
  }

  // ─── createIssue ───────────────────────────────────────────────────────────

  async createIssue(payload: CreateIssuePayload): Promise<Issue> {
    this.assertNonEmpty(payload.title, 'payload.title');
    this.assertNonEmpty(payload.forgeTaskId, 'payload.forgeTaskId');
    this.assertNonEmpty(payload.ownerType, 'payload.ownerType');

    const dataSourceId = await this.resolveDataSourceId('createIssue');

    const properties: Record<string, unknown> = {
      [PROP_TITLE]: titleProp(payload.title),
      [PROP_TASK_ID]: richTextProp(payload.forgeTaskId),
      [PROP_OWNER_TYPE]: richTextProp(payload.ownerType),
      [PROP_STATE]: statusProp(STATE_TO_NOTION.todo),
      [PROP_CLAIMED_BY]: richTextProp(''),
      [PROP_BLOCKED_BY]: richTextProp(''),
      [PROP_ACCEPTANCE]: richTextProp(payload.acceptance.join('\n')),
    };

    // API-post-page's schema *declares* `children: array of string` but the
    // server actually rejects strings with validation_error and accepts plain
    // block objects. Verified against @notionhq/notion-mcp-server@2.2.1.
    const children = buildIssueChildren(payload);

    const args: Record<string, unknown> = {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties,
      ...(children.length > 0 ? { children } : {}),
    };

    let raw: unknown;
    try {
      raw = await this.runTool('API-post-page', args, 'createIssue');
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('createIssue', err, classifyNotionError(err));
    }

    let parsed: NotionPage;
    try {
      parsed = NotionPageSchema.parse(raw);
    } catch (err) {
      throw this.normalizeError('createIssue', err, {
        code: 'VALIDATION',
        details: { reason: 'created-page-parse-failed' },
      });
    }

    return pageToIssue(parsed, this.databaseId);
  }

  // ─── setBlockedBy — comma-append, dedup ────────────────────────────────────

  async setBlockedBy(issueId: string, blockerId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(blockerId, 'blockerId');
    const pageId = parseNotionPageId(issueId);
    // Validate blockerId is also a parseable Notion ID.
    const normalizedBlockerId = parseNotionPageId(blockerId);

    let page: NotionPage;
    try {
      page = await this.fetchPage(pageId);
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('setBlockedBy', err, classifyNotionError(err));
    }

    const forgeTaskId = readRichText(page, PROP_TASK_ID);
    if (forgeTaskId.length === 0) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `setBlockedBy: page ${pageId} has no ${PROP_TASK_ID} property; was it created outside of forge?`,
        { issueId, pageId },
      );
    }

    const current = parseBlockerList(readRichText(page, PROP_BLOCKED_BY));
    if (current.includes(normalizedBlockerId)) return; // dedup

    const next = [...current, normalizedBlockerId].join(',');

    try {
      await this.runTool(
        'API-patch-page',
        {
          page_id: pageId,
          properties: { [PROP_BLOCKED_BY]: richTextProp(next) },
        },
        'setBlockedBy',
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('setBlockedBy', err, classifyNotionError(err));
    }
  }

  // ─── updateIssueBody — NOT_IMPLEMENTED stub (FORGE-94 → FORGE-117) ─────────
  //
  // The full implementation lands in FORGE-117 as part of the NotionTracker
  // refactor onto the `ntn` CLI transport (https://developers.notion.com/cli).
  // Until then, /reconcile --push and /apply-decision MUST skip Notion-backed
  // projects.
  async updateIssueBody(_issueId: string, _body: string): Promise<void> {
    throw new TrackerError(
      'NOT_IMPLEMENTED',
      `NotionTracker.updateIssueBody is not implemented in this release. ` +
        `Tracked in FORGE-117: refactor NotionTracker to ntn CLI transport. ` +
        `Until then, /reconcile --push and /apply-decision must skip Notion-backed projects.`,
      { followUpIssue: 'FORGE-117' },
    );
  }

  // ─── setClaimFence — NOT_IMPLEMENTED stub (FORGE-167 → FORGE-117) ──────────
  //
  // The forge:claim footer write rides the same body read-modify-write as
  // updateIssueBody, which Notion's content-block model can't do until the
  // FORGE-117 ntn CLI refactor. Claim/cancel call this best-effort, so a
  // Notion-backed project simply skips footer mirroring (warn, no failure).
  async setClaimFence(
    _issueId: string,
    _data: ClaimFenceData | null,
  ): Promise<void> {
    throw new TrackerError(
      'NOT_IMPLEMENTED',
      `NotionTracker.setClaimFence is not implemented in this release. ` +
        `Tracked in FORGE-117: refactor NotionTracker to ntn CLI transport. ` +
        `Until then, claim/cancel skip forge:claim footer mirroring for Notion.`,
      { followUpIssue: 'FORGE-117' },
    );
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private async fetchPage(pageId: string): Promise<NotionPage> {
    let raw: unknown;
    try {
      raw = await this.runTool(
        'API-retrieve-a-page',
        { page_id: pageId },
        'fetchPage',
      );
    } catch (err) {
      throw err instanceof TrackerError
        ? err
        : this.normalizeError('fetchPage', err, classifyNotionError(err));
    }
    try {
      return NotionPageSchema.parse(raw);
    } catch (err) {
      throw this.normalizeError('fetchPage', err, {
        code: 'VALIDATION',
        details: { reason: 'page-parse-failed', pageId },
      });
    }
  }

  // Conditional cleanup: re-fetch first, only clear forge_claimed_by if it
  // still equals our runId. Prevents stealing a competitor's claim in the
  // recheck-failure path where we can't tell if our write or theirs landed.
  // Failures are best-effort — logged, not thrown (caller is already in an
  // error path).
  private async tryClearClaimIfOwned(
    pageId: string,
    runId: string,
  ): Promise<void> {
    let page: NotionPage;
    try {
      page = await this.fetchPage(pageId);
    } catch (err) {
      this.logger.warn('tracker.tryClearClaimIfOwned', {
        pageId,
        reason: 'cleanup-fetch-failed',
        err: errToString(err),
      });
      return;
    }
    const current = readRichText(page, PROP_CLAIMED_BY);
    if (current !== runId) {
      this.logger.warn('tracker.tryClearClaimIfOwned', {
        pageId,
        reason: 'not-owned-by-us',
        current,
      });
      return;
    }
    try {
      await this.runTool(
        'API-patch-page',
        {
          page_id: pageId,
          properties: { [PROP_CLAIMED_BY]: richTextProp('') },
        },
        'claim.cleanup',
      );
    } catch (err) {
      this.logger.warn('tracker.tryClearClaimIfOwned', {
        pageId,
        err: errToString(err),
      });
    }
  }
}

// ─── utils ───────────────────────────────────────────────────────────────────

function readToolText(result: McpToolResult): string {
  if (!result.content) return '';
  for (const c of result.content) {
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
  }
  return '';
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTransientCode(
  code: NormalizeErrorHint['code'],
): code is 'TRANSPORT' | 'TIMEOUT' | 'RATE_LIMITED' {
  return code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'RATE_LIMITED';
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function extractCreatedPage(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.pages) && obj.pages.length > 0) return obj.pages[0];
  if (Array.isArray(obj.results) && obj.results.length > 0) return obj.results[0];
  return raw;
}

function buildIssueChildren(
  payload: CreateIssuePayload,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (payload.body.length > 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richTextPayload(payload.body) },
    });
  }
  if (payload.acceptance.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: richTextPayload('Acceptance') },
    });
    for (const item of payload.acceptance) {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: richTextPayload(item), checked: false },
      });
    }
  }
  return blocks;
}

function defaultDatabaseProperties(): Record<string, unknown> {
  return {
    [PROP_TITLE]: { title: {} },
    [PROP_TASK_ID]: { rich_text: {} },
    [PROP_CLAIMED_BY]: { rich_text: {} },
    [PROP_STATE]: {
      status: {
        options: [
          { name: STATE_TO_NOTION.todo, color: 'gray' },
          { name: STATE_TO_NOTION.in_progress, color: 'blue' },
          { name: STATE_TO_NOTION.in_review, color: 'purple' },
          { name: STATE_TO_NOTION.done, color: 'green' },
          { name: STATE_TO_NOTION.cancelled, color: 'default' },
          { name: STATE_TO_NOTION.blocked, color: 'red' },
        ],
      },
    },
    [PROP_BLOCKED_BY]: { rich_text: {} },
    [PROP_OWNER_TYPE]: { rich_text: {} },
    [PROP_ACCEPTANCE]: { rich_text: {} },
  };
}

// Re-export for tests that want to construct error fixtures.
export { z };
