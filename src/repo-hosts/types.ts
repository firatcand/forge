// FORGE-231: RepoHost result types (spec/ORCHESTRATOR.md §RepoHost).
// PR operations live on this seam, NOT on Tracker — the tracker (Linear /
// Notion / GitHub Issues) is orthogonal to where the code is hosted.
//
// Every result is a zod schema + inferred type so FakeRepoHost (tests) and
// GitHubRepoHost (FORGE-232) validate IDENTICALLY, and every SHA that could
// participate in drift detection or merge proof is validated lowercase 40-hex
// AT THE ADAPTER BOUNDARY — invalid host output becomes a typed
// transport-shaped failure, never a silent participant.

import { z } from 'zod';
import { PullRequestRefSchema } from '../schemas/ship-record.ts';

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const RepoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export { PullRequestRefSchema };
export type { PullRequestRef } from '../schemas/ship-record.ts';

export const BaseResolutionSchema = z.object({
  repo: RepoName,
  // canonical branch name (e.g. 'main') — never remote-qualified, never a SHA.
  branch: z.string().min(1).max(200),
  push_remote: z.string().min(1).max(200),
});
export type BaseResolution = z.infer<typeof BaseResolutionSchema>;

// The HONESTY PROBE report of EFFECTIVE repository rules. merge_queue_enabled
// is modeled here because merge-queue bases are UNSUPPORTED for
// ship.merge_policy 'auto' (owner decision MQ) — FORGE-232's probe detects it
// and the ship path parks fail-closed.
export const ProbeReportSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    blocking_check_count: z.number().int().min(0),
    squash_allowed: z.boolean(),
    write_permission: z.boolean(),
    bypass_rules_present: z.boolean(),
    merge_queue_enabled: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['auth', 'not_found', 'transport', 'unsupported_host']),
    detail: z.string().max(2000),
  }),
]);
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

export const ChecksResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('green') }),
  z.object({ status: z.literal('pending'), pending_count: z.number().int().min(0) }),
  z.object({
    status: z.literal('red'),
    failing_count: z.number().int().min(0),
    // FORGE-235: the adapter already reads names + buckets; surfacing them
    // lets ci_red_reported carry an actionable payload. Additive + bounded —
    // scripts without it still validate.
    failing: z.array(z.object({ name: z.string().max(200), bucket: z.string().max(40) })).max(20).optional(),
  }),
  z.object({ status: z.literal('unknown'), reason: z.string().max(2000) }),
]);
export type ChecksResult = z.infer<typeof ChecksResultSchema>;

// The ONLY merge proof: a platform-confirmed merged state. The local ship
// record never implies shipped (its merge_attempt enum has no 'merged').
export const MergeResultSchema = z.discriminatedUnion('merged', [
  z.object({
    merged: z.literal(true),
    base_ref: z.string().min(1).max(200),
    merge_commit_sha: Sha,
    merged_head_sha: Sha,
  }),
  z.object({
    merged: z.literal(false),
    state: z.enum(['open', 'closed_unmerged', 'unknown']),
    reason: z.string().max(2000).optional(),
  }),
]);
export type MergeResult = z.infer<typeof MergeResultSchema>;

// FORGE-232 additive reason extensions (pre-consumer; FakeRepoHost validates
// through this same schema): 'tainted_merge' = the PR merged but with a head
// OTHER than the pinned expected SHA (detail carries both SHAs — the consumer
// enters tainted-merge handling, never `shipped`); 'pr_closed' = the PR is
// closed-unmerged or missing (spec's closed-without-merge parking rule needs a
// signal distinguishable from head_drift, which would re-dispatch review).
export const MergeAttemptOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), merge_commit_sha: Sha }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'head_drift',
      'checks_not_green',
      'protection_rejected',
      'transport',
      'unsupported',
      'tainted_merge',
      'pr_closed',
    ]),
    detail: z.string().max(2000),
  }),
]);
export type MergeAttemptOutcome = z.infer<typeof MergeAttemptOutcomeSchema>;

export const HeadShaResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sha: Sha }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no_head', 'closed', 'not_found', 'auth', 'transport']),
  }),
]);
export type HeadShaResult = z.infer<typeof HeadShaResultSchema>;
