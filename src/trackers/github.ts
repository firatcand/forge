import { execa } from 'execa';
import { z } from 'zod';

import type { GithubTrackerConfig } from '../schemas/settings.ts';
import {
  GhIssueBodyOnlySchema,
  GhIssueJsonSchema,
  GhIssueLabelsOnlySchema,
  GhMilestoneJsonSchema,
  type GhIssueJson,
} from '../schemas/trackers.ts';
import {
  BaseTracker,
  type Logger,
  type NormalizeErrorHint,
  type WithRetryOpts,
} from './base.ts';
import { TrackerError } from './errors.ts';
import {
  assertValidBodyInput,
  parseClaimFooter,
  parseExtraForgeFooters,
  parseForgeFooters,
  serializeWithForgeFooters,
  type ForgeFooters,
} from './footers.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueListPage,
  IssueState,
} from './types.ts';

// ─── Public exec contract ────────────────────────────────────────────────────

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhExec = (
  args: readonly string[],
  opts?: { input?: string },
) => Promise<GhExecResult>;

const defaultGhExec: GhExec = async (args, opts) => {
  const result = await execa('gh', [...args], { input: opts?.input });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
  };
};

// ─── Constants ───────────────────────────────────────────────────────────────

const CLAIM_LABEL_PREFIX = 'forge:claimed-by:';

// GitHub enforces a 50-character hard cap on label names. A UUIDv7 with
// hyphens is 36 chars, giving 17 + 36 = 53 chars — 3 over the cap.
// Stripping hyphens reduces the UUID suffix to 32 hex chars: 17 + 32 = 49.
// The dehyphenation is a wire-format transform only; orchestrators always
// receive and supply canonical UUID form (with hyphens).
export function toStoredLabel(runId: string): string {
  return `${CLAIM_LABEL_PREFIX}${runId.replaceAll('-', '')}`;
}

