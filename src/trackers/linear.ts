import { Issue as LinearSdkIssue, IssueRelationType, LinearClient } from '@linear/sdk';

import type { LinearTrackerConfig } from '../schemas/settings.ts';
import {
  BaseTracker,
  type Logger,
  type NormalizeErrorHint,
  type WithRetryOpts,
} from './base.ts';
import { TrackerError } from './errors.ts';
import {
  parseForgeFooters,
  serializeWithForgeFooters,
} from './footers.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueState,
} from './types.ts';

// ─── Public seam types ───────────────────────────────────────────────────────
//
// LinearSdkLike narrows @linear/sdk's ~200-method surface to the ~10 calls we
// actually use. Real runtime path wraps a `LinearClient`. Tests inject a
// MockLinearSdk for deterministic sequencing.

export type LinearStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

export interface LinearIssueLike {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { id: string; name: string; type: LinearStateType };
  labels: ReadonlyArray<{ id: string; name: string }>;
}

export interface LinearWorkflowStateLike {
  id: string;
  name: string;
  type: LinearStateType;
}

export interface LinearLabelLike {
  id: string;
  name: string;
}

export interface LinearCreateIssueInput {
  teamId: string;
  title: string;
  description: string;
}

export interface LinearUpdateIssueInput {
  description?: string;
  stateId?: string;
  addedLabelIds?: readonly string[];
  removedLabelIds?: readonly string[];
}

export interface LinearCreateProjectInput {
  teamId: string;
  name: string;
  description?: string;
}

