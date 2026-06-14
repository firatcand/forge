import { z } from 'zod';

import { MODEL_TIERS } from './phases.ts';
import { CATALOG_HOSTS } from './models-catalog.ts';

const LinearTrackerConfigSchema = z.object({
  type: z.literal('linear'),
  config: z.object({ team_id: z.string() }),
});

const GithubTrackerConfigSchema = z.object({
  type: z.literal('github'),
  config: z.object({ repo: z.string() }),
});

const NotionTrackerConfigSchema = z.object({
  type: z.literal('notion'),
  config: z.object({
    database_id: z.string().min(1),
    /**
     * @deprecated FORGE-117 replaced the Notion MCP transport with the `ntn`
     * CLI (https://developers.notion.com/cli; auth via `ntn login`). The field
     * is ACCEPTED AND IGNORED so existing settings.yaml files keep parsing —
     * no default is emitted — and will be REMOVED in v0.5. The factory prints
     * a one-line deprecation warning when it is present.
     */
    mcp_command: z.array(z.string()).optional(),
    /**
     * @deprecated FORGE-117 — accepted and ignored (see mcp_command above);
     * removed in v0.6.
     */
    mcp_env: z.record(z.string(), z.string()).optional(),
  }),
});

export const TrackerConfigSchema = z.discriminatedUnion('type', [
  LinearTrackerConfigSchema,
  GithubTrackerConfigSchema,
  NotionTrackerConfigSchema,
]);

const EnvFileSecretsSchema = z.object({
  manager: z.literal('env_file'),
  env_file_path: z.string().default('./.env.local'),
});

const OnePasswordSecretsSchema = z.object({
  manager: z.literal('1password'),
  vault: z.string(),
});

const AwsSecretsSchema = z.object({
  manager: z.literal('aws_secrets'),
  region: z.string(),
  prefix: z.string().optional(),
});

const DopplerSecretsSchema = z.object({
  manager: z.literal('doppler'),
  project: z.string(),
  config: z.string(),
});

const InfisicalSecretsSchema = z.object({
  manager: z.literal('infisical'),
  workspace_id: z.string(),
  env: z.string(),
});

export const SecretsSchema = z.discriminatedUnion('manager', [
  EnvFileSecretsSchema,
  OnePasswordSecretsSchema,
  AwsSecretsSchema,
  DopplerSecretsSchema,
  InfisicalSecretsSchema,
]);

// FORGE-65: per-task question budget. `soft` warns; `hard` forces an autonomous
// decision. Both default (3 / 6 per spec/ORCHESTRATOR.md:936); `hard` must be
// >= `soft` or the soft warning would be unreachable. Exported so the per-task
// override in phases.yaml (TaskSchema.question_budget) can describe the same
// shape with optional members.
export const QuestionBudgetSchema = z
  .object({
    soft: z.number().int().positive().default(3),
    hard: z.number().int().positive().default(6),
  })
  .refine((b) => b.hard >= b.soft, {
    message: 'question_budget.hard must be >= question_budget.soft',
    path: ['hard'],
  })
  .default({});

