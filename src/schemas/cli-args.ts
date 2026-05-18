import { z } from 'zod';

// CLI argument validation schemas, one per `forge orchestrate` verb.
// Each verb file imports its schema; parses the parsed-flag bundle through it
// before touching disk or tracker. Centralizing here makes the input surface
// auditable (count: 17 verbs across 2 bands) and keeps validator wording
// consistent.

// ── Shared primitives ────────────────────────────────────────────────────────

// Task IDs follow tracker conventions: prefix letters + hyphen + digits.
// Linear/GitHub: FORGE-96, ABC-1234. Notion: same shape via tracker-id.
export const TaskIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z][A-Z0-9]*-\d+$/, 'task_id must match /^[A-Z][A-Z0-9]*-\\d+$/');

// UUIDv7 string: 36 chars, version nibble == 7.
// Zod's built-in .uuid() does not pin a version, so use a regex.
const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RunIdSchema = z
  .string()
  .regex(UUIDV7_REGEX, 'run_id must be a UUIDv7');
export const ClaimIdSchema = z
  .string()
  .regex(UUIDV7_REGEX, 'claim_id must be a UUIDv7');
export const AttemptIdSchema = z
  .string()
  .regex(UUIDV7_REGEX, 'attempt_id must be a UUIDv7');
export const QuestionIdSchema = z
  .string()
  .regex(UUIDV7_REGEX, 'question_id must be a UUIDv7');

// Decision keys are author-chosen short identifiers used for dedup across
// concurrent worker attempts. spec §Question lifecycle.
export const DecisionKeySchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._:-]*[a-z0-9]$/, 'decision_key uses lowercase a-z0-9 . _ : -');

export const PhaseSchema = z.enum(['implement', 'review', 'ship']);

// Routing-hint values are restricted to the spec'd set.
export const RoutingHintSchema = z.enum(['apply-decision', 'amend-roadmap']);

// Event type is open-string at the schema level — workers can append any
// type — but spec §Event types names the v0.4 set; verbs MAY tighten.
export const EventTypeSchema = z.string().min(1).max(64);

// Common --json flag.
const JsonFlag = z.boolean().default(false);

// Common --forge-dir override (defaults to <cwd>/.forge resolved by callers).
const ForgeDirField = z.string().min(1);

// ── Verb-specific schemas ────────────────────────────────────────────────────

export const PhasesArgsSchema = z.object({
  ready: z.boolean().default(false),
  phase: PhaseSchema.optional(),
  blockedBy: TaskIdSchema.optional(),
  limit: z.number().int().positive().optional(),
  runId: RunIdSchema.optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type PhasesArgs = z.infer<typeof PhasesArgsSchema>;

// scope: v0.4 ships only 'spec-code' (file-path drift). 'all' is reserved as
// an alias for 'spec-code' until v0.5 adds further check types. The dropped
// values 'adr-drafts' and 'apply-journal' were scoped out of v0.4 per
// spec/SPEC.md §21 (architectural pivot 2026-05-17 PM); doctor.ts pre-parses
// for those legacy values and emits a custom INVALID_ARGS pointing adopters
// at v0.5 before Zod's generic enum error fires.
export const DoctorArgsSchema = z.object({
  scope: z.enum(['spec-code', 'all']).default('spec-code'),
  forgeDir: ForgeDirField,
  json: JsonFlag,
  repoRoot: z.string().min(1).optional(),
});
export type DoctorArgs = z.infer<typeof DoctorArgsSchema>;

export const RunStartArgsSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type RunStartArgs = z.infer<typeof RunStartArgsSchema>;

export const RunListArgsSchema = z.object({
  active: z.boolean().default(false),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type RunListArgs = z.infer<typeof RunListArgsSchema>;

export const ClaimArgsSchema = z.object({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type ClaimArgs = z.infer<typeof ClaimArgsSchema>;

export const DispatchArgsSchema = z.object({
  taskId: TaskIdSchema,
  claimId: ClaimIdSchema,
  runId: RunIdSchema,
  worktreePath: z.string().min(1),
  phase: PhaseSchema.default('implement'),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type DispatchArgs = z.infer<typeof DispatchArgsSchema>;

export const HeartbeatArgsSchema = z.object({
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type HeartbeatArgs = z.infer<typeof HeartbeatArgsSchema>;

export const QuestionWriteArgsSchema = z.object({
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  decisionKey: DecisionKeySchema,
  question: z.string().min(1).max(8_192),
  optionsFile: z.string().min(1).optional(),
  driftEventId: z.string().min(1).max(128).optional(),
  routingHint: RoutingHintSchema.optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type QuestionWriteArgs = z.infer<typeof QuestionWriteArgsSchema>;

export const EventArgsSchema = z.object({
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  type: EventTypeSchema,
  data: z.record(z.unknown()).optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type EventArgs = z.infer<typeof EventArgsSchema>;

export const CompleteArgsSchema = z.object({
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  verdictFile: z.string().min(1),
  phase: PhaseSchema.default('implement'),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type CompleteArgs = z.infer<typeof CompleteArgsSchema>;

export const CancelArgsSchema = z.object({
  taskId: TaskIdSchema,
  reason: z.string().min(1).max(2_048).optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type CancelArgs = z.infer<typeof CancelArgsSchema>;

// `forge orchestrate questions` — list worker questions.
// `--open` filters to status='open'; `--run <id>` further filters to a single
// run (required by the dispatch skill so /forge orchestrate doesn't surface
// questions from sibling concurrent runs).
export const QuestionsArgsSchema = z.object({
  open: z.boolean().default(false),
  runId: RunIdSchema.optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type QuestionsArgs = z.infer<typeof QuestionsArgsSchema>;

// `forge orchestrate ensure-worktree` — idempotent worktree create+hydrate.
// Owns `.forge/worktrees/<id>/` per ORCHESTRATOR.md §80-98 (CLI-only).
// Wrapper around src/core/workspace.ts#create with idempotence: existing
// worktree with matching marker → no-op; conflicting marker → error.
export const EnsureWorktreeArgsSchema = z.object({
  taskId: TaskIdSchema,
  // base branch to fork the worktree from; defaults to origin/main inside the
  // verb (mirrors src/core/workspace.ts#create default).
  base: z.string().min(1).optional(),
  // optional branch name override; defaults to `feat/<task_id>` inside create().
  branch: z.string().min(1).optional(),
  // Repo root containing .git. If omitted, verb resolves from cwd via
  // git rev-parse --git-common-dir. Used as the worktree manager's root.
  repoRoot: z.string().min(1).optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type EnsureWorktreeArgs = z.infer<typeof EnsureWorktreeArgsSchema>;

// `forge orchestrate render-worker-prompt` — render the worker prompt for a
// given task+attempt. Read-only: sources WorkerPromptContext from manifest.json
// (run/worktree/phase), plans/phases.yaml (description/acceptance), CLAUDE.md
// or AGENTS.md (conventions), settings.yaml (host), and walks
// .forge/orchestrator/tasks/<t>/attempts/* for prior attempts + answered Qs.
export const RenderWorkerPromptArgsSchema = z.object({
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  forgeDir: ForgeDirField,
  // Optional repo-root override; defaults to <cwd> via git rev-parse.
  repoRoot: z.string().min(1).optional(),
  json: JsonFlag,
});
export type RenderWorkerPromptArgs = z.infer<typeof RenderWorkerPromptArgsSchema>;
