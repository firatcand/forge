import type { ReviewVerdict } from '../schemas/verdict.ts';

export type { ReviewVerdict } from '../schemas/verdict.ts';

// FORGE-160: `cursor` joins as a beta primary host. Review hosts remain
// codex | gemini (cursor.runReview throws NOT_SUPPORTED).
export type HarnessHost = 'claude' | 'codex' | 'gemini' | 'cursor';

export interface DispatchOpts {
  readonly cwd: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SubagentHandle {
  readonly taskId: string;
  readonly attemptId: string;
  wait(): Promise<SubagentResult>;
}

export type SubagentVerdict =
  | 'completed'
  | 'blocked'
  | 'stolen'
  | 'timeout'
  | 'spawn_error';

export interface SubagentResult {
  readonly verdict: SubagentVerdict;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface HealthResult {
  readonly ok: boolean;
  readonly version?: string;
  readonly message?: string;
}

export interface IHarness {
  readonly host: HarnessHost;
  dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle>;
  runReview(
    diff: string,
    reviewPrompt: string,
    opts: DispatchOpts,
  ): Promise<ReviewVerdict>;
  healthCheck(): Promise<HealthResult>;
  detectVersion(): Promise<string>;
}

export type HarnessErrorCode =
  | 'NOT_SUPPORTED'
  | 'SPAWN_FAILED'
  | 'BINARY_NOT_FOUND'
  | 'NON_ZERO_EXIT'
  | 'TIMEOUT'
  | 'EXPERIMENTAL_GATE_CLOSED'
  | 'CALLBACK_MISSING'
  | 'INVALID_STDOUT';

export interface HarnessErrorDetails {
  readonly [key: string]: unknown;
}

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly host: HarnessHost;
  readonly details: HarnessErrorDetails;

  constructor(
    code: HarnessErrorCode,
    host: HarnessHost,
    message: string,
    details: HarnessErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HarnessError';
    this.code = code;
    this.host = host;
    this.details = details;
  }
}

export function isHarnessError(err: unknown): err is HarnessError {
  return err instanceof HarnessError;
}

export function notSupported(host: HarnessHost, capability: string): HarnessError {
  return new HarnessError(
    'NOT_SUPPORTED',
    host,
    `${host} harness does not support ${capability}. See .forge/settings.yaml review_host_cli — review hosts are claude / codex / gemini (the second-opinion host must differ from the primary host); cursor does not support review.`,
    { capability },
  );
}