export const AgentsSchema = z
  .object({
    max_concurrent: z.number().int().positive().default(10),
    retry_attempts: z.number().int().nonnegative().default(10),
    retry_backoff_ms_max: z.number().int().positive().default(300_000),
    poll_interval_ms: z.number().int().positive().default(30_000),
    worktree_root: z.string().default('./.forge/worktrees'),
    on_persistent_failure: z
      .enum(['notify', 'block_task', 'move_to_next'])
      .default('notify'),
    // FORGE-88 / FORGE-160: primary harnesses are claude / codex / gemini, plus
    // `cursor` as a BETA primary — gated behind `cursor_host_beta_opt_in: true`
    // via the refine below (the Cursor CLI is officially beta; the flag is the
    // honesty mechanism). cursor may appear in `enabled_root_files` WITHOUT the
    // opt-in (passive breadcrumb + farms); only primary dispatch is gated.
    primary_host_cli: z
      .enum(['claude', 'codex', 'gemini', 'cursor'])
      .default('claude'),
    // FORGE-160: opt-in for the beta Cursor CLI as the primary dispatch host.
    // Required to set primary_host_cli: cursor (see refine below).
    cursor_host_beta_opt_in: z.boolean().default(false),
    // FORGE-88: review hosts are codex / gemini. Claude is excluded as a
    // reviewer — second-opinion review requires a different model lineage
    // than the primary worker. `null` disables second-opinion review entirely.
    review_host_cli: z
      .enum(['codex', 'gemini'])
      .nullable()
      .default('codex'),
    // Paths a worker must call `forge orchestrate guardrail-check` against
    // before writing to. Patterns: `**`, `*`, literal — repo-relative,
    // anchored at both ends. See src/orchestrator/glob-match.ts.
    //
    // Default list mirrors spec/ORCHESTRATOR.md §Preflight wrapper —
    // touching any of these forces an architectural-question checkpoint
    // even when the worker's structured classifier returns `routine`.
    preflight_globs: z.array(z.string().min(1)).default([
      'src/index.ts',
      'src/schemas/**',
      'src/bin/**',
      'src/cli/**',
      'src/trackers/base.ts',
      // Note: src/cli/migrate.ts is omitted because src/cli/** already
      // covers it. First-hit-wins matching makes a more-specific literal
      // unreachable after a broader glob (code-reviewer on FORGE-97).
      'spec/**',
      'CRITICAL.md',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      'package.json',
      'phases.yaml',
    ]),
    // FORGE-170: files that must NOT be written by two concurrent attempts.
    // Consumed by src/orchestrator/overlap.ts for the claim-time hard-overlap
    // gate AND `phases --ready` classification. Undefined → DEFAULT_HARD_LOCK_GLOBS.
    hard_lock_globs: z.array(z.string().min(1)).optional(),
    // FORGE-152: which agent root files (CLAUDE.md / AGENTS.md / GEMINI.md)
    // the project writes. Enum values match primary_host_cli / review_host_cli
    // for schema consistency. Empty (absent or explicit []) is promoted to
    // [primary_host_cli] by the .transform() below — see
    // test/unit/settings.schema.test.ts for the contract.
    enabled_root_files: z
      .array(z.enum(['claude', 'codex', 'gemini', 'cursor']))
      .default([]),
    // FORGE-65: per-task ceiling on the TOTAL number of architectural questions
    // a single task may write across all its attempts (spec/ORCHESTRATOR.md:936).
    // soft → a warning is injected into the next attempt's worker prompt;
    // hard → the question verb forces an autonomous decision instead of writing.
    // This is the GLOBAL default; a task may override it via question_budget in
    // phases.yaml. Distinct from the per-decision_key respawn cap (max_attempts),
    // which is owned by FORGE-146.
    question_budget: QuestionBudgetSchema,
    // FORGE-85: soft-rotation threshold for the append-only JSONL logs
    // (events.jsonl, claim-history.jsonl). When a file's size reaches this many
    // bytes BEFORE an append, the writer renames `<file>` → `<file>.1` (single
    // generation, overwriting any prior `.1`) and starts fresh; readers merge
    // `.1` + current. Default 10 MiB. See src/orchestrator/jsonl-rotate.ts.
    log_rotate_max_bytes: z.number().int().positive().default(10_485_760),
    // FORGE-211: default capability floor for tasks that carry no `model_tier`
    // stamp. The AgentsSchema `.default({})` materializes this for free, so an
    // unstamped task in a pre-v0.5 phases.yaml resolves to 'standard'. The route
    // verb (FORGE-210) escalates above this floor (CRITICAL path / retry) but
    // never below it.
    default_model_tier: z.enum(MODEL_TIERS).default('standard'),
  })
  // FORGE-152 transform: promote empty enabled_root_files to [primary_host_cli].
  // Runs BEFORE refinements so the refined object sees the promoted value.
  // Empty (absent or explicit []) → degenerate config; one root file is the
  // minimum useful state.
  .transform((d) => {
    if (d.enabled_root_files.length === 0) {
      return { ...d, enabled_root_files: [d.primary_host_cli] };
    }
    return d;
  })
  // .refine() before .default({}) — the collision check must see the
  // resolved object after inner defaults expand.
  // /review I5: explicit `path` on refinement issues so tools that format
  // `{path}: {message}` show the offending field, not a bare message.
  .refine(
    (d) => d.review_host_cli === null || d.review_host_cli !== d.primary_host_cli,
    {
      message:
        'review_host_cli must differ from primary_host_cli (or be null to disable second-opinion review)',
      path: ['review_host_cli'],
    },
  )
  // FORGE-88: gemini harness is experimental — gate on FORGE_GEMINI_EXPERIMENTAL=1.
  // Read process.env at parse time, not at module load, so test harnesses can
  // toggle the env around safeParse() calls.
  .refine(
    (d) => {
      const usesGemini =
        d.primary_host_cli === 'gemini' || d.review_host_cli === 'gemini';
      if (!usesGemini) return true;
      return process.env.FORGE_GEMINI_EXPERIMENTAL === '1';
    },
    (d) => ({
      message:
        'gemini harness is experimental. Set FORGE_GEMINI_EXPERIMENTAL=1 to opt in. The gemini CLI is pre-1.0 and its headless surface may change.',
      // Attach the issue to whichever field selected gemini (or
      // primary_host_cli if both did) so the error path locates the fix.
      path: [
        d.primary_host_cli === 'gemini' ? 'primary_host_cli' : 'review_host_cli',
      ],
    }),
  )
  // FORGE-160: cursor as the PRIMARY dispatch host is beta-gated. The Cursor CLI
  // is officially beta ("security safeguards still evolving"); selecting it
  // without the opt-in flag is a parse error naming the flag + the caveat.
  // cursor in enabled_root_files (passive breadcrumb) is NOT gated.
  .refine(
    (d) => d.primary_host_cli !== 'cursor' || d.cursor_host_beta_opt_in === true,
    {
      message:
        'primary_host_cli: cursor requires agents.cursor_host_beta_opt_in: true — the Cursor CLI is beta (security safeguards still evolving). Set the flag to opt in.',
      path: ['primary_host_cli'],
    },
  )
  .default({});

