import { z } from 'zod';

export const TASK_STATES = [
  'unclaimed',
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
  'ready_for_review',
  'reviewed',
  'merge_pending',
  'shipped',
  'abandoned',
  'cancelled',
  'failed',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = ['shipped', 'cancelled', 'failed'] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

export const FAILURE_REASONS = [
  'decision_key_budget',  // worker hit decision_key budget; should not auto-retry
  'retries_exhausted',    // attempt_count >= retry_attempts cap
  'fatal',                // schema / transition / deterministic non-transient error
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const TaskStateSchema = z
  .object({
    version: z.literal(1),
    task_id: z.string().min(1).max(64),
    state: z.enum(TASK_STATES),
    state_version: z.number().int().min(0),
    attempt_count: z.number().int().min(0),
    // FORGE-231: single TOTAL failure budget across phases (SPEC.md §retry
    // accounting). Increments on implement changes_needed, review
    // changes_requested/changes_needed, and ship failure; capped by
    // agents.retry_attempts. Initial successful dispatches consume nothing.
    failure_count: z.number().int().min(0).default(0),
    // Idempotency key of the last ACCOUNTED failure: "<attempt_id>:<phase>".
    // A replayed completion with the same key must not re-increment.
    last_failure_key: z.string().max(160).nullable().default(null),
    // Informational per-phase attempt numbering (NO caps — the budget above is
    // the only limiter). attempt_count keeps its existing implement meaning.
    review_attempt_count: z.number().int().min(0).default(0),
    ship_attempt_count: z.number().int().min(0).default(0),
    current_attempt_id: z.string().min(1).max(64).nullable(),
    failure_reason: z.enum(FAILURE_REASONS).optional(),
    last_failed_at: z.string().datetime().optional(),
    updated_at: z.string().datetime(),
    updated_by: z.object({
      run_id: z.string().min(1).max(64),
      claim_id: z.string().min(1).max(64),
      generation: z.number().int().min(0),
    }),
  })
  // Asymmetric invariant: failure_reason MUST imply state === 'failed', but
  // we do NOT require state === 'failed' to carry a failure_reason. This is
  // the migration-safe choice (Codex 3rd-pass CONSIDER 3): adopter state.json
  // files written by callers that pre-date the failure_reason discriminator
  // (e.g., a manual `running:retries_exhausted → failed` transition without
  // a producer) continue to parse. New callers that want decision-key vs
  // retries-exhausted vs fatal differentiation set failure_reason; readers
  // that need it can default to 'fatal' when absent on a failed state.
  .refine(
    (s) => s.failure_reason === undefined || s.state === 'failed',
    {
      message: "failure_reason is only permitted when state === 'failed'",
      path: ['failure_reason'],
    },
  );

export type TaskStateRecord = z.infer<typeof TaskStateSchema>;

export const ATTEMPT_STATES = [
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
  'finalized',
  'abandoned',
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const TERMINAL_ATTEMPT_STATES = ['finalized', 'abandoned'] as const;
export type TerminalAttemptState = (typeof TERMINAL_ATTEMPT_STATES)[number];

export const AttemptStateSchema = z.object({
  version: z.literal(1),
  attempt_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  claim_id: z.string().min(1).max(64),
  generation: z.number().int().min(0),
  state: z.enum(ATTEMPT_STATES),
  dispatched_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type AttemptStateRecord = z.infer<typeof AttemptStateSchema>;
