import { execa } from 'execa';
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
import { assertValidBodyInput } from './footers.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueListPage,
  IssueState,
} from './types.ts';

// ─── Public exec contract ────────────────────────────────────────────────────
//
// `NtnExec` is the test seam — exact mirror of github.ts's `GhExec`. Mocks
// pass a sequenced harness; production passes `defaultNtnExec`, which shells
// out to the official Notion CLI (`ntn`, https://developers.notion.com/cli).
// Auth comes from the user's keychain via `ntn login` — no token plumbing.

export interface NtnExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type NtnExec = (
  args: readonly string[],
  opts?: { input?: string },
) => Promise<NtnExecResult>;

export const defaultNtnExec: NtnExec = async (args, opts) => {
  // reject:false → nonzero exits RESOLVE with the result shape so callers
  // read Notion error bodies off stdout instead of catching ExecaError.
  // Spawn-level failures (ENOENT — ntn not installed) also resolve under
  // reject:false but carry no exitCode; re-throw those so the thrown-error
  // path of classifyNotionExecError sees the original `code: 'ENOENT'`.
  const result = await execa('ntn', [...args], {
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    reject: false,
  });
  if (result.failed && result.exitCode === undefined) {
    throw result; // ExecaError extends Error; carries .code (e.g. ENOENT)
  }
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: result.exitCode ?? 0,
  };
};

// ─── Constants ───────────────────────────────────────────────────────────────

// Pinned Notion API version sent on EVERY `ntn api` call via --notion-version.
// Pinned (not floating) so behavior is deterministic across adopter machines
// regardless of which `ntn` build they have installed. Bump deliberately and
// re-verify the endpoint payloads when you do.
export const NOTION_API_VERSION = '2026-03-11';

export const NOTION_LIST_LIMIT = 200;
// Hard ceiling on raw pages fetched before we stop — defensive against runaway
// databases. With page_size=100 this is 5000 raw rows. Independent of
// NOTION_LIST_LIMIT, which caps the *active* rows we return.
export const NOTION_RAW_PAGE_CAP = 50;
// Body byte cap for updateIssueBody — matches the GitHub/Linear convention of
// a 64 KiB provider cap (Notion's own per-rich_text limit is chars, handled by
// the 2000-char chunker; this caps total input like the other adapters).
export const NOTION_BODY_MAX_BYTES = 65_536;

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
// `ntn` failures surface two ways — mirror of classifyGitHubError:
//  1. Thrown: spawn-level errors (ENOENT when ntn isn't installed, ETIMEDOUT,
//     killed process). defaultNtnExec re-throws these.
//  2. Returned: nonzero exitCode with the Notion API error body
//     (`{ object: 'error', code, message }`) passed through on stdout
//     (occasionally stderr).
//
// classifyNotionExecError handles both shapes. Branch order is load-bearing —
// mirrors github.ts:
//   AUTH before NOT_FOUND (Notion sometimes returns generic "not found"
//   for permission denials to avoid leaking existence).
//   VALIDATION before CONFLICT (validation errors can mention conflicts).
// Unknown nonzero exits map to UNKNOWN (NOT retriable TRANSPORT) so a
// misbehaving CLI doesn't drive infinite retry loops.

export interface NotionErrorBody {
  object?: string;
  code?: string;
  message?: string;
  status?: number;
  retry_after?: number;
}

interface NtnErrorLike {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  code?: string;
  message?: string;
  timedOut?: boolean;
  object?: string;
  retry_after?: number;
  status?: number;
}

function isErrorLike(err: unknown): err is NtnErrorLike {
  return typeof err === 'object' && err !== null;
}

