import { z } from 'zod';

const Ts = z.string().datetime();
const Id = z.string().min(1).max(64);

export const AttemptEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attempt_started'),
    ts: Ts,
    attempt_id: Id,
    run_id: Id,
    claim_id: Id,
    generation: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('worktree_inspected'),
    ts: Ts,
    head_sha: z.string().min(7).max(40),
    dirty: z.boolean(),
    conflicts: z.boolean(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    ts: Ts,
    lease_expires_at: Ts,
  }),
  z.object({
    type: z.literal('files_modified'),
    ts: Ts,
    files: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('tests_run'),
    ts: Ts,
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    output_excerpt: z.string().max(2048),
  }),
  z.object({
    type: z.literal('lint_run'),
    ts: Ts,
    clean: z.boolean(),
    violations: z.number().int().min(0),
    output_excerpt: z.string().max(2048),
  }),
  z.object({
    type: z.literal('commit'),
    ts: Ts,
    sha: z.string().min(7).max(40),
    message_excerpt: z.string().max(200),
  }),
  z.object({
    type: z.literal('question_written'),
    ts: Ts,
    question_id: Id,
    decision_key: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('answer_observed'),
    ts: Ts,
    question_id: Id,
  }),
  z.object({
    type: z.literal('attempt_completed'),
    ts: Ts,
    verdict: z.enum(['ready_for_review', 'changes_needed', 'blocked']),
  }),
  z.object({
    type: z.literal('attempt_cancelled'),
    ts: Ts,
    reason: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal('attempt_abandoned_by_steal'),
    ts: Ts,
    new_generation: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('lease_stolen'),
    ts: Ts,
    from_generation: z.number().int().min(0),
    to_generation: z.number().int().min(1),
  }),
]);

export type AttemptEvent = z.infer<typeof AttemptEventSchema>;
