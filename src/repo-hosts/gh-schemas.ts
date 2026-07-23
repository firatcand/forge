// FORGE-232: zod schemas for every gh / GitHub API payload the adapter
// consumes. Every boundary is validated — malformed host output becomes a
// typed RepoHostError('schema'|'transport'), never a silent participant
// (src/repo-hosts/types.ts contract).

import { z } from 'zod';

export const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

// ─── gh repo view --json ─────────────────────────────────────────────────────

export const GhRepoViewSchema = z.object({
  nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  isFork: z.boolean(),
  parent: z.object({ nameWithOwner: z.string() }).nullable().optional(),
  squashMergeAllowed: z.boolean().optional(),
  viewerPermission: z.enum(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']).optional(),
  viewerCanAdminister: z.boolean().optional(),
});
export type GhRepoView = z.infer<typeof GhRepoViewSchema>;

// ─── GET /repos/{repo}/rules/branches/{branch} (effective ruleset rules) ─────

export const GhBranchRuleSchema = z
  .object({
    type: z.string(),
    ruleset_id: z.number().int().optional(),
    // 'Repository' | 'Organization' | ... — used to fetch ruleset detail from
    // the right scope; unknown sources fail closed at composition time.
    ruleset_source_type: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type GhBranchRule = z.infer<typeof GhBranchRuleSchema>;

export const GhBranchRulesSchema = z.array(GhBranchRuleSchema);

// required_status_checks rule parameters (the shape we consume).
export const GhRequiredChecksParamsSchema = z.object({
  required_status_checks: z.array(z.object({ context: z.string() })).optional(),
});

// ─── GET /repos/{repo}/rulesets/{id} (per-ruleset detail) ────────────────────

// bypass_actors must be EXPLICITLY PRESENT to prove anything; the schema keeps
// it optional so the ABSENCE is observable to the probe (absence = cannot
// prove empty = fail closed, R1 #1).
export const GhRulesetDetailSchema = z
  .object({
    id: z.number().int(),
    bypass_actors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type GhRulesetDetail = z.infer<typeof GhRulesetDetailSchema>;

// ─── GET /repos/{repo}/branches/{branch}/protection (classic) ────────────────

export const GhClassicProtectionSchema = z
  .object({
    required_status_checks: z
      .object({
        contexts: z.array(z.string()).optional(),
        checks: z.array(z.object({ context: z.string() })).optional(),
      })
      .nullable()
      .optional(),
    enforce_admins: z.object({ enabled: z.boolean() }).nullable().optional(),
  })
  .passthrough();
export type GhClassicProtection = z.infer<typeof GhClassicProtectionSchema>;

// ─── GraphQL PR observation (single query: enrollment + merge proof) ─────────

export const GraphqlPrObservationSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z
        .object({
          id: z.string().min(1),
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          mergedAt: z.string().nullable(),
          headRefOid: z.string(),
          baseRefName: z.string(),
          mergeCommit: z.object({ oid: z.string() }).nullable(),
          autoMergeRequest: z.object({ enabledAt: z.string().nullable() }).nullable(),
          isInMergeQueue: z.boolean(),
          mergeQueueEntry: z.object({ id: z.string(), state: z.string() }).nullable(),
        })
        .nullable(),
    }),
  }),
});
export type GraphqlPrObservation = z.infer<typeof GraphqlPrObservationSchema>;

// ─── REST pulls list (createOrGetPullRequest reconciliation) ─────────────────

export const GhRestPullSchema = z
  .object({
    number: z.number().int().positive(),
    state: z.enum(['open', 'closed']),
    html_url: z.string().url(),
    body: z.string().nullable(),
    merged_at: z.string().nullable().optional(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  })
  .passthrough();
export type GhRestPull = z.infer<typeof GhRestPullSchema>;

// `gh api --paginate --slurp` emits ONE array of page-arrays.
export const GhRestPullPagesSchema = z.array(z.array(GhRestPullSchema));

// ─── gh pr checks --json ─────────────────────────────────────────────────────

export const GhPrCheckSchema = z
  .object({
    name: z.string(),
    bucket: z.string(),
  })
  .passthrough();
export const GhPrChecksSchema = z.array(GhPrCheckSchema);
