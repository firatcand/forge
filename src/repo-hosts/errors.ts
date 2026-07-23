// FORGE-232: typed error family for the RepoHost seam (plan v3 §error family).
// Interface methods WITH failure unions return them; the union-less methods
// (resolveBase, createOrGetPullRequest) and internal helpers throw this class
// — mirrors the TrackerError convention, no OrchestratorErrorCode widening.

export type RepoHostErrorCode =
  | 'unsupported_host'
  | 'fork_topology'
  | 'pr_conflict'
  | 'record_missing'
  | 'binding_conflict'
  | 'transport'
  | 'schema';

export class RepoHostError extends Error {
  readonly code: RepoHostErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: RepoHostErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RepoHostError';
    this.code = code;
    this.details = details;
  }
}
