// Typed errors for the question channel I/O surface.
//
// We use a dedicated error class (not the generic Error) so callers can
// branch on the typed `code` discriminant rather than parsing message
// strings. The code set is closed and matches the failure modes documented
// in spec/ORCHESTRATOR.md §"File semantics" plus the TOCTOU class flagged
// in docs/learnings/2026-Q2/toctou-between-stat-and-read-leaks-raw-fs-errors.md
// (IS_DIRECTORY is intentionally distinct from IO_ERROR so the explicit
// "path is a directory" regression test can assert on it).

export type QuestionChannelErrorCode =
  | 'DUPLICATE_ID' // question or answer file already exists for this id
  | 'OVERSIZED' // file exceeds QUESTION_FILE_MAX_BYTES
  | 'SCHEMA_INVALID' // zod parse failed or JSON is malformed
  | 'NOT_FOUND' // question or answer file does not exist
  | 'IO_ERROR' // EACCES or any unexpected fs error
  | 'IS_DIRECTORY'; // path resolved to a directory (TOCTOU class — explicit)

export interface QuestionChannelErrorDetails {
  readonly path?: string;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
}

export class QuestionChannelError extends Error {
  readonly code: QuestionChannelErrorCode;
  readonly details: QuestionChannelErrorDetails;

  constructor(
    code: QuestionChannelErrorCode,
    message: string,
    details: QuestionChannelErrorDetails = {},
  ) {
    super(message);
    this.name = 'QuestionChannelError';
    this.code = code;
    this.details = details;
  }
}

export function isQuestionChannelError(
  err: unknown,
): err is QuestionChannelError {
  return err instanceof QuestionChannelError;
}

// Type-guard helper for Node fs errors. The Node typings give us `unknown`
// for the catch parameter under strict mode; this narrows to the shape we
// use when mapping errno codes to QuestionChannelErrorCode.
export function isNodeFsError(
  err: unknown,
): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}