export interface LinearSdkLike {
  // Returns the viewer ID only. Email is intentionally NOT included to keep
  // PII out of the adapter's data surface (security-auditor, FORGE-16).
  viewer(): Promise<{ id: string }>;
  issue(id: string): Promise<LinearIssueLike>;
  listIssues(opts: {
    teamId: string;
    stateTypes: readonly LinearStateType[];
    limit: number;
  }): Promise<LinearIssueLike[]>;
  createIssue(input: LinearCreateIssueInput): Promise<LinearIssueLike>;
  updateIssue(id: string, input: LinearUpdateIssueInput): Promise<LinearIssueLike>;
  createComment(input: { issueId: string; body: string }): Promise<void>;
  listWorkflowStates(teamId: string): Promise<LinearWorkflowStateLike[]>;
  listIssueLabels(teamId: string): Promise<LinearLabelLike[]>;
  createIssueLabel(input: { teamId: string; name: string }): Promise<LinearLabelLike>;
  createProject(input: LinearCreateProjectInput): Promise<{ id: string; url: string }>;
  createIssueRelation(input: {
    issueId: string;
    relatedIssueId: string;
    type: 'blocks';
  }): Promise<void>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAIM_LABEL_PREFIX = 'forge:claimed-by:';
const STATE_OVERLAY_IN_REVIEW = 'state:in-review';
const STATE_OVERLAY_BLOCKED = 'state:blocked';

export const LINEAR_LIST_LIMIT = 200;
export const LINEAR_WORKFLOW_STATES_LIMIT = 250;

// ─── Error classification (per-adapter; BaseTracker stays generic) ───────────
//
// Invariant carried from FORGE-14 EUREKA: adapters classify their own provider
// errors; BaseTracker.normalizeError only composes. Do NOT move this logic
// into the base class — that path was deliberately rejected because the
// invariant is what keeps a future NotionTracker (FORGE-17) clean.

interface ErrorLike {
  message?: string;
  status?: number;
  code?: string;
  type?: string;
  errors?: ReadonlyArray<{ message?: string; extensions?: { code?: string } }>;
}

function isErrorLike(err: unknown): err is ErrorLike {
  return typeof err === 'object' && err !== null;
}

// Branch order is load-bearing — same care as classifyGitHubError:
//   AUTH before NOT_FOUND (some 403s look like 404s)
//   VALIDATION before CONFLICT ("already exists" can appear in 422 body)
export function classifyLinearError(err: unknown): NormalizeErrorHint {
  if (!isErrorLike(err)) return { code: 'UNKNOWN' };
  const message = String(err.message ?? '');
  const status = typeof err.status === 'number' ? err.status : -1;
  const linearType = String(err.type ?? '');
  const graphqlCodes = (err.errors ?? [])
    .map((e) => String(e.extensions?.code ?? ''))
    .filter(Boolean);

  if (
    status === 401 ||
    /AuthenticationError|authentication required|invalid api key|unauthorized/i.test(
      message,
    ) ||
    linearType === 'AuthenticationError'
  ) {
    // Deliberately omit `message` here: provider AUTH error bodies can
    // (rarely) echo fragments of the rejected Authorization header. The
    // logger's redactor scans object KEYS for *_KEY/*_TOKEN/*_SECRET, not
    // string values, so a leaked fragment would bypass redaction. Callers
    // synthesize their own detail string for AUTH (security-auditor,
    // FORGE-16).
    return { code: 'AUTH', details: { status } };
  }

  if (
    status === 429 ||
    /rate limit|too many requests/i.test(message) ||
    graphqlCodes.includes('RATELIMITED') ||
    linearType === 'Ratelimited'
  ) {
    const retryAfterMs = parseRetryAfter(message);
    return {
      code: 'RATE_LIMITED',
      details: {
        status,
        message,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }

  if (
    status === 404 ||
    /not found|entity not found|could not find/i.test(message) ||
    graphqlCodes.includes('NOT_FOUND')
  ) {
    return { code: 'NOT_FOUND', details: { status, message } };
  }

  if (
    status === 422 ||
    /validation|GraphQL.*Argument|invalid input/i.test(message) ||
    graphqlCodes.includes('INVALID_INPUT') ||
    graphqlCodes.includes('GRAPHQL_VALIDATION_FAILED') ||
    linearType === 'InvalidInput'
  ) {
    return { code: 'VALIDATION', details: { status, message } };
  }

  // After VALIDATION so "already exists" inside a 422 routes to VALIDATION.
  if (
    status === 409 ||
    /conflict|already exists|duplicate/i.test(message) ||
    graphqlCodes.includes('CONFLICT')
  ) {
    return { code: 'CONFLICT', details: { status, message } };
  }

  if (
    err.code === 'ETIMEDOUT' ||
    /timeout|ETIMEDOUT|request timed out/i.test(message)
  ) {
    return { code: 'TIMEOUT', details: { status, message } };
  }

  if (
    (status >= 500 && status < 600) ||
    /ECONNRESET|EAI_AGAIN|network error|connection (?:refused|reset)/i.test(
      message,
    )
  ) {
    return { code: 'TRANSPORT', details: { status, message } };
  }

  return { code: 'UNKNOWN', details: { status, message } };
}

function parseRetryAfter(message: string): number | undefined {
  const match = message.match(/retry[- ]?after:?\s*(\d+)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function isTransientCode(
  code: NormalizeErrorHint['code'],
): code is 'TRANSPORT' | 'TIMEOUT' | 'RATE_LIMITED' {
  return code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'RATE_LIMITED';
}

// Locale-aware lexicographic tiebreak — case-insensitive, locale-stable.
// Default Array.sort uses UTF-16 code units which puts 'Z' < 'a'; we don't
// want case to swing claim outcomes.
function tiebreakWinner(claims: readonly string[]): string {
  return [...claims].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  )[0]!;
}

// ─── Real SDK wrapper ────────────────────────────────────────────────────────
//
// Bridges the lazy/async @linear/sdk model (where issue.state is itself a
// Promise) to our flat LinearSdkLike shape. Pulled into its own helper so
// LinearTracker stays SDK-agnostic and trivially mockable.

export function wrapLinearClient(client: LinearClient): LinearSdkLike {
  return {
    async viewer() {
      const v = await client.viewer;
      return { id: v.id };
    },

    async issue(id) {
      const issue = await client.issue(id);
      return flattenIssue(issue);
    },

    async listIssues({ teamId, stateTypes, limit }) {
      const conn = await client.issues({
        first: Math.min(limit, 250),
        filter: {
          team: { id: { eq: teamId } },
          state: { type: { in: stateTypes as string[] } },
        },
      });
      return Promise.all(conn.nodes.slice(0, limit).map(flattenIssue));
    },

    async createIssue(input) {
      const result = await client.createIssue({
        teamId: input.teamId,
        title: input.title,
        description: input.description,
      });
      const issue = await result.issue;
      if (!result.success || !issue) {
        throw new TrackerError('UNKNOWN', 'createIssue returned no issue', {
          input,
        });
      }
      return flattenIssue(issue);
    },

    async updateIssue(id, input) {
      const result = await client.updateIssue(id, {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
        ...(input.addedLabelIds !== undefined
          ? { addedLabelIds: [...input.addedLabelIds] }
          : {}),
        ...(input.removedLabelIds !== undefined
          ? { removedLabelIds: [...input.removedLabelIds] }
          : {}),
      });
      const issue = await result.issue;
      if (!result.success || !issue) {
        throw new TrackerError('UNKNOWN', 'updateIssue returned no issue', {
          id,
        });
      }
      return flattenIssue(issue);
    },

    async createComment({ issueId, body }) {
      const result = await client.createComment({ issueId, body });
      if (!result.success) {
        throw new TrackerError('UNKNOWN', 'createComment returned !success', {
          issueId,
        });
      }
    },

    async listWorkflowStates(teamId) {
      // Linear API max page size is 250. Teams with >250 workflow states
      // are vanishingly rare; getWorkflowStates() warn-logs if hit so the
      // operator sees the truncation rather than a silent PRECONDITION_FAILED.
      const conn = await client.workflowStates({
        filter: { team: { id: { eq: teamId } } },
        first: 250,
      });
      return conn.nodes.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type as LinearStateType,
      }));
    },

    async listIssueLabels(teamId) {
      const conn = await client.issueLabels({
        filter: { team: { id: { eq: teamId } } },
        first: 250,
      });
      return conn.nodes.map((l) => ({ id: l.id, name: l.name }));
    },

    async createIssueLabel({ teamId, name }) {
      const result = await client.createIssueLabel({ teamId, name });
      const label = await result.issueLabel;
      if (!result.success || !label) {
        throw new TrackerError('UNKNOWN', 'createIssueLabel returned no label', {
          teamId,
          name,
        });
      }
      return { id: label.id, name: label.name };
    },

    async createProject(input) {
      const result = await client.createProject({
        teamIds: [input.teamId],
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      const project = await result.project;
      if (!result.success || !project) {
        throw new TrackerError('UNKNOWN', 'createProject returned no project', {
          input,
        });
      }
      return { id: project.id, url: project.url };
    },

    async createIssueRelation({ issueId, relatedIssueId }) {
      // Seam already constrains `type` to literal 'blocks'; we don't need
      // to bind it here. If a second relation type is ever added, the seam
      // gets widened and this destructure picks it up then.
      const result = await client.createIssueRelation({
        issueId,
        relatedIssueId,
        type: IssueRelationType.Blocks,
      });
      if (!result.success) {
        throw new TrackerError(
          'UNKNOWN',
          'createIssueRelation returned !success',
          { issueId, relatedIssueId },
        );
      }
    },
  };
}

// SDK's `Issue` exposes `state` and `labels` as lazy fields/methods. Flatten
// them eagerly so downstream code reads a simple object.
async function flattenIssue(issue: LinearSdkIssue): Promise<LinearIssueLike> {
  const state = await issue.state;
  const labelsConn = await issue.labels();
  if (!state) {
    throw new TrackerError('VALIDATION', 'issue has no workflow state', {
      issueId: issue.id,
    });
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    state: {
      id: state.id,
      name: state.name,
      type: state.type as LinearStateType,
    },
    labels: labelsConn.nodes.map((l) => ({ id: l.id, name: l.name })),
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface LinearTrackerOptions {
  /**
   * Inject a LinearSdkLike — real runtime uses wrapLinearClient(new
   * LinearClient(...)); tests inject MockLinearSdk. If omitted, constructor
   * reads process.env.LINEAR_API_KEY and instantiates a LinearClient lazily
   * on first use (so DI / health-check / missing-key paths stay clean).
   */
  client?: LinearSdkLike;
  /** Override default retry options (mostly for tests). */
  retry?: WithRetryOpts;
}

export class LinearTracker extends BaseTracker<LinearTrackerConfig> {
  readonly type = 'linear' as const;

  // Pre-instantiated injected client, OR a lazy factory that reads
  // LINEAR_API_KEY on first call. Never throws in the constructor — defer to
  // method invocation so healthCheck() can return ok:false cleanly.
  private clientPromise: Promise<LinearSdkLike> | null = null;
  private readonly injectedClient: LinearSdkLike | undefined;
  private readonly teamId: string;
  private readonly retryOpts: WithRetryOpts;

  // Caches keyed by team id; team config is fixed for the adapter lifetime.
  private workflowStatesCache: LinearWorkflowStateLike[] | null = null;
  private labelCacheByName: Map<string, LinearLabelLike> = new Map();
  private warnedAboutBlockedFallback = false;

  constructor(
    config: LinearTrackerConfig,
    logger: Logger,
    options: LinearTrackerOptions = {},
  ) {
    super(config, logger);
    this.teamId = config.config.team_id;
    this.retryOpts = options.retry ?? {};
    this.injectedClient = options.client;
  }

  private async getClient(): Promise<LinearSdkLike> {
    if (this.injectedClient) return this.injectedClient;
    if (this.clientPromise) return this.clientPromise;
    const promise = (async () => {
      const apiKey = process.env.LINEAR_API_KEY;
      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new TrackerError(
          'AUTH',
          'LINEAR_API_KEY not set (export a Linear Personal API Key — see docs/adapters/linear.md)',
        );
      }
      return wrapLinearClient(new LinearClient({ apiKey }));
    })();
    this.clientPromise = promise;
    // Clear the cached rejection so a later call retries (e.g., user exports
    // LINEAR_API_KEY after a healthCheck-driven init failure). The .catch
    // does NOT swallow the rejection — the original promise return path
    // still surfaces it to the current caller (code-reviewer, FORGE-16).
    promise.catch(() => {
      this.clientPromise = null;
    });
    return promise;
  }

  // ─── healthCheck — never throws ────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    let client: LinearSdkLike;
    try {
      client = await this.getClient();
    } catch (err) {
      if (err instanceof TrackerError && err.code === 'AUTH') {
        return { ok: false, detail: err.message };
      }
      const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
      return { ok: false, detail: message };
    }

    try {
      const viewer = await client.viewer();
      if (!viewer.id) {
        return { ok: false, detail: 'viewer returned without id' };
      }
      return { ok: true };
    } catch (err) {
      const hint = classifyLinearError(err);
      // For AUTH, use a synthesized detail — the raw provider message could
      // contain a token fragment which would bypass the logger's key-based
      // redactor (security-auditor, FORGE-16).
      if (hint.code === 'AUTH') {
        return {
          ok: false,
          detail:
            'LINEAR_API_KEY rejected by Linear API — re-mint at linear.app/settings/account/security',
        };
      }
      const detailFromHint =
        typeof hint.details?.message === 'string' ? hint.details.message : '';
      const detail =
        detailFromHint.length > 0
          ? detailFromHint
          : err instanceof Error
            ? err.message
            : 'linear health check failed';
      return { ok: false, detail };
    }
  }

  // ─── Stubs (implemented in subsequent commits) ─────────────────────────────

  async listActiveIssues(): Promise<Issue[]> {
    const client = await this.getClient();
    return this.withRetry(
      'listActiveIssues',
      async () => {
        let issues: LinearIssueLike[];
        try {
          issues = await client.listIssues({
            teamId: this.teamId,
            stateTypes: ['triage', 'backlog', 'unstarted', 'started'],
            limit: LINEAR_LIST_LIMIT,
          });
        } catch (err) {
          throw this.normalizeError(
            'listActiveIssues',
            err,
            classifyLinearError(err),
          );
        }
        if (issues.length === LINEAR_LIST_LIMIT) {
          this.logger.warn('tracker.listActiveIssues', {
            reason: 'limit-hit',
            limit: LINEAR_LIST_LIMIT,
            teamId: this.teamId,
          });
        }
        return issues.map((i) => toIssue(i));
      },
      this.retryOpts,
    );
  }

  // Three-step claim with tiebreak — mirrors GitHubTracker.claim exactly.
  //
  // Linear's public GraphQL API does NOT expose `revision`/`expectedRevision`
  // or `customFields` on IssueUpdateInput (verified against
  // packages/sdk/src/schema.graphql at master 2026-05). Strict optimistic
  // concurrency is not achievable. We use label-add + lexicographic tiebreak
  // on race losers; the tiebreak gives orchestrator-perspective atomicity
  // (exactly one agent ends up with the claim under contention) even though
  // the underlying writes are not strict CAS. See docs/adapters/linear.md
  // "Claim semantics" for the full rationale.
  async claim(issueId: string, runId: string): Promise<ClaimResult> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    this.assertValidRunId(runId);
    const client = await this.getClient();
    const myLabelName = this.makeClaimLabel(runId);

    // Step 1: read current labels.
    let initial: LinearIssueLike;
    try {
      initial = await this.withRetry(
        'claim.read',
        () => client.issue(issueId),
        this.retryOpts,
      );
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'NOT_FOUND') {
        return {
          ok: false,
          reason: 'version_conflict',
          detail: 'issue-not-found-on-initial-read',
        };
      }
      if (isTransientCode(hint.code)) {
        return {
          ok: false,
          reason: 'transient_error',
          detail: stringifyDetailMessage(hint),
        };
      }
      throw this.normalizeError('claim', err, hint);
    }

    const existingClaims = initial.labels.filter((l) => this.isClaimLabel(l.name));
    if (existingClaims.length > 0) {
      if (existingClaims.length === 1 && existingClaims[0]!.name === myLabelName) {
        return { ok: true };
      }
      if (existingClaims.some((l) => l.name === myLabelName)) {
        const winner = this.resolveClaimTiebreak(existingClaims.map((l) => l.name));
        if (winner === myLabelName) return { ok: true };
        await this.tryRemoveLabelByName(issueId, myLabelName);
        return {
          ok: false,
          reason: 'version_conflict',
          detail: `lost-tiebreak-to:${winner}`,
        };
      }
      return {
        ok: false,
        reason: 'already_claimed',
        detail: existingClaims.map((l) => l.name).join(','),
      };
    }

    // Step 2: ensure label exists, then add it.
    let myLabel: LinearLabelLike;
    try {
      myLabel = await this.ensureLabel(myLabelName);
    } catch (err) {
      const hint = classifyLinearError(err);
      if (isTransientCode(hint.code)) {
        return {
          ok: false,
          reason: 'transient_error',
          detail: stringifyDetailMessage(hint),
        };
      }
      throw this.normalizeError('claim', err, hint);
    }

    try {
      await client.updateIssue(issueId, { addedLabelIds: [myLabel.id] });
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'NOT_FOUND') {
        return {
          ok: false,
          reason: 'version_conflict',
          detail: 'issue-not-found-or-closed',
        };
      }
      if (isTransientCode(hint.code)) {
        return {
          ok: false,
          reason: 'transient_error',
          detail: stringifyDetailMessage(hint),
        };
      }
      throw this.normalizeError('claim', err, hint);
    }

    // Step 3: re-read for race detection.
    let post: LinearIssueLike;
    try {
      post = await this.withRetry(
        'claim.recheck',
        () => client.issue(issueId),
        this.retryOpts,
      );
    } catch (err) {
      // Can't verify — be conservative, release our label.
      await this.tryRemoveLabelByName(issueId, myLabelName);
      const hint = classifyLinearError(err);
      if (hint.code === 'NOT_FOUND') {
        return {
          ok: false,
          reason: 'version_conflict',
          detail: 'issue-not-found-on-recheck',
        };
      }
      if (isTransientCode(hint.code)) {
        return {
          ok: false,
          reason: 'transient_error',
          detail: stringifyDetailMessage(hint),
        };
      }
      throw this.normalizeError('claim', err, hint);
    }

    const allClaims = post.labels.filter((l) => this.isClaimLabel(l.name));

    // Verify-on-readback contract (spec/ORCHESTRATOR.md §Tracker atomic claim):
    // (a) our label MUST be present AND (b) no other forge:claimed-by:* label
    // MUST be present. If our label is missing on reread, the add silently
    // failed or was stripped (e.g., concurrent admin action, sibling
    // orchestrator removed it). Either way: we don't hold the claim.
    // Best-effort remove (in case it does exist on the server but our reread
    // was stale) and return version_conflict. Mirrors FORGE-77 bug fix on
    // GitHubTracker (src/trackers/github.ts:431-440).
    if (!allClaims.some((l) => l.name === myLabelName)) {
      await this.tryRemoveLabelByName(issueId, myLabelName);
      return {
        ok: false,
        reason: 'version_conflict',
        detail: 'claim-label-missing-on-recheck',
      };
    }

    if (allClaims.length === 1) return { ok: true };

    const winner = this.resolveClaimTiebreak(allClaims.map((l) => l.name));
    if (winner === myLabelName) return { ok: true };

    await this.tryRemoveLabelByName(issueId, myLabelName);
    return {
      ok: false,
      reason: 'version_conflict',
      detail: `lost-tiebreak-to:${winner}`,
    };
  }