const NOTION_AUTH_CODES = new Set(['unauthorized', 'restricted_resource']);
const NOTION_VALIDATION_CODES = new Set([
  'validation_error',
  'invalid_request',
  'invalid_json',
  'invalid_request_url',
]);
const NOTION_CONFLICT_CODES = new Set(['conflict_error', 'concurrent_edit']);
const NOTION_5XX_CODES = new Set([
  'internal_server_error',
  'service_unavailable',
  'bad_gateway',
  // Official transient codes (developers.notion.com/reference/status-codes) —
  // without these, retryable provider failures would fall through to UNKNOWN
  // and never be retried (Codex impl-review).
  'database_connection_unavailable',
]);
// 504-class — distinct from generic transport so callers can apply
// timeout-specific backoff.
const NOTION_TIMEOUT_CODES = new Set(['gateway_timeout']);
// 503 "slow down" — semantically a rate signal, not an outage.
const NOTION_OVERLOAD_CODES = new Set(['service_overload']);

export function classifyNotionExecError(err: unknown): NormalizeErrorHint {
  if (!isErrorLike(err)) return { code: 'UNKNOWN' };
  const stdout = String(err.stdout ?? '');
  const stderr = String(err.stderr ?? '');
  const message = String(err.message ?? '');
  const exitCode = typeof err.exitCode === 'number' ? err.exitCode : -1;

  // Spawn failure: ntn binary missing.
  if (err.code === 'ENOENT') {
    return {
      code: 'TRANSPORT',
      details: {
        reason: 'ntn-not-installed',
        stderr,
        hint: 'install the Notion CLI (https://developers.notion.com/cli) and run `ntn login` — see docs/adapters/notion.md',
      },
    };
  }

  // Notion API error body — ntn passes the response through on stdout. Also
  // accept the body thrown/passed directly (tests, wrapped errors), and a
  // stderr-resident body as a fallback.
  const body =
    err.object === 'error' && typeof err.code === 'string'
      ? (err as NotionErrorBody)
      : (parseNotionErrorBody(stdout) ?? parseNotionErrorBody(stderr));
  if (body?.code !== undefined) {
    const notionCode = body.code;

    // AUTH must come before NOT_FOUND — Notion returns "not found" copy for
    // permission denials to avoid leaking existence.
    if (NOTION_AUTH_CODES.has(notionCode)) {
      return { code: 'AUTH', details: { notionCode, message: body.message } };
    }
    if (notionCode === 'object_not_found') {
      return {
        code: 'NOT_FOUND',
        details: { notionCode, message: body.message },
      };
    }
    if (notionCode === 'rate_limited' || NOTION_OVERLOAD_CODES.has(notionCode)) {
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
    if (NOTION_TIMEOUT_CODES.has(notionCode)) {
      return {
        code: 'TIMEOUT',
        details: { notionCode, message: body.message },
      };
    }
    // VALIDATION before CONFLICT — validation errors can mention conflicts.
    if (NOTION_VALIDATION_CODES.has(notionCode)) {
      return {
        code: 'VALIDATION',
        details: { notionCode, message: body.message },
      };
    }
    if (NOTION_CONFLICT_CODES.has(notionCode)) {
      return {
        code: 'CONFLICT',
        details: { notionCode, message: body.message },
      };
    }
    // 5xx-class provider errors are transient — retriable TRANSPORT.
    if (NOTION_5XX_CODES.has(notionCode)) {
      return {
        code: 'TRANSPORT',
        details: { notionCode, message: body.message },
      };
    }
    return {
      code: 'UNKNOWN',
      details: { notionCode, message: body.message },
    };
  }

  // No provider body — fall back to exec-level patterns.
  if (
    err.timedOut === true ||
    err.code === 'ETIMEDOUT' ||
    /timeout|timed[\s_-]?out|ETIMEDOUT/i.test(stderr) ||
    /timeout|timed[\s_-]?out|ETIMEDOUT/i.test(message)
  ) {
    return { code: 'TIMEOUT', details: { stderr, message } };
  }

  if (
    /spawn|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection (?:refused|reset|closed)|HTTP 5\d\d/i.test(
      `${stderr} ${message}`,
    )
  ) {
    return { code: 'TRANSPORT', details: { stderr, message, exitCode } };
  }

  // Unknown nonzero exit → UNKNOWN, NOT retriable TRANSPORT.
  return { code: 'UNKNOWN', details: { stderr, exitCode } };
}

function parseNotionErrorBody(text: string): NotionErrorBody | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { object?: string }).object === 'error' &&
    typeof (parsed as { code?: unknown }).code === 'string'
  ) {
    return parsed as NotionErrorBody;
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

// Shared body→blocks chunker used by createIssue (children) and
// updateIssueBody (replacement children). Notion limits:
//   - 2000 chars per rich_text item (richTextPayload chunks)
//   - 100 rich_text items per block (split into multiple paragraphs beyond)
// Empty body → no blocks.
export function bodyToParagraphBlocks(
  text: string,
): Array<Record<string, unknown>> {
  const items = richTextPayload(text);
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < items.length; i += 100) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: items.slice(i, i + 100) },
    });
  }
  return blocks;
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