const DesignSchema = z
  .object({
    mode: z.enum(['project_owned', 'reference_external']).default('project_owned'),
    reference: z.string().optional(),
  })
  .default({});

// FORGE-150: "everything is second-opinion, suggest is a mode" naming.
// auto_enabled is the disable lever consumed by `forge second-opinion suggest`.
// Mounted as `second_opinion` on SettingsSchema; replaces the old `codex` block
// as the primary surface.
const SecondOpinionSchema = z
  .object({
    auto_enabled: z.boolean().default(true),
  })
  .default({});

// FORGE-214: per-ticket /drive HITL knobs. Mounted as `drive` on
// SettingsSchema next to `second_opinion`, mirroring its `.default({})` pattern
// so a settings.yaml with no `drive:` block still yields full defaults.
//
// R1: there is NO `review_threshold` knob. forge's ReviewVerdict
// (src/schemas/verdict.ts) emits only `verdict: pass|changes_requested` +
// `findings[].severity: block|improvement` — there are no numeric axis scores,
// so a numeric threshold would gate nothing. /drive's review gate is therefore
// `verdict === 'pass'` AND zero `block` findings (from BOTH the primary /review
// and the cross-review second-opinion). A future ticket could add numeric
// scoring to ReviewVerdict + the harness + the parser; do not assume it here.
const DriveSchema = z
  .object({
    // Max review↔fix rounds before escalating to a human (park to /inbox).
    review_loop_cap: z.number().int().positive().default(4),
    // auto = merge on green CI; approval = open PR and park for a human merge.
    merge_policy: z.enum(['auto', 'approval']).default('auto'),
  })
  .default({});

// Added 2026-05-18 (FORGE-105 P2.5-T13) — closed-loop workflow control.
// auto_codex_enabled WAS the disable lever consumed by `forge codex-suggest`.
// FORGE-150 superseded it with second_opinion.auto_enabled (above). The block
// is now OPTIONAL WITHOUT a default — it materializes only when present in the
// file, so a fresh parse exposes `second_opinion` but NOT `codex`. Legacy
// settings.yaml files that still carry it are honored by the resolver
// (codex-suggest.ts) for back-compat; block removal is v0.5.
// Decision A (FORGE-124): the token-cap field was dropped — passive suggestions
// bound nothing meaningful; budget enforcement deferred indefinitely.
// Legacy settings.yaml files that still carry the stale key are silently
// stripped by zod (CodexSchema has no .strict() — unknown keys are ignored).
const CodexSchema = z
  .object({
    auto_codex_enabled: z.boolean().default(true),
  })
  .optional();

// Added 2026-05-18 (FORGE-105) — declared per SPEC §Settings schema for
// adopter forward-compat. Consumers land with the /update-spec skill (separate
// ticket); no code in this PR reads decisions.* yet.
const DecisionsSchema = z
  .object({
    decision_dir: z.string().default('./spec/decisions'),
    stale_draft_threshold_days: z.number().int().positive().default(7),
  })
  .default({});

