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
  viewer(): Promise<{ id: string; email: string }>;
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

const CLAIM_LABEL_PREFIX = 'claimed:agent-';
const STATE_OVERLAY_IN_REVIEW = 'state:in-review';
const STATE_OVERLAY_BLOCKED = 'state:blocked';

export const LINEAR_LIST_LIMIT = 200;

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
    return { code: 'AUTH', details: { status, message } };
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
      return { id: v.id, email: v.email };
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
      const conn = await client.workflowStates({
        filter: { team: { id: { eq: teamId } } },
        first: 100,
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

    async createIssueRelation({ issueId, relatedIssueId, type: _type }) {
      // Seam constrains `type` to 'blocks'; map to SDK enum here so callers
      // don't need to import @linear/sdk just to write a string. _type
      // intentionally unused — kept on the seam for future relation types.
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
    this.clientPromise = (async () => {
      const apiKey = process.env.LINEAR_API_KEY;
      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new TrackerError(
          'AUTH',
          'LINEAR_API_KEY not set (export a Linear Personal API Key — see docs/adapters/linear.md)',
        );
      }
      return wrapLinearClient(new LinearClient({ apiKey }));
    })();
    return this.clientPromise;
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
    throw new TrackerError('UNKNOWN', 'listActiveIssues not implemented');
  }

  // Three-step claim with tiebreak — mirrors GitHubTracker.claim exactly.
  //
  // SPEC.md L207 says "atomic via Linear revisions / custom field
  // forge_claimed_by". Linear's GraphQL API exposes neither (verified against
  // schema 2026-05). We use label-add + lexicographic tiebreak for the
  // race-loser case; the tiebreak gives us the atomicity SPEC requires from
  // the orchestrator's perspective even though the underlying writes are
  // not strict CAS. See plan §3.3 / EUREKA in frontmatter.
  async claim(issueId: string, agentId: string): Promise<ClaimResult> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(agentId, 'agentId');
    const client = await this.getClient();
    const myLabelName = this.makeClaimLabel(agentId);

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
          reason: 'state_changed',
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
          reason: 'state_changed',
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
          reason: 'state_changed',
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
          reason: 'state_changed',
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
    if (allClaims.length <= 1) return { ok: true };

    const winner = this.resolveClaimTiebreak(allClaims.map((l) => l.name));
    if (winner === myLabelName) return { ok: true };

    await this.tryRemoveLabelByName(issueId, myLabelName);
    return {
      ok: false,
      reason: 'state_changed',
      detail: `lost-tiebreak-to:${winner}`,
    };
  }

  // Idempotent broad release: removes every claimed:agent-* label, mirroring
  // GitHubTracker.releaseClaim. The Tracker.releaseClaim(issueId) interface
  // takes no agentId (SPEC line 187 / FORGE-14 plan §3.3) — the orchestrator
  // is single-process and trusted; callers only invoke this on issues they
  // own or are explicitly cleaning up.
  async releaseClaim(issueId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    const client = await this.getClient();

    let issue: LinearIssueLike;
    try {
      issue = await this.withRetry(
        'releaseClaim.read',
        () => client.issue(issueId),
        this.retryOpts,
      );
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'NOT_FOUND') return; // already gone — idempotent
      throw this.normalizeError('releaseClaim', err, hint);
    }

    const claimLabelIds = issue.labels
      .filter((l) => this.isClaimLabel(l.name))
      .map((l) => l.id);
    if (claimLabelIds.length === 0) return;

    try {
      await client.updateIssue(issueId, { removedLabelIds: claimLabelIds });
    } catch (err) {
      const hint = classifyLinearError(err);
      if (hint.code === 'NOT_FOUND') return; // raced with delete — idempotent
      throw this.normalizeError('releaseClaim', err, hint);
    }
  }

  async updateState(_issueId: string, _state: IssueState): Promise<void> {
    throw new TrackerError('UNKNOWN', 'updateState not implemented');
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
    _name: string,
    _description?: string,
  ): Promise<{ id: string; url: string }> {
    throw new TrackerError('UNKNOWN', 'createProject not implemented');
  }

  async createIssue(_payload: CreateIssuePayload): Promise<Issue> {
    throw new TrackerError('UNKNOWN', 'createIssue not implemented');
  }

  async setBlockedBy(_issueId: string, _blockerId: string): Promise<void> {
    throw new TrackerError('UNKNOWN', 'setBlockedBy not implemented');
  }

  // ─── Internal helpers used by subsequent commits ───────────────────────────
  // (Referenced now so the type seam is locked; bodies fill in as methods land.)

  protected getTeamId(): string {
    return this.teamId;
  }

  protected getRetryOpts(): WithRetryOpts {
    return this.retryOpts;
  }

  protected makeClaimLabel(agentId: string): string {
    return `${CLAIM_LABEL_PREFIX}${agentId}`;
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

  // Best-effort label removal — used during claim cleanup. Logs and swallows;
  // never throws (the caller is already returning a non-ok ClaimResult).
  protected async tryRemoveLabelByName(
    issueId: string,
    labelName: string,
  ): Promise<void> {
    const cached = this.labelCacheByName.get(labelName);
    if (!cached) return;
    try {
      const client = await this.getClient();
      await client.updateIssue(issueId, { removedLabelIds: [cached.id] });
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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export the underscore-prefixed helpers other adapters may want to share.
// (Kept inside this file so it's clear they're Linear-scoped today.)
export {
  CLAIM_LABEL_PREFIX,
  STATE_OVERLAY_IN_REVIEW,
  STATE_OVERLAY_BLOCKED,
  isTransientCode,
  tiebreakWinner,
  parseForgeFooters,
  serializeWithForgeFooters,
};
