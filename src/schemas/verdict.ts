import { z } from 'zod';

export const VerdictSchema = z.object({
  version: z.literal(1),
  verdict: z.enum(['ready_for_review', 'changes_needed', 'blocked']),
  summary: z.string().min(1).max(4_000),
  tests: z.object({
    ran: z.boolean(),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    output_excerpt: z.string().max(2048),
  }),
  lint: z.object({
    ran: z.boolean(),
    clean: z.boolean(),
    violations: z.number().int().min(0),
    output_excerpt: z.string().max(2048),
  }),
  branch: z.string().min(1).max(200),
  save_point: z.string().max(8_000),
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
      message: z.string().min(1).max(2_000),
    }),
  ),
  host: z.enum(['claude', 'codex', 'cursor', 'gemini']),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
