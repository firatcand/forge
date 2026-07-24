import { z } from 'zod';

import { byteBoundedString } from './byte-bounded.ts';

export const VerdictSchema = z.object({
  version: z.literal(1),
  verdict: z.enum(['ready_for_review', 'changes_needed', 'blocked']),
  summary: byteBoundedString(4_000, { min: 1 }),
  tests: z.object({
    ran: z.boolean(),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    output_excerpt: byteBoundedString(2048),
  }),
  lint: z.object({
    ran: z.boolean(),
    clean: z.boolean(),
    violations: z.number().int().min(0),
    output_excerpt: byteBoundedString(2048),
  }),
  branch: z.string().min(1).max(200),
  save_point: byteBoundedString(8_000),
  // FORGE-231: the pinned SHA a composed machine verdict speaks for. Optional
  // on the generic carrier (interactive flows are unpinned); the orchestrated
  // REVIEW gate requires it and verifies the full equality chain — see
  // complete's pinned-review gate.
  target_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

// FORGE-234: the SHIP completion carrier — same shape as the generic worker
// verdict but target_sha is REQUIRED (mirror of the review-phase pinned
// split). ALL ship outcomes (success and budgeted failure) must name the SHA
// they speak for; complete verifies the manifest/record equality chain.
export const PinnedShipVerdictSchema = VerdictSchema.extend({
  target_sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type PinnedShipVerdict = z.infer<typeof PinnedShipVerdictSchema>;

export const ReviewVerdictSchema = z.object({
  version: z.literal(1),
  verdict: z.enum(['pass', 'changes_requested']),
  findings: z.array(
    z.object({
      severity: z.enum(['block', 'improvement']),
      path: z.string().min(1).max(500),
      line: z.number().int().min(1).optional(),
      message: byteBoundedString(2_000, { min: 1 }),
    }),
  ),
  // FORGE-88: second-opinion review verdicts come from a review host.
  // FORGE-187 (R2): `claude` is a legal host so the in-session PRIMARY review
  // (the code-reviewer subagent under the subscription) can stamp its own
  // provenance on the verdict file fed to `review-compose`.
  // FORGE-224: review hosts are claude | codex | gemini — the `second-opinion`
  // verb now also dispatches claude (ClaudeHarness.runReview via `claude -p`).
  // The dual-lineage gate is enforced by review-compose's same-host check (the
  // second host must differ from the primary review host). cursor was never
  // wired up for review.
  host: z.enum(['codex', 'gemini', 'claude']),
  // FORGE-231: the exact commit the review looked at. OPTIONAL here so the
  // globally-shared schema keeps working for interactive second-opinion /
  // harness flows; the ORCHESTRATED review path parses with
  // PinnedReviewVerdictSchema below, where it is REQUIRED.
  target_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

// FORGE-231: orchestrated REVIEW verdicts must be PINNED — the raw file is the
// provenance + pin witness the completion gate verifies (host + target_sha
// against the dispatch-time manifest and the live worktree HEAD).
export const PinnedReviewVerdictSchema = ReviewVerdictSchema.extend({
  target_sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type PinnedReviewVerdict = z.infer<typeof PinnedReviewVerdictSchema>;
