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
});

export type Verdict = z.infer<typeof VerdictSchema>;

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
  // FORGE-88: second-opinion review verdicts come from codex or gemini.
  // FORGE-187 (R2): `claude` is now a legal host so the in-session PRIMARY
  // review (the code-reviewer subagent under the subscription) can stamp its
  // own provenance on the verdict file fed to `review-compose`. The
  // `second-opinion` verb still only ever emits codex|gemini — `claude` is for
  // the primary review only. cursor was never wired up.
  host: z.enum(['codex', 'gemini', 'claude']),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