// Added 2026-05-18 (FORGE-105) — declared per SPEC §Settings schema for
// adopter forward-compat. Consumer lands with the `forge doctor` verb
// (separate ticket); no code in this PR reads doctor.* yet.
const DoctorSchema = z
  .object({
    spec_code_check_enabled: z.boolean().default(true),
    // FORGE-131: adopter-declared symbols treated as legitimate SPEC prose by
    // the doctor symbol-mention check (merged with the built-in
    // BASE_SYMBOL_ALLOWLIST). Use this for project-specific external library /
    // product names that look code-shaped but are not source symbols.
    symbol_allowlist: z.array(z.string().min(1)).default([]),
  })
  .default({});

// FORGE-168: adopter-declared verification commands. Each entry is a shell
// command string run via `shell: true` in the repo root with the FULL
// environment (src/orchestrator/verify-runner.ts) — these are the adopter's own
// trusted test/lint commands, unlike the AI-subprocess path (src/harnesses/
// subprocess.ts) which strips env to a safe allowlist to avoid leaking secrets
// to an external model API. Do NOT "harden" this onto that allowlist: real
// integration tests need NODE_ENV / DB creds.
//
// OPTIONAL on SettingsSchema: unset ⇒ verification is skipped with a warning.
// A PRESENT block must declare ≥1 non-empty command — an empty block is a
// misconfiguration, not a silent skip (so `undefined` is the only skip signal).
const VerifySchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
});

// FORGE-212: the model-catalog knobs. Mirrors DriveSchema's `.default({})`
// pattern so a settings.yaml with no `models:` block still yields full defaults.
//
// R1: `pinned[host]` is a per-host ALLOW-LIST FILTER over the cached catalog —
// NOT a replacement. Set for a host, it restricts the router to ONLY those
// cached model ids for that host; tiers/sources stay authoritative in the cache
// (no re-specifying the catalog in settings — that maintenance burden is exactly
// what 212 exists to avoid). The pure `applyPins` helper in
// src/cli/orchestrate/models.ts implements the filter; the router (210) reuses
// it. A host with no pin → unchanged; an unknown pinned id → dropped + warned.
//
// `ttl_days` is the staleness threshold: the `models` read path nudges (stderr,
// FORGE_QUIET-suppressible) when the cache's refreshed_at is older than this.
const ModelsSchema = z
  .object({
    pinned: z.record(z.enum(CATALOG_HOSTS), z.array(z.string().min(1))).optional(),
    ttl_days: z.number().int().positive().default(14),
  })
  .default({});

export const SettingsSchema = z.object({
  version: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  tracker: TrackerConfigSchema,
  secrets: SecretsSchema,
  agents: AgentsSchema,
  design: DesignSchema,
  // FORGE-150: primary disable surface for in-skill second-opinion suggestions.
  second_opinion: SecondOpinionSchema,
  // FORGE-214: per-ticket /drive HITL knobs (review loop cap + merge policy).
  drive: DriveSchema,
  // FORGE-150: legacy block — optional, no default. Honored by the resolver for
  // back-compat; removed in v0.6.
  codex: CodexSchema,
  decisions: DecisionsSchema,
  doctor: DoctorSchema,
  // FORGE-212: model-catalog knobs (per-host pin allow-list + staleness TTL).
  models: ModelsSchema,
  // FORGE-150: tracked methodology-version pin (FORGE-161). Absent ⇒ no warning
  // (pre-pin repos stay quiet); stamped by `forge upgrade`.
  methodology_version: z.string().min(1).optional(),
  // FORGE-168: optional — unset ⇒ skip verification with a warning.
  verify: VerifySchema.optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Verify = z.infer<typeof VerifySchema>;
export type Drive = z.infer<typeof DriveSchema>;
export type Models = z.infer<typeof ModelsSchema>;

export type LinearTrackerConfig = z.infer<typeof LinearTrackerConfigSchema>;
export type GithubTrackerConfig = z.infer<typeof GithubTrackerConfigSchema>;
export type NotionTrackerConfig = z.infer<typeof NotionTrackerConfigSchema>;
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

export type EnvFileSecrets = z.infer<typeof EnvFileSecretsSchema>;
export type OnePasswordSecrets = z.infer<typeof OnePasswordSecretsSchema>;
export type AwsSecrets = z.infer<typeof AwsSecretsSchema>;
export type DopplerSecrets = z.infer<typeof DopplerSecretsSchema>;
export type InfisicalSecrets = z.infer<typeof InfisicalSecretsSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;