// Inverse of toStoredLabel. Strict: rejects anything that is not exactly 32
// hex chars after the prefix (the dehyphenated UUIDv7 wire format). Non-UUID
// inputs (test mocks, legacy ids) would otherwise silently round-trip to
// malformed strings — Codex 2nd-opinion (FORGE-82) flagged this.
export function runIdFromStoredLabel(stored: string): string {
  const hex = stored.startsWith(CLAIM_LABEL_PREFIX)
    ? stored.slice(CLAIM_LABEL_PREFIX.length)
    : stored;
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TrackerError(
      'VALIDATION',
      `runIdFromStoredLabel: expected 32 hex chars after prefix, got ${hex.length} chars`,
      { stored, hex },
    );
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Exported so callers and tests can read the in-flight ceiling.
export const GH_LIST_LIMIT = 200;
// GitHub Issues body field hard cap (docs: 65,536 chars / bytes — UTF-8
// counted by GitHub as bytes per their API error responses).
export const GH_ISSUE_BODY_MAX_BYTES = 65_536;

const STATE_TO_LABEL: Readonly<Record<'in_progress' | 'in_review' | 'blocked', string>> = {
  in_progress: 'state:in-progress',
  in_review: 'state:in-review',
  blocked: 'state:blocked',
};

const LABEL_TO_STATE: Readonly<Record<string, IssueState>> = {
  'state:in-progress': 'in_progress',
  'state:in-review': 'in_review',
  'state:blocked': 'blocked',
};

const ALL_STATE_LABELS = Object.values(STATE_TO_LABEL);

// Footer regex/serializer helpers live in ./footers.ts — shared across
// trackers. github.ts re-exports them for back-compat (see end of file).

// ─── Error classification (per-adapter; BaseTracker stays generic) ───────────

interface ExecaErrorLike {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  code?: string;
  message?: string;
}

function isErrorLike(err: unknown): err is ExecaErrorLike {
  return typeof err === 'object' && err !== null;
}

// Branch order is load-bearing: AUTH must come before NOT_FOUND (gh's 403
// for private repos returns "Not Found" copy to avoid leaking existence);
// VALIDATION must come before CONFLICT (Validation Failed messages can
// include "already exists" verbatim).
export function classifyGitHubError(err: unknown): NormalizeErrorHint {
  if (!isErrorLike(err)) return { code: 'UNKNOWN' };
  const stderr = String(err.stderr ?? '');
  const exitCode = typeof err.exitCode === 'number' ? err.exitCode : -1;

  if (err.code === 'ENOENT') {
    return {
      code: 'TRANSPORT',
      details: { reason: 'gh-not-installed', stderr },
    };
  }

  if (
    /bad credentials|HTTP 401|gh auth login|authentication failed|HTTP 403(?! .*rate)/i.test(
      stderr,
    )
  ) {
    return { code: 'AUTH', details: { stderr } };
  }

  if (/API rate limit exceeded|secondary rate limit|HTTP 403.*rate/i.test(stderr)) {
    const retryAfterMs = parseRetryAfter(stderr);
    return {
      code: 'RATE_LIMITED',
      details: {
        stderr,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }

  // Tightened to avoid swallowing 403-as-"Not Found" responses; AUTH branch
  // above catches the 403 case first.
  if (/HTTP 404|could not resolve to a (?:Repository|Issue|Milestone|User|Organization)/i.test(stderr)) {
    return { code: 'NOT_FOUND', details: { stderr } };
  }

  if (/HTTP 422|validation failed/i.test(stderr)) {
    return { code: 'VALIDATION', details: { stderr } };
  }

  // stderr-only "label not found" path: gh issue edit exits non-zero with no
  // HTTP status code when the label name doesn't exist on the repo. Must come
  // AFTER the HTTP 422 branch so explicit 422 responses still classify first.
  // Compound guard: bare "not found" is already caught by the HTTP 404 branch
  // above; we only match when accompanied by "failed to update N issue(s)".
  if (
    (/not found/i.test(stderr) && /failed to update \d+ issue/i.test(stderr)) ||
    /label .+? does not exist/i.test(stderr)
  ) {
    return { code: 'VALIDATION', details: { stderr, reason: 'label-not-found' } };
  }

  // Must stay ordered after VALIDATION — "already exists" can appear inside
  // a 422 Validation Failed body and should classify as VALIDATION.
  if (/HTTP 409|already exists/i.test(stderr)) {
    return { code: 'CONFLICT', details: { stderr } };
  }

  if (err.code === 'ETIMEDOUT' || /timeout|ETIMEDOUT/i.test(stderr)) {
    return { code: 'TIMEOUT', details: { stderr } };
  }

  if (
    exitCode < 0 ||
    /HTTP 5\d\d|ECONNRESET|EAI_AGAIN|connection (?:refused|reset)/i.test(
      stderr,
    )
  ) {
    return { code: 'TRANSPORT', details: { stderr, exitCode } };
  }

  return { code: 'UNKNOWN', details: { stderr, exitCode } };
}

function parseRetryAfter(stderr: string): number | undefined {
  const match = stderr.match(/retry[- ]?after:?\s*(\d+)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

// Re-export footer helpers for back-compat (callers import from './github.ts').
export { parseForgeFooters, serializeWithForgeFooters };
export type { ForgeFooters };

// ─── State mapping ───────────────────────────────────────────────────────────

function deriveOpenStateFromLabels(labels: readonly string[]): IssueState {
  for (const label of labels) {
    const mapped = LABEL_TO_STATE[label];
    if (mapped !== undefined) return mapped;
  }
  return 'todo';
}

// Closed GitHub issues map to a terminal forge state (NOT_PLANNED → cancelled,
// otherwise done) so /reconcile orphan detection treats a Done-bound task as
// present rather than removed. Open issues fall back to the label-derived
// workflow state. `state`/`stateReason` are only present on list-path JSON.
function deriveGitHubState(
  raw: GhIssueJson,
  labels: readonly string[],
): IssueState {
  if (raw.state?.toUpperCase() === 'CLOSED') {
    return raw.stateReason?.toUpperCase() === 'NOT_PLANNED'
      ? 'cancelled'
      : 'done';
  }
  return deriveOpenStateFromLabels(labels);
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface GitHubTrackerOptions {
  gh?: GhExec;
  /**
   * Override default retry options (mostly useful for tests — pass
   * `{ sleep: async () => {} }` to skip backoff delays).
   */
  retry?: WithRetryOpts;
}

export class GitHubTracker extends BaseTracker<GithubTrackerConfig> {
  readonly type = 'github' as const;

  private readonly gh: GhExec;
  private readonly repo: string;
  private readonly retryOpts: WithRetryOpts;
  private readonly precreatedLabels = new Set<string>();

  constructor(
    config: GithubTrackerConfig,
    logger: Logger,
    options: GitHubTrackerOptions = {},
  ) {
    super(config, logger);
    this.gh = options.gh ?? defaultGhExec;
    this.repo = config.config.repo;
    this.retryOpts = options.retry ?? {};
  }

  // ─── healthCheck — never throws ────────────────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const result = await this.gh(['auth', 'status']);
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        detail: result.stderr || 'gh auth status returned non-zero exit code',
      };
    } catch (err) {
      const hint = classifyGitHubError(err);
      const reasonDetail = hint.details?.reason;
      if (reasonDetail === 'gh-not-installed') {
        return { ok: false, detail: 'gh CLI not installed (ENOENT)' };
      }
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'unknown error';
      return { ok: false, detail: message };
    }
  }

  // ─── listActiveIssues ──────────────────────────────────────────────────────

  async listActiveIssues(): Promise<Issue[]> {
    const page = await this.listByState('open', 'listActiveIssues');
    return page.issues;
  }

  // All issues incl. closed (done/cancelled) — see Tracker.listAllIssues.
  async listAllIssues(): Promise<IssueListPage> {
    return this.listByState('all', 'listAllIssues');
  }

  private async listByState(
    ghState: 'open' | 'all',
    op: string,
  ): Promise<IssueListPage> {
    return this.withRetry(
      op,
      async () => {
        const args = [
          'issue',
          'list',
          '--repo',
          this.repo,
          '--state',
          ghState,
          '--json',
          'id,number,title,labels,body,url,state,stateReason',
          '--limit',
          String(GH_LIST_LIMIT),
        ];

        let result: GhExecResult;
        try {
          result = await this.gh(args);
        } catch (err) {
          throw this.normalizeError(op, err, classifyGitHubError(err));
        }

        let parsed: GhIssueJson[];
        try {
          const raw = JSON.parse(result.stdout) as unknown;
          parsed = z.array(GhIssueJsonSchema).parse(raw);
        } catch (err) {
          throw this.normalizeError(op, err, {
            code: 'VALIDATION',
            details: {
              reason: 'gh-json-parse-failed',
              stdoutPreview: result.stdout.slice(0, 500),
            },
          });
        }

        const truncated = parsed.length >= GH_LIST_LIMIT;
        if (truncated) {
          this.logger.warn(`tracker.${op}`, {
            reason: 'limit-hit',
            limit: GH_LIST_LIMIT,
            repo: this.repo,
          });
        }

        return { issues: parsed.map((raw) => this.toIssue(raw)), truncated };
      },
      this.retryOpts,
    );
  }

  // ─── claim — load-bearing atomic-with-tiebreak primitive ───────────────────

  async claim(issueId: string, runId: string): Promise<ClaimResult> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    const myLabel = toStoredLabel(runId);
    const number = this.parseIssueNumber(issueId);

    // Step 1: read current labels (retriable on transport errors).
    let initial: string[];
    try {
      initial = await this.withRetry(
        'claim.read',
        () => this.readIssueLabels(number),
        this.retryOpts,
      );
    } catch (err) {
      if (err instanceof TrackerError) {
        if (err.code === 'NOT_FOUND') {
          // Issue vanished before we could read it — treat as version_conflict,
          // not a thrown error, so the poll-loop moves on cleanly.
          return {
            ok: false,
            reason: 'version_conflict',
            detail: 'issue-not-found-on-initial-read',
          };
        }
        if (isTransientCode(err.code)) {
          return {
            ok: false,
            reason: 'transient_error',
            detail: err.message,
          };
        }
      }
      throw err;
    }

    const existingClaims = initial.filter((l) =>
      l.startsWith(CLAIM_LABEL_PREFIX),
    );

    if (existingClaims.length > 0) {
      if (
        existingClaims.length === 1 &&
        existingClaims[0] === myLabel
      ) {
        return { ok: true };
      }
      if (existingClaims.includes(myLabel)) {
        // Multiple claims including ours — apply tiebreak.
        const winner = tiebreakWinner(existingClaims);
        if (winner === myLabel) return { ok: true };
        await this.tryRemoveLabel(number, myLabel);
        return {
          ok: false,
          reason: 'version_conflict',
          detail: `lost-tiebreak-to:${winner}`,
        };
      }
      return {
        ok: false,
        reason: 'already_claimed',
        detail: existingClaims.join(','),
      };
    }

    // Step 2: precreate label + add it.
    try {
      await this.ensureLabelExists(myLabel);
      await this.gh([
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--add-label',
        myLabel,
      ]);
    } catch (err) {
      const hint = classifyGitHubError(err);
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
          detail: stderrOf(hint),
        };
      }
      if (hint.code === 'VALIDATION') {
        return {
          ok: false,
          reason: 'version_conflict',
          detail: `label-mutation-failed:${(hint.details as { reason?: string } | undefined)?.reason ?? 'validation'}`,
        };
      }
      throw this.normalizeError('claim', err, hint);
    }

    // Step 3: re-read for race detection.
    let post: string[];
    try {
      post = await this.withRetry(
        'claim.recheck',
        () => this.readIssueLabels(number),
        this.retryOpts,
      );
    } catch (err) {
      // Can't verify — be conservative, release our label.
      await this.tryRemoveLabel(number, myLabel);
      if (err instanceof TrackerError) {
        if (err.code === 'NOT_FOUND') {
          // Issue vanished between our write and the re-read.
          return {
            ok: false,
            reason: 'version_conflict',
            detail: 'issue-not-found-on-recheck',
          };
        }
        if (isTransientCode(err.code)) {
          return {
            ok: false,
            reason: 'transient_error',
            detail: err.message,
          };
        }
      }
      throw err;
    }

    const allClaims = post.filter((l) => l.startsWith(CLAIM_LABEL_PREFIX));

    // Verify-on-readback contract (spec/ORCHESTRATOR.md §Tracker atomic claim):
    // (a) our label MUST be present AND (b) no other forge:claimed-by:* label
    // (stored dehyphenated form) MUST be present. If our label is missing on
    // reread, the add silently failed or was stripped (e.g., GitHub label cap,
    // concurrent admin action, or another orchestrator removed it). Either way:
    // we don't hold the claim. Best-effort remove (in case it does exist on
    // the server but our reread was stale) and return version_conflict.
    if (!allClaims.includes(myLabel)) {
      await this.tryRemoveLabel(number, myLabel);
      return {
        ok: false,
        reason: 'version_conflict',
        detail: 'claim-label-missing-on-recheck',
      };
    }

    if (allClaims.length === 1) return { ok: true };

    const winner = tiebreakWinner(allClaims);
    if (winner === myLabel) return { ok: true };

    await this.tryRemoveLabel(number, myLabel);
    return {
      ok: false,
      reason: 'version_conflict',
      detail: `lost-tiebreak-to:${winner}`,
    };
  }

  // ─── releaseClaim — strict-scoped, idempotent ──────────────────────────────
  //
  // Removes only the stored (dehyphenated) form of forge:claimed-by:{runId} —
  // the caller's own label. Does not police other agents' labels. Trusted-
  // caller contract: callers only invoke this on issues they own.
  //
  // Idempotent: a missing label (already-removed, never-set, or issue closed
  // /deleted) is swallowed silently. Per spec/ORCHESTRATOR.md §Tracker
  // atomic claim — release is best-effort cleanup.

  async releaseClaim(issueId: string, runId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(runId, 'runId');
    const number = this.parseIssueNumber(issueId);
    const myLabel = toStoredLabel(runId);

    try {
      await this.gh([
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--remove-label',
        myLabel,
      ]);
    } catch (err) {
      const hint = classifyGitHubError(err);
      const stderrText = stderrOf(hint);
      if (
        hint.code === 'NOT_FOUND' ||
        /not found|does not have label|is not on/i.test(stderrText)
      ) {
        return;
      }
      throw this.normalizeError('releaseClaim', err, hint);
    }
  }

  // ─── updateState ───────────────────────────────────────────────────────────

  async updateState(issueId: string, state: IssueState): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    const number = this.parseIssueNumber(issueId);

    try {
      if (state === 'done') {
        await this.gh([
          'issue',
          'close',
          String(number),
          '--repo',
          this.repo,
          '--reason',
          'completed',
        ]);
        return;
      }
      if (state === 'cancelled') {
        // gh CLI accepts the human-readable form ("not planned", with a
        // space) — NOT the GitHub API enum spelling ("not_planned").
        await this.gh([
          'issue',
          'close',
          String(number),
          '--repo',
          this.repo,
          '--reason',
          'not planned',
        ]);
        return;
      }

      // Open state — ensure issue is open (tolerate already-open).
      try {
        await this.gh([
          'issue',
          'reopen',
          String(number),
          '--repo',
          this.repo,
        ]);
      } catch (err) {
        const hint = classifyGitHubError(err);
        const stderrText = stderrOf(hint);
        if (!/already open|is already open/i.test(stderrText)) {
          throw err;
        }
      }

      const removeLabels = ALL_STATE_LABELS.join(',');
      const args: string[] = [
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--remove-label',
        removeLabels,
      ];

      if (state !== 'todo') {
        const addLabel = STATE_TO_LABEL[state];
        await this.ensureLabelExists(addLabel);
        args.push('--add-label', addLabel);
      }

      await this.gh(args);
    } catch (err) {
      throw this.normalizeError('updateState', err, classifyGitHubError(err));
    }
  }

  // ─── comment ───────────────────────────────────────────────────────────────

  async comment(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(body, 'body');
    const number = this.parseIssueNumber(issueId);
    try {
      await this.gh([
        'issue',
        'comment',
        String(number),
        '--repo',
        this.repo,
        '--body',
        body,
      ]);
    } catch (err) {
      throw this.normalizeError('comment', err, classifyGitHubError(err));
    }
  }

  // ─── createProject → GitHub milestone ──────────────────────────────────────

  async createProject(
    name: string,
    description?: string,
  ): Promise<{ id: string; url: string }> {
    this.assertNonEmpty(name, 'name');

    const args = [
      'api',
      `repos/${this.repo}/milestones`,
      '--method',
      'POST',
      '-f',
      `title=${name}`,
    ];
    if (description !== undefined && description.length > 0) {
      args.push('-f', `description=${description}`);
    }

    let result: GhExecResult;
    try {
      result = await this.gh(args);
    } catch (err) {
      throw this.normalizeError(
        'createProject',
        err,
        classifyGitHubError(err),
      );
    }

    try {
      const parsed = GhMilestoneJsonSchema.parse(JSON.parse(result.stdout));
      // Precreate state labels as part of project setup so updateState calls
      // never need a label-create round-trip.
      await this.precreateStateLabels().catch((err) => {
        this.logger.warn('tracker.createProject', {
          reason: 'state-label-precreate-failed',
          err: errToString(err),
        });
      });
      return { id: String(parsed.number), url: parsed.html_url };
    } catch (err) {
      throw this.normalizeError('createProject', err, {
        code: 'VALIDATION',
        details: { reason: 'milestone-parse-failed' },
      });
    }
  }

  // ─── createIssue ───────────────────────────────────────────────────────────

  async createIssue(payload: CreateIssuePayload): Promise<Issue> {
    this.assertNonEmpty(payload.title, 'payload.title');
    this.assertNonEmpty(payload.forgeTaskId, 'payload.forgeTaskId');
    this.assertNonEmpty(payload.ownerType, 'payload.ownerType');

    const extraFooters = [
      `<!-- forge:ownerType=${payload.ownerType} -->`,
    ];
    const bodyWithFooter = serializeWithForgeFooters(
      payload.body,
      payload.forgeTaskId,
      [],
      extraFooters,
    );

    let createResult: GhExecResult;
    try {
      createResult = await this.gh([
        'issue',
        'create',
        '--repo',
        this.repo,
        '--title',
        payload.title,
        '--body',
        bodyWithFooter,
      ]);
    } catch (err) {
      throw this.normalizeError('createIssue', err, classifyGitHubError(err));
    }

    const url = createResult.stdout.trim();
    const number = this.parseIssueNumber(url);

    let viewResult: GhExecResult;
    try {
      viewResult = await this.gh([
        'issue',
        'view',
        String(number),
        '--repo',
        this.repo,
        '--json',
        'id,number,title,labels,body,url',
      ]);
    } catch (err) {
      throw this.normalizeError('createIssue', err, classifyGitHubError(err));
    }

    let parsed: GhIssueJson;
    try {
      parsed = GhIssueJsonSchema.parse(JSON.parse(viewResult.stdout));
    } catch (err) {
      throw this.normalizeError('createIssue', err, {
        code: 'VALIDATION',
        details: { reason: 'gh-json-parse-failed' },
      });
    }

    return this.toIssue(parsed);
  }

  // ─── setBlockedBy — body-footer rewrite ────────────────────────────────────

  async setBlockedBy(issueId: string, blockerId: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    this.assertNonEmpty(blockerId, 'blockerId');
    if (!/^\d+$/.test(blockerId)) {
      throw new TrackerError(
        'VALIDATION',
        `blockerId must be a numeric GitHub issue number, got: ${blockerId}`,
        { blockerId },
      );
    }
    const number = this.parseIssueNumber(issueId);

    let viewResult: GhExecResult;
    try {
      viewResult = await this.gh([
        'issue',
        'view',
        String(number),
        '--repo',
        this.repo,
        '--json',
        'body',
      ]);
    } catch (err) {
      throw this.normalizeError('setBlockedBy', err, classifyGitHubError(err));
    }

    let body: string;
    try {
      const parsed = GhIssueBodyOnlySchema.parse(JSON.parse(viewResult.stdout));
      body = parsed.body ?? '';
    } catch (err) {
      throw this.normalizeError('setBlockedBy', err, {
        code: 'VALIDATION',
        details: { reason: 'view-parse-failed' },
      });
    }

    const { forgeTaskId, blockerIds } = parseForgeFooters(body);
    if (forgeTaskId === undefined) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `setBlockedBy: issue #${number} has no forge:task footer; was it created outside of forge?`,
        { issueId, number },
      );
    }

    if (blockerIds.includes(blockerId)) return; // dedup

    const newBody = serializeWithForgeFooters(body, forgeTaskId, [
      ...blockerIds,
      blockerId,
    ]);

    try {
      await this.gh([
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--body',
        newBody,
      ]);
    } catch (err) {
      throw this.normalizeError('setBlockedBy', err, classifyGitHubError(err));
    }
  }

  // ─── updateIssueBody — body-footer rewrite (FORGE-94) ──────────────────────
  //
  // Replaces issue body wholesale while preserving forge:task + forge:blockedBy
  // footers. Mirror of setBlockedBy's view-parse-edit loop, except the *body*
  // is the input and *blockerIds* are read-through.
  async updateIssueBody(issueId: string, body: string): Promise<void> {
    this.assertNonEmpty(issueId, 'issueId');
    assertValidBodyInput(body, GH_ISSUE_BODY_MAX_BYTES);
    const number = this.parseIssueNumber(issueId);

    let viewResult: GhExecResult;
    try {
      viewResult = await this.gh([
        'issue',
        'view',
        String(number),
        '--repo',
        this.repo,
        '--json',
        'body',
      ]);
    } catch (err) {
      throw this.normalizeError(
        'updateIssueBody',
        err,
        classifyGitHubError(err),
      );
    }

    let existing: string;
    try {
      const parsed = GhIssueBodyOnlySchema.parse(JSON.parse(viewResult.stdout));
      existing = parsed.body ?? '';
    } catch (err) {
      throw this.normalizeError('updateIssueBody', err, {
        code: 'VALIDATION',
        details: { reason: 'view-parse-failed' },
      });
    }

    const { forgeTaskId, blockerIds } = parseForgeFooters(existing);
    if (forgeTaskId === undefined) {
      throw new TrackerError(
        'PRECONDITION_FAILED',
        `updateIssueBody: issue #${number} has no forge:task footer; was it created outside of forge?`,
        { issueId, number },
      );
    }
    const extraFooters = parseExtraForgeFooters(existing);

    const newBody = serializeWithForgeFooters(
      body,
      forgeTaskId,
      blockerIds,
      extraFooters,
    );

    try {
      await this.gh([
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--body',
        newBody,
      ]);
    } catch (err) {
      throw this.normalizeError(
        'updateIssueBody',
        err,
        classifyGitHubError(err),
      );
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private parseIssueNumber(idOrUrl: string): number {
    const trimmed = idOrUrl.trim();
    const hashMatch = trimmed.match(/^#?(\d+)$/);
    if (hashMatch) return Number(hashMatch[1]);
    const urlMatch = trimmed.match(/\/issues\/(\d+)(?:[/?#]|$)/);
    if (urlMatch) return Number(urlMatch[1]);
    throw new TrackerError(
      'VALIDATION',
      `Could not parse GitHub issue number from: ${idOrUrl}`,
      { issueId: idOrUrl },
    );
  }

  private toIssue(raw: GhIssueJson): Issue {
    const labels = raw.labels.map((l) => l.name);
    const { forgeTaskId, blockerIds } = parseForgeFooters(raw.body);
    const claim = parseClaimFooter(raw.body);
    const issue: Issue = {
      id: String(raw.number),
      identifier: `#${raw.number}`,
      title: raw.title,
      state: deriveGitHubState(raw, labels),
      blockerIds,
      url: raw.url,
    };
    if (forgeTaskId !== undefined) issue.forgeTaskId = forgeTaskId;
    if (claim) {
      issue.claimId = claim.claimId;
      issue.claimGeneration = claim.generation;
      issue.claimOwnerRunId = claim.ownerRunId;
    }
    return issue;
  }

  private async readIssueLabels(number: number): Promise<string[]> {
    let result: GhExecResult;
    try {
      result = await this.gh([
        'issue',
        'view',
        String(number),
        '--repo',
        this.repo,
        '--json',
        'labels',
      ]);
    } catch (err) {
      throw this.normalizeError(
        'readIssueLabels',
        err,
        classifyGitHubError(err),
      );
    }
    try {
      const parsed = GhIssueLabelsOnlySchema.parse(JSON.parse(result.stdout));
      return parsed.labels.map((l) => l.name);
    } catch (err) {
      throw this.normalizeError('readIssueLabels', err, {
        code: 'VALIDATION',
        details: { reason: 'labels-parse-failed' },
      });
    }
  }

  private async tryRemoveLabel(number: number, label: string): Promise<void> {
    try {
      await this.gh([
        'issue',
        'edit',
        String(number),
        '--repo',
        this.repo,
        '--remove-label',
        label,
      ]);
    } catch (err) {
      this.logger.warn('tracker.tryRemoveLabel', {
        number,
        label,
        err: errToString(err),
      });
    }
  }

  private async ensureLabelExists(name: string): Promise<void> {
    if (this.precreatedLabels.has(name)) return;
    try {
      await this.gh([
        'label',
        'create',
        name,
        '--repo',
        this.repo,
        '--force',
      ]);
      this.precreatedLabels.add(name);
    } catch (err) {
      const hint = classifyGitHubError(err);
      if (
        hint.code === 'CONFLICT' ||
        hint.code === 'VALIDATION' ||
        /already exists/i.test(stderrOf(hint))
      ) {
        // CONFLICT: label already exists — treat as success.
        // VALIDATION: label create refused (e.g. invalid chars, or 422 from
        // GitHub's cap — shouldn't occur post-dehyphenation but belt-and-
        // suspenders). The downstream `issue edit --add-label` will fail with
        // "label not found" stderr, which classifyGitHubError maps to
        // VALIDATION → claim() returns version_conflict rather than throwing.
        this.precreatedLabels.add(name);
        return;
      }
      // Don't fail the parent op — log so flakiness is observable. The
      // downstream `issue edit --add-label` will fail with "label not found"
      // stderr, handled by claim()'s catch block as version_conflict.
      this.logger.warn('tracker.ensureLabelExists', {
        name,
        err: errToString(err),
      });
    }
  }

  private async precreateStateLabels(): Promise<void> {
    for (const label of ALL_STATE_LABELS) {
      await this.ensureLabelExists(label);
    }
  }
}

// ─── small util ──────────────────────────────────────────────────────────────

function isTransientCode(
  code: NormalizeErrorHint['code'],
): code is 'TRANSPORT' | 'TIMEOUT' | 'RATE_LIMITED' {
  return code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'RATE_LIMITED';
}

// Locale-aware lexicographic tiebreak — case-insensitive, locale-stable
// across hosts. Default `Array.sort()` uses UTF-16 code units which puts
// 'Z' < 'a'; we don't want case to swing claim outcomes.
function tiebreakWinner(claims: readonly string[]): string {
  return [...claims].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' }),
  )[0]!;
}

function stderrOf(hint: NormalizeErrorHint): string {
  return String(hint.details?.stderr ?? '');
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