  // Strict-scope release: removes only `forge:claimed-by:<runId>` — the
  // caller's exact label. Does not police other agents' labels. Trusted-
  // caller contract: callers invoke release only on issues they own.
  // Mirrors GitHubTracker.releaseClaim (src/trackers/github.ts:451-490).
  //
  // Idempotent: a missing label (already-removed, never-set, or issue
  // deleted) is swallowed silently. Per spec/ORCHESTRATOR.md §Tracker
  // atomic claim — release is best-effort cleanup; tracker-side stale-claim
  // reconciliation is FORGE-22's job (gc local-vs-tracker alignment).
  //
  // Linear-specific complication: removal requires a label ID (Linear's
  // GraphQL surface), not just a name. We pay a cached team-label lookup
  // to translate. The lookup is wrapped in withRetry so a transient
  // network failure doesn't silently leak the claim (Codex 2nd-pass).
  //
  // Stale-cached-id guard: if a label was deleted+recreated out-of-band
  // (e.g., Linear UI admin action), our cache may hold an obsolete id.
  // The server then rejects the remove as VALIDATION. We evict and refresh
  // once; if the fresh id differs, retry; if no label exists on the team,
  // idempotent return (Codex 2nd-pass).
  async releaseClaim(issueId: string, runId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    this.assertValidRunId(runId);
    const client = await this.getClient();
    const myLabelName = this.makeClaimLabel(runId);

    // First attempt: lookup the caller's label id (cache-first; refreshes
    // via listIssueLabels once on miss). Uses the strict variant + withRetry
    // so transient listIssueLabels failures retry per retry policy and, if
    // still failing, surface as a thrown TrackerError — they MUST NOT silently
    // no-op as "label not on team" (Codex 3rd-pass: the soft variant would
    // reintroduce the leak the withRetry wrapper claimed to fix).
    let label: LinearLabelLike | null;
    try {
      label = await this.withRetry(
        'releaseClaim.lookup',
        () => this.lookupExistingLabelStrict(myLabelName),
        this.retryOpts,
      );
    } catch (err) {
      throw this.normalizeError('releaseClaim', err, classifyLinearError(err));
    }
    if (!label) return; // never created on the team — idempotent

    try {
      await client.updateIssue(issueId, { removedLabelIds: [label.id] });
      return;
    } catch (err) {
      const hint = classifyLinearError(err);

      // Issue gone (deleted or no permission). Idempotent.
      if (hint.code === 'NOT_FOUND') return;

      // VALIDATION likely means the cached label id is stale (label
      // deleted+recreated out-of-band — server rejects unknown id).
      // Evict, refresh (strict + retry), retry once with the fresh id.
      // Codex 3rd-pass: strict variant ensures a transient refresh failure
      // does NOT silently exit treating the claim as "truly gone".
      if (hint.code === 'VALIDATION') {
        this.labelCacheByName.delete(myLabelName);
        let fresh: LinearLabelLike | null;
        try {
          fresh = await this.withRetry(
            'releaseClaim.refresh',
            () => this.lookupExistingLabelStrict(myLabelName),
            this.retryOpts,
          );
        } catch (refreshErr) {
          throw this.normalizeError(
            'releaseClaim',
            refreshErr,
            classifyLinearError(refreshErr),
          );
        }
        if (!fresh || fresh.id === label.id) return; // truly gone — idempotent
        try {
          await client.updateIssue(issueId, { removedLabelIds: [fresh.id] });
          return;
        } catch (retryErr) {
          const retryHint = classifyLinearError(retryErr);
          if (retryHint.code === 'NOT_FOUND') return;
          throw this.normalizeError('releaseClaim', retryErr, retryHint);
        }
      }

      throw this.normalizeError('releaseClaim', err, hint);
    }
  }

