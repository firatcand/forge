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

// FORGE-208: thrown by src/core/fs-atomic.ts writeAtomic when the write target
// is a symbolic link. rename(2) over a symlink replaces the LINK itself (not
// the target), silently destroying e.g. a CLAUDE.md → AGENTS.md parity link and
// materializing a divergent regular file. Mirrors WorkspaceError house style
// (which has the SYMLINK_REJECTED precedent).
export type FsWriteErrorCode = 'SYMLINK_TARGET_REFUSED';

export class FsWriteError extends Error {
  readonly code: FsWriteErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: FsWriteErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FsWriteError';
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

// `forge orchestrate apply-decision` (FORGE-95) domain errors. Verb-level
// failures (bad flags) use the envelope `fail()` with string codes directly;
// these are thrown by the adr/apply modules and mapped to envelopes by the verb.
export type ApplyErrorCode =
  | 'ADR_NOT_FOUND'            // no spec/decisions file matching the slug
  | 'ADR_AMBIGUOUS'           // more than one decisions file matches the slug
  | 'ADR_PARSE_ERROR'         // missing/!malformed frontmatter fence or invalid YAML
  | 'ADR_NOT_ACCEPTED'        // frontmatter status != 'accepted'
  | 'MISSING_JOURNAL'         // no payload-complete journal for the slug
  | 'JOURNAL_PARSE_ERROR'     // journal file is not valid JSON
  | 'JOURNAL_INVALID'         // journal failed schema validation
  | 'JOURNAL_COVERAGE_MISMATCH' // an ADR affected_* ref has no covering journal entry
  | 'TRACKER_INCAPABLE'       // tracker cannot updateIssueBody (e.g. Notion pre-FORGE-117)
  | 'SECTION_NOT_FOUND'       // a SPEC/PRD section anchor matched no heading
  | 'PHASES_TASK_NOT_FOUND'   // a phases_tasks entry id matched no task in phases.yaml
  | 'IO_ERROR';

export class ApplyError extends Error {
  readonly code: ApplyErrorCode;
  readonly details: Record<string, unknown>;
  readonly retriable: boolean;

  constructor(
    code: ApplyErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown; retriable?: boolean },
  ) {
    super(message, options);
    this.name = 'ApplyError';
    this.code = code;
    this.details = details;
    this.retriable = options?.retriable ?? false;
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
