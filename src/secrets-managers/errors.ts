export type SecretsErrorCode =
  | 'NOT_FOUND'
  | 'MISCONFIGURED'
  | 'PARSE'
  | 'UNKNOWN';

export class SecretsError extends Error {
  readonly code: SecretsErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: SecretsErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SecretsError';
    this.code = code;
    this.details = details;
  }
}
