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

export type OrchestratorErrorCode =
  | 'LEASE_EXISTS'          // lease.json already present; concurrent acquire lost
  | 'LEASE_STOLEN'          // caller's (claim_id, generation) does not match stored lease
  | 'LEASE_NOT_EXPIRED'     // steal attempted before expiry + grace period elapsed
  | 'LEASE_NOT_FOUND'       // lease.json absent when expected (e.g. heartbeat with no prior acquire)
  | 'LEASE_IDENTITY_MISMATCH'   // adminReleaseLeaseByIdentity: on-disk lease differs from expected identity
  | 'LEASE_STATE_NOT_TERMINAL'  // adminReleaseLeaseByIdentity row-14 guard: task state was not terminal at unlink time
  | 'ILLEGAL_TRANSITION'    // state machine rejected the requested (from, trigger, to) triple
  | 'STATE_NOT_FOUND'       // state.json absent for a given task_id
  | 'STATE_VERSION_CONFLICT' // new state_version !== current state_version + 1
  | 'SCHEMA_INVALID'        // zod parse failed or JSON is malformed
  | 'INVALID_ID'            // task_id / attempt_id failed segment validation
  | 'CLAIM_HISTORY_CORRUPT' // claim-history.jsonl is non-empty but contains no parseable entries
  | 'DECISION_KEY_EXHAUSTED' // worker question-channel budget for a decision_key hit; do not retry
  | 'IO_ERROR';             // unexpected filesystem error

export interface OrchestratorErrorDetails {
  readonly [key: string]: unknown;
}

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly details: OrchestratorErrorDetails;

  constructor(
    code: OrchestratorErrorCode,
    message: string,
    details: OrchestratorErrorDetails = {},
  ) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.details = details;
  }
}
