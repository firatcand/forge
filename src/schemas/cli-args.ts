import { z } from 'zod';

// CLI argument validation schemas, one per `forge orchestrate` verb.
// Each verb file imports its schema; parses the parsed-flag bundle through it
// before touching disk or tracker. Centralizing here makes the input surface
// auditable (count: 17 verbs across 2 bands) and keeps validator wording
// consistent.

// ── Shared primitives ────────────────────────────────────────────────────────

// Task IDs: the unified shape lives in ./task-id.ts (FORGE-130). Re-exported
// here so every verb schema below references the single source of truth.
// Widened from the old Linear-only `/^[A-Z][A-Z0-9]*-\d+$/`: phases ids
// (P2.5-T07), normalized GitHub ids (GH-42), lowercase, and UUIDs now pass.
export { TaskIdSchema } from './task-id.ts';
import { TaskIdSchema } from './task-id.ts';

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
  // FORGE-149: opt-in. When set with --json on --ready, surfaces auto-gc cheap
  // divergences as a `warnings` array in the result data. Omitted → byte-identical
  // legacy output. Optional (not defaulted) so existing call sites that omit it
  // keep type-checking and behave as `false`.
  includeWarnings: z.boolean().optional(),
});
export type PhasesArgs = z.infer<typeof PhasesArgsSchema>;

// scope: v0.4 ships only 'spec-code' (file-path drift). 'all' is reserved as
// an alias for 'spec-code' until v0.5 adds further check types. The dropped
// values 'adr-drafts' and 'apply-journal' were scoped out of v0.4 per
// spec/SPEC.md §21 (architectural pivot 2026-05-17 PM); doctor.ts pre-parses
// for those legacy values and emits a custom INVALID_ARGS pointing adopters
// at v0.5 before Zod's generic enum error fires.
//
// FORGE-205: 'docs' is a NEW opt-in scope — a read-only, NON-BLOCKING
// docs-coverage report over the working branch's diff. It runs ONLY under
// `--scope docs` (NOT folded into 'all', to preserve the all≡spec-code
// data-equality contract). `base` selects the diff base ref (docs scope only).
export const DoctorArgsSchema = z.object({
  scope: z.enum(['spec-code', 'all', 'docs', 'hosts']).default('spec-code'),
  forgeDir: ForgeDirField,
  json: JsonFlag,
  repoRoot: z.string().min(1).optional(),
  base: z.string().optional(),
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

// `forge orchestrate dashboard` (FORGE-90) — read-only cross-run cockpit.
// Aggregates active sessions, open questions, ready/blocked tasks, overlap
// warnings, and lease health across all of .forge/orchestrator/. No lease, no
// tracker mutation, no state write.
export const DashboardArgsSchema = z.object({
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type DashboardArgs = z.infer<typeof DashboardArgsSchema>;

export const ClaimArgsSchema = z.object({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  forgeDir: ForgeDirField,
  json: JsonFlag,
  // FORGE-170: bypass the claim-time overlap gate (hard-overlap refusal).
  // Optional (no default) so existing ClaimArgs constructors stay valid;
  // `!opts.force` treats undefined as "gate on".
  force: z.boolean().optional(),
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
  // FORGE-65: both REQUIRED on every written question (AC8), enforced by the
  // verb (runOrchestrateQuestionWrite) rather than the schema so readQuestion
  // can still parse legacy/in-flight question files that predate this rule.
  // Bounds mirror QuestionSchema (recommended_option_id / what_happens_if_unanswered).
  recommendedOptionId: z.string().min(1).max(64).optional(),
  whatHappensIfUnanswered: z.string().min(1).max(2_000).optional(),
  // FORGE-65: per-task budget override passed by the dispatcher (FORGE-98),
  // which reads question_budget from phases.yaml. Absent → the verb uses the
  // global default from settings.yaml agents.question_budget.
  questionBudgetSoft: z.number().int().positive().optional(),
  questionBudgetHard: z.number().int().positive().optional(),
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
  // FORGE-140: a RELATIVE repoRoot is resolved against `cwd` (below), not the
  // implicit process.cwd(), so it honors the dispatcher's injected cwd contract.
  repoRoot: z.string().min(1).optional(),
  // FORGE-140: the anchor a relative `repoRoot` (and the git-rev-parse fallback)
  // resolve against. The dispatcher injects this; defaults to process.cwd()
  // inside the verb when omitted (preserves prior behavior).
  cwd: z.string().min(1).optional(),
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

// `forge orchestrate second-opinion` (FORGE-89 / P2-T21) — dispatch a
// second-opinion review through the IHarness adapter keyed off
// settings.review_host_cli. The skill body (skills/second-opinion/SKILL.md)
// writes the diff + prompt to temp files and calls this verb; the verb is the
// sole boundary that knows about review_host_cli.
export const SecondOpinionArgsSchema = z.object({
  taskId: TaskIdSchema,
  // Path to a file containing the diff to review. Read by the verb.
  diffPath: z.string().min(1),
  // Path to a file containing the review prompt body. Read by the verb.
  promptPath: z.string().min(1),
  // Working directory the underlying subprocess runs in. Defaults inside
  // the verb to the worktree (resolved from forgeDir's parent).
  cwd: z.string().min(1).optional(),
  // Optional subprocess timeout override; defaults to harness default.
  timeoutMs: z.number().int().positive().optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type SecondOpinionArgs = z.infer<typeof SecondOpinionArgsSchema>;

// `forge orchestrate apply-decision` (FORGE-95 / P2.5-T04) — propagate an
// accepted ephemeral ADR across SPEC/PRD/phases.yaml/tracker via a resumable
// journal. The verb is the mechanical applier wrapped by `/update-spec --apply`
// (FORGE-93). `--adr <slug>` selects spec/decisions/<...>-<slug>.md; the journal
// (payload-complete) is read from .forge/orchestrator/global/update-spec-apply-
// journal/<slug>.json.
export const ApplyDecisionArgsSchema = z.object({
  // The ADR slug (kebab). Resolves the decision file + the journal filename.
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug uses lowercase a-z 0-9 and hyphens'),
  // Skip per-artifact confirmation (the skill prompts; the verb is non-interactive).
  yesAll: z.boolean().default(false),
  // Resume a partially-applied journal: skip applied entries, retry pending/failed.
  resume: z.boolean().default(false),
  // Show per-artifact diff without writing journal, mutations, or finalize.
  dryRun: z.boolean().default(false),
  // Repo root containing spec/ and plans/. Defaults to forgeDir's parent in the verb.
  repoRoot: z.string().min(1).optional(),
  forgeDir: ForgeDirField,
  json: JsonFlag,
});
export type ApplyDecisionArgs = z.infer<typeof ApplyDecisionArgsSchema>;
