export type TrackerErrorCode =
  | 'AUTH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PRECONDITION_FAILED'
  | 'VALIDATION'
  | 'TRANSPORT'
  | 'TIMEOUT'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';

const RETRIABLE_CODES: ReadonlySet<TrackerErrorCode> = new Set([
  'RATE_LIMITED',
  'TRANSPORT',
  'TIMEOUT',
]);

export function isRetriableTrackerErrorCode(code: TrackerErrorCode): boolean {
  return RETRIABLE_CODES.has(code);
}

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: TrackerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TrackerError';
    this.code = code;
    this.details = details;
  }
}
