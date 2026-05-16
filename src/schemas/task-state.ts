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
  'shipped',
  'abandoned',
  'cancelled',
  'failed',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = ['shipped', 'cancelled', 'failed'] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

export const TaskStateSchema = z.object({
  version: z.literal(1),
  task_id: z.string().min(1).max(64),
  state: z.enum(TASK_STATES),
  state_version: z.number().int().min(0),
  attempt_count: z.number().int().min(0),
  current_attempt_id: z.string().min(1).max(64).nullable(),
  updated_at: z.string().datetime(),
  updated_by: z.object({
    run_id: z.string().min(1).max(64),
    claim_id: z.string().min(1).max(64),
    generation: z.number().int().min(0),
  }),
});

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