// ─── Local response schemas ──────────────────────────────────────────────────
//
// Block-children list (GET /v1/blocks/{id}/children) — only the fields
// updateIssueBody reads. Kept local: no other module consumes this shape.

const NotionBlockChildrenResponseSchema = z.object({
  results: z.array(z.object({ id: z.string().min(1) })),
  next_cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional(),
});

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface NotionTrackerOptions {
  ntn: NtnExec;
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

  private readonly ntn: NtnExec;
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
    this.ntn = options.ntn;
    this.databaseId = config.config.database_id;
    this.retryOpts = options.retry ?? {};
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // Resolves the database's primary data_source_id. Cached after first call.
  // Throws PRECONDITION_FAILED if the database has no data sources, or warns
  // and picks the first if it has multiple.
  private async resolveDataSourceId(op: string): Promise<string> {
    if (this.dataSourceIdCache !== undefined) return this.dataSourceIdCache;
    const raw = await this.runNtn(op, [
      'api',
      `v1/databases/${this.databaseId}`,
    ]);
    if (raw === null || typeof raw !== 'object') {
      throw new TrackerError(
        'VALIDATION',
        `${op}: GET v1/databases/${this.databaseId} returned unexpected shape`,
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

  // ─── runNtn — central seam invoker ─────────────────────────────────────────
  //
  // Runs `ntn <apiArgs> --notion-version <pinned>`. Request bodies go via
  // STDIN (single body source; avoids arg-length limits and quoting bugs).
  // Nonzero exits and pass-through Notion error bodies are normalized into
  // thrown TrackerErrors. Returns the parsed JSON body of stdout, or null
  // when the call produced no output.

  private async runNtn(
    op: string,
    apiArgs: readonly string[],
    input?: string,
  ): Promise<unknown> {
    const args = [...apiArgs, '--notion-version', NOTION_API_VERSION];
    let result: NtnExecResult;
    try {
      result = await this.ntn(
        args,
        input === undefined ? undefined : { input },
      );
    } catch (err) {
      throw this.normalizeError(op, err, classifyNotionExecError(err));
    }

    if (result.exitCode !== 0) {
      const hint = classifyNotionExecError(result);
      const body =
        parseNotionErrorBody(result.stdout) ??
        parseNotionErrorBody(result.stderr);
      const detail =
        body?.message ??
        (result.stderr.trim().length > 0
          ? result.stderr.trim()
          : `ntn exited ${result.exitCode}`);
      throw this.normalizeError(op, new Error(detail), hint);
    }

    const text = result.stdout.trim();
    if (text.length === 0) return null;
    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      throw this.normalizeError(op, new Error('ntn-output-not-json'), {
        code: 'VALIDATION',
        details: { reason: 'ntn-output-not-json', preview: text.slice(0, 500) },
      });
    }
    // Defensive: some error responses can come back with exit 0 (the CLI
    // passes the API response through). Detect by shape (`object: 'error'`)
    // and route through the same error path as nonzero exits.
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { object?: string }).object === 'error'
    ) {
      const hint = classifyNotionExecError({
        exitCode: 1,
        stdout: text,
        stderr: result.stderr,
      });
      const body = parseNotionErrorBody(text);
      throw this.normalizeError(
        op,
        new Error(body?.message ?? 'notion-error-body'),
        hint,
      );
    }
    return parsed;
  }

  // ─── getCurrentRevision — cheap upstream-equality probe (FORGE-123) ─────────
  //
  // Opaque token = `notion:<db last_edited_time>|<newest page last_edited_time>`.
  // The database object's timestamp does NOT reliably advance when individual
  // pages inside it are edited (Codex impl-review r3), so the token combines
  // two cheap signals: the database object (schema/property changes) and a
  // top-1 data-source query sorted by last_edited_time descending (page
  // edits/additions). Either component moving breaks equality → full pull.
  // Residual accepted edge: archiving a page may advance neither timestamp;
  // a periodic unconditioned --pull still reconciles those. `none` per
  // component when absent. The provider-tag prefix keeps cross-provider
  // equality from ever being accidentally true.
  async getCurrentRevision(): Promise<string> {
    return this.withRetry(
      'getCurrentRevision',
      async () => {
        const op = 'getCurrentRevision';
        const raw = await this.runNtn(op, ['api', `v1/databases/${this.databaseId}`]);
        if (raw === null || typeof raw !== 'object') {
          throw new TrackerError(
            'VALIDATION',
            `getCurrentRevision: GET v1/databases/${this.databaseId} returned unexpected shape`,
            { databaseId: this.databaseId },
          );
        }
        const lastEdited = (raw as { last_edited_time?: unknown }).last_edited_time;
        const dbIso =
          typeof lastEdited === 'string' && lastEdited.length > 0
            ? lastEdited
            : 'none';

        const dataSourceId = await this.resolveDataSourceId(op);
        const queryRaw = await this.runNtn(
          op,
          ['api', `v1/data_sources/${dataSourceId}/query`, '-X', 'POST'],
          JSON.stringify({
            page_size: 1,
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
          }),
        );
        // Validate the query shape like the database fetch above: a malformed
        // response must THROW (routing --check to its probe-failure → full-pull
        // fallback), not silently degrade to 'none' — a stored `notion:<db>|none`
        // token would then false-match and miss upstream changes (Codex r4).
        if (queryRaw === null || typeof queryRaw !== 'object') {
          throw new TrackerError(
            'VALIDATION',
            `getCurrentRevision: data-source query returned unexpected shape`,
            { databaseId: this.databaseId, dataSourceId },
          );
        }
        const results = (queryRaw as { results?: unknown }).results;
        if (!Array.isArray(results)) {
          throw new TrackerError(
            'VALIDATION',
            `getCurrentRevision: data-source query response has no results array`,
            { databaseId: this.databaseId, dataSourceId },
          );
        }
        let pageIso = 'none';
        if (results.length > 0) {
          const first = results[0] as { last_edited_time?: unknown };
          if (typeof first.last_edited_time === 'string' && first.last_edited_time.length > 0) {
            pageIso = first.last_edited_time;
          }
        }
        return `notion:${dbIso}|${pageIso}`;
      },
      this.retryOpts,
    );
  }

  // ─── healthCheck — never throws ────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.runNtn('healthCheck', ['api', 'v1/users/me']);
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
  // Queries the data source. Filters out archived + done/cancelled states so
  // the orchestrator's eligibility pass doesn't have to.

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
          const body: Record<string, unknown> = { page_size: pageSize };
          if (cursor !== undefined) body.start_cursor = cursor;

          const raw = await this.runNtn(
            op,
            ['api', `v1/data_sources/${dataSourceId}/query`, '-X', 'POST'],
            JSON.stringify(body),
          );

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
      await this.patchPageProperties('claim.write', pageId, {
        [PROP_CLAIMED_BY]: richTextProp(runId),
      });
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
      await this.patchPageProperties('releaseClaim', pageId, {
        [PROP_CLAIMED_BY]: richTextProp(''),
      });
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
      await this.patchPageProperties('updateState', pageId, {
        [PROP_STATE]: statusProp(notionState),
      });
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('updateState', err, classifyNotionExecError(err));
    }
  }

  // ─── comment ───────────────────────────────────────────────────────────────

  async comment(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(body, 'body');
    const pageId = parseNotionPageId(issueId);
    try {
      await this.runNtn(
        'comment',
        ['api', 'v1/comments', '-X', 'POST'],
        JSON.stringify({
          parent: { page_id: pageId },
          rich_text: richTextPayload(body),
        }),
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('comment', err, classifyNotionExecError(err));
    }
  }

  // ─── createProject → Notion data source ────────────────────────────────────
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

    // API 2026-03-11: creating a NEW database under a page is
    // `POST /v1/databases` (with `initial_data_source` carrying the column
    // schema). `POST /v1/data_sources` only ADDS a data source to an EXISTING
    // database and requires `parent.database_id` — the previous payload here
    // was invalid under the pinned version (Codex impl-review). Construct
    // properties matching the forge schema (status options + rich_text cols).
    const body: Record<string, unknown> = {
      parent: { type: 'page_id', page_id: parseNotionPageId(parentPageId) },
      title: richTextPayload(name),
      initial_data_source: { properties: defaultDatabaseProperties() },
    };
    if (description !== undefined && description.length > 0) {
      body.description = richTextPayload(description);
    }

    let raw: unknown;
    try {
      raw = await this.runNtn(
        'createProject',
        ['api', 'v1/databases', '-X', 'POST'],
        JSON.stringify(body),
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError(
        'createProject',
        err,
        classifyNotionExecError(err),
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

    const children = buildIssueChildren(payload);

    const body: Record<string, unknown> = {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties,
      ...(children.length > 0 ? { children } : {}),
    };

    let raw: unknown;
    try {
      raw = await this.runNtn(
        'createIssue',
        ['api', 'v1/pages', '-X', 'POST'],
        JSON.stringify(body),
      );
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('createIssue', err, classifyNotionExecError(err));
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
      throw this.normalizeError('setBlockedBy', err, classifyNotionExecError(err));
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
      await this.patchPageProperties('setBlockedBy', pageId, {
        [PROP_BLOCKED_BY]: richTextProp(next),
      });
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('setBlockedBy', err, classifyNotionExecError(err));
    }
  }

  // ─── updateIssueBody — content-block replace (FORGE-117) ───────────────────
  //
  // Replaces the page's content blocks wholesale. On Notion the body is
  // CONTENT BLOCKS, not a single field, and forge metadata (forgeTaskId,
  // blockerIds, ownerType) lives in PAGE PROPERTIES — so unlike the
  // GitHub/Linear footer pump, the replace never touches forge metadata.
  //
  // Sequence (Notion has NO atomic body replace — PATCH children APPENDS):
  //   1. assertValidBodyInput (non-string / forge-footer / >64KiB rejection)
  //   2. fetch page; PRECONDITION_FAILED unless forge_task_id is non-empty
  //      (page created outside forge)
  //   3. GET  v1/blocks/{page_id}/children   (cursor loop — collect child ids)
  //   4. DELETE v1/blocks/{child_id}         (per child)
  //   5. PATCH v1/blocks/{page_id}/children  (append replacement paragraphs)
  //
  // ⚠️ NON-ATOMIC: a crash between steps 4 and 5 leaves a partially-deleted
  // body on the page. This matches the interface contract (updateIssueBody
  // has NO CAS; the caller holds the claim; single-writer), and the operation
  // is IDEMPOTENTLY RE-RUNNABLE: a re-run lists whatever children remain,
  // deletes them, and appends the full replacement. Errors classify retriable
  // (TRANSPORT/RATE_LIMITED/TIMEOUT) vs not via classifyNotionExecError so
  // callers know when a re-run is worthwhile.
  async updateIssueBody(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    assertValidBodyInput(body, NOTION_BODY_MAX_BYTES);
    const pageId = parseNotionPageId(issueId);

    // Precondition: forge-created page (forge_task_id property present).
    let page: NotionPage;
    try {
      page = await this.fetchPage(pageId);
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError(
        'updateIssueBody',
        err,
        classifyNotionExecError(err),
      );
    }
    const forgeTaskId = readRichText(page, PROP_TASK_ID);
    if (forgeTaskId.length === 0) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `updateIssueBody: page ${pageId} has no ${PROP_TASK_ID} property; was it created outside of forge?`,
        { issueId, pageId },
      );
    }

    // 1. Collect existing child block ids (cursor loop; pagination via query
    //    args, not stdin — GET requests carry no body).
    const childIds: string[] = [];
    let cursor: string | undefined;
    do {
      const args = ['api', `v1/blocks/${pageId}/children`, 'page_size==100'];
      if (cursor !== undefined) args.push(`start_cursor==${cursor}`);
      const raw = await this.runNtn('updateIssueBody.listChildren', args);
      let parsed;
      try {
        parsed = NotionBlockChildrenResponseSchema.parse(raw);
      } catch (err) {
        throw this.normalizeError('updateIssueBody.listChildren', err, {
          code: 'VALIDATION',
          details: { reason: 'block-children-parse-failed', pageId },
        });
      }
      for (const child of parsed.results) childIds.push(child.id);
      cursor =
        parsed.has_more === true && parsed.next_cursor
          ? parsed.next_cursor
          : undefined;
    } while (cursor !== undefined);

    // 2. Delete each existing child.
    for (const childId of childIds) {
      await this.runNtn('updateIssueBody.deleteChild', [
        'api',
        `v1/blocks/${childId}`,
        '-X',
        'DELETE',
      ]);
    }

    // 3. Append replacement paragraph blocks.
    const children = bodyToParagraphBlocks(body);
    if (children.length > 0) {
      await this.runNtn(
        'updateIssueBody.append',
        ['api', `v1/blocks/${pageId}/children`, '-X', 'PATCH'],
        JSON.stringify({ children }),
      );
    }
  }

  // ─── setClaimFence — NOT_IMPLEMENTED stub (FORGE-167) ──────────────────────
  //
  // Scope-dropped from FORGE-117 (Codex pre-opinion delta): on Notion the
  // claim fence cannot ride the body — forge metadata lives in page
  // properties — and reusing the existing forge_claimed_by property would
  // lose claimId/generation and violate the ClaimFenceData contract. A
  // ClaimFenceData-shaped property scheme is the FORGE-145/FORGE-167
  // follow-up. Claim/cancel call this best-effort, so a Notion-backed
  // project simply skips fence mirroring (warn, no failure).
  async setClaimFence(
    _issueId: string,
    _data: ClaimFenceData | null,
  ): Promise<void> {
    throw new TrackerError(
      'NOT_IMPLEMENTED',
      `NotionTracker.setClaimFence is not implemented in this release. ` +
        `Notion stores claim identity in page properties, not body footers; a ` +
        `ClaimFenceData-shaped property scheme is tracked as the FORGE-145/FORGE-167 follow-up. ` +
        `Until then, claim/cancel skip forge:claim fence mirroring for Notion.`,
      { followUpIssue: 'FORGE-167' },
    );
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  // Property write: PATCH v1/pages/{id} with a properties body via stdin.
  // Single code path for claim/releaseClaim/updateState/setBlockedBy.
  private async patchPageProperties(
    op: string,
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await this.runNtn(
      op,
      ['api', `v1/pages/${pageId}`, '-X', 'PATCH'],
      JSON.stringify({ properties }),
    );
  }

  private async fetchPage(pageId: string): Promise<NotionPage> {
    let raw: unknown;
    try {
      raw = await this.runNtn('fetchPage', ['api', `v1/pages/${pageId}`]);
    } catch (err) {
      throw err instanceof TrackerError
        ? err
        : this.normalizeError('fetchPage', err, classifyNotionExecError(err));
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
      await this.patchPageProperties('claim.cleanup', pageId, {
        [PROP_CLAIMED_BY]: richTextProp(''),
      });
    } catch (err) {
      this.logger.warn('tracker.tryClearClaimIfOwned', {
        pageId,
        err: errToString(err),
      });
    }
  }
}

// ─── utils ───────────────────────────────────────────────────────────────────

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

function buildIssueChildren(
  payload: CreateIssuePayload,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    ...bodyToParagraphBlocks(payload.body),
  ];
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
