import type { TrackerConfig } from '../schemas/settings.ts';
import {
  TrackerError,
  isRetriableTrackerErrorCode,
  type TrackerErrorCode,
} from './errors.ts';
import type {
  ClaimResult,
  CreateIssuePayload,
  Issue,
  IssueState,
  TrackerType,
} from './types.ts';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface Tracker {
  readonly type: TrackerType;

  listActiveIssues(): Promise<Issue[]>;

  claim(issueId: string, runId: string): Promise<ClaimResult>;
  releaseClaim(issueId: string, runId: string): Promise<void>;

  updateState(issueId: string, state: IssueState): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;

  // Replaces the entire issue body. Adapter implementations MUST preserve the
  // trailing forgeTaskId footer added by createIssue() so the round-trip mapping
  // (tracker → forgeTaskId) keeps working. Caller assembles new body content.
  // Added 2026-05-17 for /apply-decision + /reconcile propagation (FORGE-94).
  updateIssueBody(issueId: string, body: string): Promise<void>;

  createProject(name: string, description?: string): Promise<{ id: string; url: string }>;
  createIssue(payload: CreateIssuePayload): Promise<Issue>;
  setBlockedBy(issueId: string, blockerId: string): Promise<void>;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface WithRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetriable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface NormalizeErrorHint {
  code: TrackerErrorCode;
  details?: Record<string, unknown>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

export abstract class BaseTracker<C extends TrackerConfig = TrackerConfig>
  implements Tracker
{
  static readonly MAX_BACKOFF_MS = 300_000;

  abstract readonly type: TrackerType;

  protected readonly config: C;
  protected readonly logger: Logger;

  constructor(config: C, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  abstract listActiveIssues(): Promise<Issue[]>;
  abstract claim(issueId: string, runId: string): Promise<ClaimResult>;
  abstract releaseClaim(issueId: string, runId: string): Promise<void>;
  abstract updateState(issueId: string, state: IssueState): Promise<void>;
  abstract comment(issueId: string, body: string): Promise<void>;
  abstract updateIssueBody(issueId: string, body: string): Promise<void>;
  abstract createProject(
    name: string,
    description?: string,
  ): Promise<{ id: string; url: string }>;
  abstract createIssue(payload: CreateIssuePayload): Promise<Issue>;
  abstract setBlockedBy(issueId: string, blockerId: string): Promise<void>;
  abstract healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  // BaseTracker composes; it does not sniff provider-specific errors.
  // Adapters classify their own errors and pass the result via hint.
  protected normalizeError(
    op: string,
    err: unknown,
    hint: NormalizeErrorHint = { code: 'UNKNOWN' },
  ): TrackerError {
    if (err instanceof TrackerError) return err;

    const details: Record<string, unknown> = { ...(hint.details ?? {}) };
    if (err && typeof err === 'object' && !(err instanceof Error)) {
      for (const [k, v] of Object.entries(err as Record<string, unknown>)) {
        if (!(k in details)) details[k] = v;
      }
    }

    const errMessage =
      err instanceof Error
        ? err.message
        : err === null
          ? 'null'
          : err === undefined
            ? 'undefined'
            : typeof err === 'string'
              ? err
              : String(err);
    const detail = errMessage.length > 0 ? errMessage : hint.code.toLowerCase();
    const message = `tracker.${op}: ${hint.code} — ${detail}`;

    return new TrackerError(hint.code, message, details, { cause: err });
  }

  // Symphony backoff: min(base * 2^(attempt-1), maxDelayMs).
  protected retryDelayMs(
    attempt: number,
    baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
    maxDelayMs: number = BaseTracker.MAX_BACKOFF_MS,
  ): number {
    if (attempt < 1) return 0;
    const exp = baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exp, maxDelayMs);
  }

  protected async withRetry<T>(
    op: string,
    fn: () => Promise<T>,
    opts: WithRetryOpts = {},
  ): Promise<T> {
    const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
    const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = opts.maxDelayMs ?? BaseTracker.MAX_BACKOFF_MS;
    const isRetriable = opts.isRetriable ?? defaultIsRetriable;
    const sleep = opts.sleep ?? defaultSleep;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === attempts || !isRetriable(err)) {
          throw err;
        }
        const delay = this.retryDelayMs(attempt, baseDelayMs, maxDelayMs);
        this.logger.warn('tracker.retry', { op, attempt, delay });
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  protected assertNonEmpty(
    value: unknown,
    fieldName: string,
  ): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TrackerError(
        'VALIDATION',
        `${fieldName} must be a non-empty string`,
        { fieldName, value },
      );
    }
  }
}

function defaultIsRetriable(err: unknown): boolean {
  return err instanceof TrackerError && isRetriableTrackerErrorCode(err.code);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