  // updateState maps forge IssueState → Linear (stateId + overlay labels).
  // Overlay labels carry `in_review` and `blocked` semantics since Linear has
  // no native workflow-state type for them. The `state:in-review` and
  // `state:blocked` labels are mutually exclusive with each other (and the
  // unset case): updateState always reconciles both overlays so leftover
  // labels from prior transitions don't poison `deriveStateFromLinearIssue`.
  async updateState(issueId: string, state: IssueState): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    const client = await this.getClient();

    let resolved: { stateId: string; overlayLabel: string | null };
    try {
      resolved = await this.resolveForgeStateToLinear(state);
    } catch (err) {
      if (err instanceof TrackerError) throw err;
      throw this.normalizeError('updateState', err, classifyLinearError(err));
    }

    const { addedLabelIds, removedLabelIds } = await this.reconcileOverlayLabels(
      resolved.overlayLabel,
    );

    try {
      await client.updateIssue(issueId, {
        stateId: resolved.stateId,
        ...(addedLabelIds.length > 0 ? { addedLabelIds } : {}),
        ...(removedLabelIds.length > 0 ? { removedLabelIds } : {}),
      });
    } catch (err) {
      throw this.normalizeError('updateState', err, classifyLinearError(err));
    }
  }

  async comment(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(body, 'body');
    const client = await this.getClient();
    try {
      await client.createComment({ issueId, body });
    } catch (err) {
      throw this.normalizeError('comment', err, classifyLinearError(err));
    }
  }

  async createProject(
    name: string,
    description?: string,
  ): Promise<{ id: string; url: string }> {
    this.assertNonEmpty(name, 'name');
    const client = await this.getClient();
    let project: { id: string; url: string };
    try {
      project = await client.createProject({
        teamId: this.teamId,
        name,
        ...(description !== undefined && description.length > 0
          ? { description }
          : {}),
      });
    } catch (err) {
      throw this.normalizeError(
        'createProject',
        err,
        classifyLinearError(err),
      );
    }

    // Pre-create overlay labels so updateState calls never need a label-
    // create round-trip mid-orchestration. Best-effort: failures here are
    // logged but don't fail createProject (mirrors GitHubTracker.precreate).
    await this.precreateOverlayLabels().catch((err) => {
      this.logger.warn('tracker.createProject.overlayPrecreateFailed', {
        err: errMessage(err),
      });
    });

    return project;
  }

  private async precreateOverlayLabels(): Promise<void> {
    for (const name of [STATE_OVERLAY_IN_REVIEW, STATE_OVERLAY_BLOCKED]) {
      await this.ensureLabel(name);
    }
  }

  async createIssue(payload: CreateIssuePayload): Promise<Issue> {
    this.assertNonEmpty(payload.title, 'payload.title');
    this.assertNonEmpty(payload.forgeTaskId, 'payload.forgeTaskId');
    this.assertNonEmpty(payload.ownerType, 'payload.ownerType');
    const client = await this.getClient();

    const extraFooters = [`<!-- forge:ownerType=${payload.ownerType} -->`];
    const bodyWithFooter = serializeWithForgeFooters(
      payload.body,
      payload.forgeTaskId,
      [],
      extraFooters,
    );

    let created: LinearIssueLike;
    try {
      created = await client.createIssue({
        teamId: this.teamId,
        title: payload.title,
        description: bodyWithFooter,
      });
    } catch (err) {
      throw this.normalizeError('createIssue', err, classifyLinearError(err));
    }
    return toIssue(created);
  }

  // setBlockedBy writes both:
  //   1. forge:blockedBy footer in the issue description (orchestrator-read
  //      single-source-of-truth)
  //   2. native Linear IssueRelation(type=blocks) so the dependency shows up
  //      in Linear's UI as a real relation (decided §11 Q2)
  //
  // Footer write and relation create are INDEPENDENTLY idempotent:
  //   - Footer dedups internally via parseForgeFooters → blockerIds.includes
  //   - Native relation CONFLICT (already-exists) is swallowed
  //
  // Both ALWAYS run on every invocation so retries after partial failure
  // (e.g. footer wrote, native call timed out) complete the dual write.
  // Skipping native when the footer dedups would leave the Linear UI
  // permanently missing the dependency arrow (codex review, FORGE-16).
  //
  // IssueRelation direction: Linear's `Blocks` enum means "source blocks
  // related". For setBlockedBy(issueId, blockerId) — "issueId is blocked
  // by blockerId" — the source must be the BLOCKER and the related issue
  // must be the BLOCKED one. Getting this backwards reverses the arrow
  // in Linear's UI (codex review, FORGE-16).
  async setBlockedBy(issueId: string, blockerId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(blockerId, 'blockerId');
    const client = await this.getClient();

    let issue: LinearIssueLike;
    try {
      issue = await client.issue(issueId);
    } catch (err) {
      throw this.normalizeError(
        'setBlockedBy',
        err,
        classifyLinearError(err),
      );
    }

    const { forgeTaskId, blockerIds } = parseForgeFooters(issue.description);
    if (forgeTaskId === undefined) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `setBlockedBy: issue ${issue.identifier} has no forge:task footer; was it created outside of forge?`,
        { issueId, identifier: issue.identifier },
      );
    }

    // Footer write — only when blockerId isn't already recorded.
    if (!blockerIds.includes(blockerId)) {
      const newDescription = serializeWithForgeFooters(
        issue.description ?? '',
        forgeTaskId,
        [...blockerIds, blockerId],
      );
      try {
        await client.updateIssue(issueId, { description: newDescription });
      } catch (err) {
        throw this.normalizeError(
          'setBlockedBy',
          err,
          classifyLinearError(err),
        );
      }
    }

    // Native relation — ALWAYS attempted (idempotent via CONFLICT swallow).
    // Source = blocker; related = blocked issue. Linear's `Blocks` enum
    // means "source blocks related", so to express "issueId is blocked by
    // blockerId" we set source=blockerId, related=issueId.
    try {
      await client.createIssueRelation({
        issueId: blockerId,
        relatedIssueId: issueId,
        type: 'blocks',
      });
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'CONFLICT') return; // idempotent
      throw this.normalizeError('setBlockedBy', err, hint);
    }
  }

  // ─── Internal helpers used by subsequent commits ───────────────────────────
  // (Referenced now so the type seam is locked; bodies fill in as methods land.)

  protected getTeamId(): string {
    return this.teamId;
  }

  protected getRetryOpts(): WithRetryOpts {
    return this.retryOpts;
  }

  protected makeClaimLabel(runId: string): string {
    return `${CLAIM_LABEL_PREFIX}${runId}`;
  }

  // Constrain runId to a safe character class. The label-based claim's
  // lexicographic tiebreak depends on label content; if runId ever flows
  // from external input (multi-tenant future), an attacker could craft an
  // ID starting with `!` or similar to always win the race. Lock the seam
  // now (security-auditor, FORGE-16).
  //
  // Format matches the documented precondition in docs/adapters/linear.md:
  // alphanumerics, dot, underscore, hyphen. 1–80 chars. UUIDv7 run IDs
  // (FORGE-72 v2 contract) fit comfortably.
  protected assertValidRunId(runId: string): void {
    if (runId.length > 80) {
      throw new TrackerError(
        'VALIDATION',
        `runId exceeds 80 chars (length=${runId.length})`,
        { runIdLength: runId.length },
      );
    }
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new TrackerError(
        'VALIDATION',
        `runId must match [A-Za-z0-9._-]+ (got: ${runId.slice(0, 50)})`,
        { runIdPreview: runId.slice(0, 50) },
      );
    }
  }

  protected isClaimLabel(name: string): boolean {
    return name.startsWith(CLAIM_LABEL_PREFIX);
  }

  protected resolveClaimTiebreak(claims: readonly string[]): string {
    return tiebreakWinner(claims);
  }

  // Look up or create a label by name. Tolerates CONFLICT (parallel creates
  // by sibling orchestrators) by re-listing and finding the existing label.
  protected async ensureLabel(name: string): Promise<LinearLabelLike> {
    const cached = this.labelCacheByName.get(name);
    if (cached) return cached;

    const client = await this.getClient();

    // Refresh cache once on miss in case another process created it.
    try {
      const all = await client.listIssueLabels(this.teamId);
      for (const l of all) this.labelCacheByName.set(l.name, l);
      const hit = this.labelCacheByName.get(name);
      if (hit) return hit;
    } catch (err) {
      // Listing failures are recoverable — fall through to create attempt.
      this.logger.warn('tracker.ensureLabel.listFailed', {
        name,
        err: errMessage(err),
      });
    }

    try {
      const created = await client.createIssueLabel({
        teamId: this.teamId,
        name,
      });
      this.labelCacheByName.set(created.name, created);
      return created;
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'CONFLICT') {
        // Lost a race with another create; re-list and find the survivor.
        const all = await client.listIssueLabels(this.teamId);
        for (const l of all) this.labelCacheByName.set(l.name, l);
        const hit = this.labelCacheByName.get(name);
        if (hit) return hit;
        throw new TrackerError(
          'UNKNOWN',
          `label '${name}' reported CONFLICT but absent from listIssueLabels`,
          { name },
        );
      }
      throw err;
    }
  }

  protected async getWorkflowStates(): Promise<LinearWorkflowStateLike[]> {
    if (this.workflowStatesCache) return this.workflowStatesCache;
    const client = await this.getClient();
    this.workflowStatesCache = await client.listWorkflowStates(this.teamId);
    if (this.workflowStatesCache.length >= LINEAR_WORKFLOW_STATES_LIMIT) {
      // Truncation suspected. resolveForgeStateToLinear may PRECONDITION_FAILED
      // on a needed state-type that's in the truncated tail; warn-log so the
      // operator can see the cause rather than chasing a phantom missing-state
      // configuration (code-reviewer, FORGE-16).
      this.logger.warn('tracker.workflowStates', {
        reason: 'limit-hit',
        limit: LINEAR_WORKFLOW_STATES_LIMIT,
        teamId: this.teamId,
      });
    }
    return this.workflowStatesCache;
  }

  // Map a forge IssueState to (Linear workflow state id, overlay label name).
  // Throws PRECONDITION_FAILED if the team is missing a required state type
  // (e.g. no `started` for in_progress). Implements the §11 Q4 fallback:
  // when `blocked` lacks a `backlog` state, fall back to first `unstarted`
  // and warn-log once per process.
  protected async resolveForgeStateToLinear(
    state: IssueState,
  ): Promise<{ stateId: string; overlayLabel: string | null }> {
    const states = await this.getWorkflowStates();
    const byType = (t: LinearStateType) => states.find((s) => s.type === t);

    switch (state) {
      case 'todo': {
        const s = byType('unstarted') ?? byType('backlog') ?? byType('triage');
        if (!s) {
          throw this.missingStateError('todo', 'unstarted/backlog/triage');
        }
        return { stateId: s.id, overlayLabel: null };
      }
      case 'in_progress': {
        const s = byType('started');
        if (!s) throw this.missingStateError('in_progress', 'started');
        return { stateId: s.id, overlayLabel: null };
      }
      case 'in_review': {
        const s = byType('started');
        if (!s) throw this.missingStateError('in_review', 'started');
        return { stateId: s.id, overlayLabel: STATE_OVERLAY_IN_REVIEW };
      }
      case 'done': {
        const s = byType('completed');
        if (!s) throw this.missingStateError('done', 'completed');
        return { stateId: s.id, overlayLabel: null };
      }
      case 'cancelled': {
        const s = byType('canceled');
        if (!s) throw this.missingStateError('cancelled', 'canceled');
        return { stateId: s.id, overlayLabel: null };
      }
      case 'blocked': {
        const backlog = byType('backlog');
        if (backlog) {
          return { stateId: backlog.id, overlayLabel: STATE_OVERLAY_BLOCKED };
        }
        // §11 Q4 graceful degradation: fall back to first unstarted state.
        const unstarted = byType('unstarted') ?? byType('triage');
        if (!unstarted) {
          throw this.missingStateError('blocked', 'backlog or unstarted');
        }
        if (!this.warnedAboutBlockedFallback) {
          this.logger.warn('tracker.updateState.fallback', {
            reason: 'team-missing-backlog-state',
            forgeState: 'blocked',
            fallbackStateType: unstarted.type,
            overlayLabel: STATE_OVERLAY_BLOCKED,
          });
          this.warnedAboutBlockedFallback = true;
        }
        return { stateId: unstarted.id, overlayLabel: STATE_OVERLAY_BLOCKED };
      }
    }
  }

  private missingStateError(
    forgeState: IssueState,
    requiredType: string,
  ): TrackerError {
    return new TrackerError(
      'PRECONDITION_FAILED',
      `team has no workflow state matching '${requiredType}' (required for forge state '${forgeState}')`,
      { forgeState, requiredType, teamId: this.teamId },
    );
  }

  // Compute the addedLabelIds/removedLabelIds to make the issue's overlay
  // labels exactly { wantedOverlay } (or empty).
  //
  // Add path: ensureLabel creates the label if missing (so addedLabelIds
  // always has a valid id when wantedOverlay is set).
  //
  // Remove path: must NOT use ensureLabel — we don't want to create labels
  // we're about to remove. Instead we look them up via lookupExistingLabel
  // (lists team labels once on cache miss, populates cache, returns id if
  // found; null if the team never had that overlay label). Without this
  // lookup, a fresh orchestrator process with an empty labelCacheByName
  // would silently leave stale overlay labels on issues being transitioned
  // out of in_review or blocked (codex review, FORGE-16).
  protected async reconcileOverlayLabels(
    wantedOverlay: string | null,
  ): Promise<{ addedLabelIds: string[]; removedLabelIds: string[] }> {
    const overlayLabelNames = [STATE_OVERLAY_IN_REVIEW, STATE_OVERLAY_BLOCKED];
    const addedLabelIds: string[] = [];
    const removedLabelIds: string[] = [];
    for (const name of overlayLabelNames) {
      if (name === wantedOverlay) {
        try {
          const lbl = await this.ensureLabel(name);
          addedLabelIds.push(lbl.id);
        } catch (err) {
          this.logger.warn('tracker.updateState.overlayAddSkipped', {
            label: name,
            err: errMessage(err),
          });
        }
      } else {
        const existing = await this.lookupExistingLabel(name);
        if (existing) removedLabelIds.push(existing.id);
      }
    }
    return { addedLabelIds, removedLabelIds };
  }

  // Look up a label by name WITHOUT creating it. On cache miss, refresh
  // the cache once via listIssueLabels. Returns null if the team has no
  // label with that name. Used by overlay-label removal to construct ids
  // for labels we want to take OFF an issue without inadvertently creating
  // labels that never existed.
  protected async lookupExistingLabel(
    name: string,
  ): Promise<LinearLabelLike | null> {
    const cached = this.labelCacheByName.get(name);
    if (cached) return cached;
    try {
      const client = await this.getClient();
      const all = await client.listIssueLabels(this.teamId);
      for (const l of all) this.labelCacheByName.set(l.name, l);
    } catch (err) {
      this.logger.warn('tracker.lookupExistingLabel.listFailed', {
        name,
        err: errMessage(err),
      });
      return null;
    }
    return this.labelCacheByName.get(name) ?? null;
  }

  // Strict variant of lookupExistingLabel — throws a NORMALIZED TrackerError
  // on list failure instead of warn-and-return-null. Used by releaseClaim
  // (FORGE-76 / Codex 3rd-pass) where treating a transient listIssueLabels
  // failure as "label not on team" silently leaks the claim. The lookup-side
  // branches that want soft-fail (overlay label removal, claim-cleanup) keep
  // using lookupExistingLabel.
  //
  // Critical: the thrown error MUST be a TrackerError with a classified code
  // (TRANSPORT/TIMEOUT/RATE_LIMITED). BaseTracker.withRetry's defaultIsRetriable
  // tests `err instanceof TrackerError && isRetriableTrackerErrorCode(err.code)`
  // — a raw Linear error would short-circuit retry (Codex 4th-pass Finding 1).
  protected async lookupExistingLabelStrict(
    name: string,
  ): Promise<LinearLabelLike | null> {
    const cached = this.labelCacheByName.get(name);
    if (cached) return cached;
    const client = await this.getClient();
    let all: LinearLabelLike[];
    try {
      all = await client.listIssueLabels(this.teamId);
    } catch (err) {
      // Normalize so withRetry recognizes retriable codes
      // (TRANSPORT/TIMEOUT/RATE_LIMITED) and actually retries.
      throw this.normalizeError(
        'lookupExistingLabelStrict',
        err,
        classifyLinearError(err),
      );
    }
    for (const l of all) this.labelCacheByName.set(l.name, l);
    return this.labelCacheByName.get(name) ?? null;
  }

  // Best-effort label removal — used during claim cleanup. Logs and swallows;
  // never throws (the caller is already returning a non-ok ClaimResult).
  //
  // Uses lookupExistingLabel (not the raw cache) because the post-write
  // tiebreak-loss path can fire in a fresh process: the label was just
  // added to the issue but never went through ensureLabel/createIssueLabel
  // locally, so labelCacheByName may be cold. Cache-only check would
  // silently no-op, leaving the stale claim label on the issue
  // (code-reviewer, FORGE-16).
  protected async tryRemoveLabelByName(
    issueId: string,
    labelName: string,
  ): Promise<void> {
    let found: LinearLabelLike | null;
    try {
      found = await this.lookupExistingLabel(labelName);
    } catch (err) {
      this.logger.warn('tracker.tryRemoveLabelByName.lookupFailed', {
        issueId,
        labelName,
        err: errMessage(err),
      });
      return;
    }
    if (!found) return;
    try {
      const client = await this.getClient();
      await client.updateIssue(issueId, { removedLabelIds: [found.id] });
    } catch (err) {
      this.logger.warn('tracker.tryRemoveLabelByName', {
        issueId,
        labelName,
        err: errMessage(err),
      });
    }
  }
}

