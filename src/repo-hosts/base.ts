// FORGE-231: the RepoHost interface (spec/ORCHESTRATOR.md §RepoHost — the
// operation names below follow the spec's exact-signature contract, including
// requiredChecksGreen). GitHubRepoHost implements it in FORGE-232; the ship
// verb (FORGE-234) and the dependency-merge gate (FORGE-233) consume it.

import type {
  BaseResolution,
  ChecksResult,
  HeadShaResult,
  MergeAttemptOutcome,
  MergeResult,
  ProbeReport,
  PullRequestRef,
} from './types.ts';

export interface RepoHost {
  /**
   * The PR base for THIS task. CONSUMES the persisted per-task frozen base
   * (worktree marker `base_branch`, owner decision SB) — never re-resolves the
   * default branch, so a global refresh can never retarget an existing task.
   */
  resolveBase(): Promise<BaseResolution>;

  /** Honesty probe of the EFFECTIVE repository rules (fail-closed consumers). */
  probe(): Promise<ProbeReport>;

  /**
   * Idempotent create-or-get. Both arguments are CANONICAL BRANCH NAMES —
   * never SHAs, never remote-qualified refs.
   */
  createOrGetPullRequest(head: string, base: string): Promise<PullRequestRef>;

  /** Aggregate state of the PR's REQUIRED checks. */
  requiredChecksGreen(pr: PullRequestRef): Promise<ChecksResult>;

  /**
   * Forge-executed ATOMIC merge: squash, server-side head pinning
   * (expectedHeadSha), no standing auto-merge enablement. The method is fixed
   * to squash and there is NO bypass parameter BY CONSTRUCTION — a caller
   * cannot express an admin override through this seam.
   */
  mergeAtomic(pr: PullRequestRef, expectedHeadSha: string): Promise<MergeAttemptOutcome>;

  /** The ONLY merge proof (platform-confirmed). */
  mergeResult(pr: PullRequestRef): Promise<MergeResult>;

  headSha(pr: PullRequestRef): Promise<HeadShaResult>;
}
