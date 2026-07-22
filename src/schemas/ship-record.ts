import { z } from 'zod';

// FORGE-231: the durable write-ahead record for orchestrator shipping
// (spec/ORCHESTRATOR.md §Ship record). Progressive population (owner decision
// CC): created at review-pass with the reviewed binding only; base at
// ship-dispatch write-ahead; pr at PR-creation write-ahead (FORGE-234 call
// sites — the schema + fenced writer land here). `merge_attempt` has NO
// 'merged' value on purpose: RepoHost.mergeResult() is the ONLY merge proof;
// the local record never implies shipped.
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const PullRequestRefSchema = z.object({
  // canonical "owner/name" — validated, never display-derived.
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive(),
  // display-only; never parsed for identity.
  url: z.string().url(),
});

export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

export const ShipRecordSchema = z
  .object({
    version: z.literal(1),
    task_id: z.string().min(1).max(64),
    // monotonic, +1 per fenced write; casGuardedWrite serializes on it.
    revision: z.number().int().min(1),
    reviewed_head_sha: Sha,
    review_attempt_id: z.string().min(1).max(64),
    base: z
      .object({
        repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        branch: z.string().min(1).max(200),
        push_remote: z.string().min(1).max(200),
      })
      .nullable(),
    pr: PullRequestRefSchema.nullable(),
    merge_attempt: z.enum(['not_started', 'attempting', 'submitted', 'failed']),
    updated_at: z.string().datetime(),
  })
  .refine((r) => r.pr === null || r.base !== null, {
    message: 'pr requires base',
    path: ['pr'],
  })
  .refine((r) => r.merge_attempt === 'not_started' || r.pr !== null, {
    message: 'merge_attempt beyond not_started requires pr',
    path: ['merge_attempt'],
  })
  // The durable record itself establishes "merged into the recorded base repo
  // + branch": a PR from a different repo can never bind to this record.
  .refine((r) => r.pr === null || r.base === null || r.pr.repo === r.base.repo, {
    message: 'pr.repo must equal base.repo',
    path: ['pr'],
  });

export type ShipRecord = z.infer<typeof ShipRecordSchema>;
