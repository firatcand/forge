import { z } from 'zod';

// Hard cap on question/answer file size when read from disk. Question/answer
// files are produced by host CLI subprocesses, which we treat as untrusted
// input — both because a compromised dependency could induce a worker to write
// crafted JSON and because the contents are reflected back into other workers'
// prompts (prompt-injection vector). 64KB is comfortable for human-readable
// architectural questions and tight enough to defeat large payloads.
export const QUESTION_FILE_MAX_BYTES = 64 * 1024;

export const DECISION_CATEGORIES = [
  'public_api',
  'scope',
  'naming',
  'deprecation',
  'error_semantics',
  'file_lifecycle',
  'other',
] as const;

export const DECISION_TYPES = ['routine', 'architectural'] as const;
export const REVERSIBILITIES = ['low', 'medium', 'high'] as const;
export const BLAST_RADII = ['local', 'module', 'project', 'external'] as const;
export const DEFAULT_ACTIONS = ['decide', 'ask'] as const;

export const DecisionClassificationSchema = z.object({
  decision_type: z.enum(DECISION_TYPES),
  category: z.enum(DECISION_CATEGORIES),
  reversibility: z.enum(REVERSIBILITIES),
  blast_radius: z.enum(BLAST_RADII),
  default_action: z.enum(DEFAULT_ACTIONS),
  reason: z.string().min(1).max(2_000),
});

export const QuestionOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
});

export const QUESTION_STATUSES = [
  'open',
  'answered',
  'expired',
  'budget_exhausted',
  'duplicate',
] as const;

export const QuestionSchema = z.object({
  version: z.literal(1),
  question_id: z.string().min(1).max(64),
  run_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  agent_id: z.string().min(1).max(64),
  decision_key: z.string().min(1).max(200),
  attempt: z.number().int().min(1).max(100),
  max_attempts: z.number().int().min(1).max(100),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  status: z.enum(QUESTION_STATUSES).default('open'),
  question: z.string().min(1).max(4_000),
  context: z.string().max(8_000).default(''),
  options: z.array(QuestionOptionSchema).min(2).max(10),
  recommended_option_id: z.string().min(1).max(64).optional(),
  what_happens_if_unanswered: z.string().max(2_000).optional(),
  classification: DecisionClassificationSchema,
});

export const AnswerSchema = z.object({
  version: z.literal(1),
  question_id: z.string().min(1).max(64),
  answered_at: z.string().datetime(),
  answered_by: z.string().min(1).max(120).default('supervisor'),
  option_id: z.string().min(1).max(64),
  note: z.string().max(4_000).optional(),
});

export type DecisionClassification = z.infer<typeof DecisionClassificationSchema>;
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export type DecisionType = (typeof DECISION_TYPES)[number];
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

// Cross-field invariant: the recommended_option_id (when present) must refer
// to an option that actually exists on the question. A typo here would silently
// degrade the supervisor experience, so we reject at the schema layer.
export const QuestionSchemaWithRecommendationCheck = QuestionSchema.refine(
  (q) => {
    if (q.recommended_option_id === undefined) return true;
    return q.options.some((opt) => opt.id === q.recommended_option_id);
  },
  {
    message: 'recommended_option_id must match the id of an option in options[]',
    path: ['recommended_option_id'],
  },
).refine(
  (q) => new Date(q.expires_at).getTime() > new Date(q.created_at).getTime(),
  {
    message: 'expires_at must be strictly after created_at',
    path: ['expires_at'],
  },
);
