export type WorkspaceErrorCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'LEADING_DASH'
  | 'PATH_TRAVERSAL'
  | 'CONTROL_CHAR'
  | 'INVALID_CHAR'
  | 'PATH_ESCAPE'
  | 'NOT_FOUND'
  | 'GIT_FAILURE'
  | 'GITIGNORED_LOSS'
  | 'SYMLINK_REJECTED';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
  }
}

export type SettingsErrorCode =
  | 'FILE_NOT_FOUND'
  | 'YAML_PARSE_ERROR'
  | 'VALIDATION_ERROR'
  | 'IO_ERROR';

export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: SettingsErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}

export type PhasesErrorCode =
  | 'FILE_NOT_FOUND'
  | 'READ_FAILED'
  | 'PARSE_ERROR'
  | 'SCHEMA_INVALID';

export class PhasesError extends Error {
  readonly code: PhasesErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: PhasesErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PhasesError';
    this.code = code;
    this.details = details;
  }
}