function stringifyDetailMessage(hint: NormalizeErrorHint): string {
  const message = hint.details?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return hint.code.toLowerCase();
}

// Derive forge IssueState from a Linear issue. Terminal states win
// unconditionally; for open states, overlay labels override the workflow
// type so `state:in-review` and `state:blocked` round-trip correctly.
export function deriveStateFromLinearIssue(raw: LinearIssueLike): IssueState {
  if (raw.state.type === 'completed') return 'done';
  if (raw.state.type === 'canceled') return 'cancelled';
  const labelNames = raw.labels.map((l) => l.name);
  if (labelNames.includes(STATE_OVERLAY_BLOCKED)) return 'blocked';
  if (labelNames.includes(STATE_OVERLAY_IN_REVIEW)) return 'in_review';
  if (raw.state.type === 'started') return 'in_progress';
  // 'unstarted', 'backlog', 'triage' → all map to 'todo' (open, not started)
  return 'todo';
}

// Convert a flattened Linear issue into forge's tracker-agnostic Issue.
export function toIssue(raw: LinearIssueLike): Issue {
  const { forgeTaskId, blockerIds } = parseForgeFooters(raw.description);
  const issue: Issue = {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    state: deriveStateFromLinearIssue(raw),
    blockerIds,
    url: raw.url,
  };
  if (forgeTaskId !== undefined) issue.forgeTaskId = forgeTaskId;
  return issue;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export Linear-scoped constants + adapter-local helpers. Footer helpers
// (parseForgeFooters, serializeWithForgeFooters) live in `./footers.ts` and
// are surfaced via `./index.ts`; do NOT re-export them here or future adapters
// will see two import paths for the same symbol.
export {
  CLAIM_LABEL_PREFIX,
  STATE_OVERLAY_IN_REVIEW,
  STATE_OVERLAY_BLOCKED,
  isTransientCode,
  tiebreakWinner,
};
