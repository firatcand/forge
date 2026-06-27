import { z } from 'zod';

import { ESTIMATES } from './phases.ts';
import { HOSTS, REVIEW_HOSTS } from './hosts.ts';

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

// FORGE-202 (Tripwire I1): report-only injection-scanner mode selector. `mark` =
// deterministic detection runs and is surfaced (the standalone `scan` verb),
// never blocking. `off` disables scanning. There is intentionally NO `block`
// mode yet (Codex C2): an inert block mode would imply enforcement that does not
// exist — block lands with the first enforcing boundary path (FORGE-203/204).
export const TripwireSchema = z
  .object({
    mode: z.enum(['off', 'mark']).default('mark'),
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
      .enum(HOSTS)
      .default('claude'),
    // FORGE-160: opt-in for the beta Cursor CLI as the primary dispatch host.
    // Required to set primary_host_cli: cursor (see refine below).
    cursor_host_beta_opt_in: z.boolean().default(false),
    // FORGE-88 / FORGE-223 / FORGE-224: review hosts are claude / codex /
    // gemini. Claude is now an allowed review host (ClaudeHarness.runReview
    // shells out to `claude -p`). The invariant is that second-opinion review
    // requires a host DIFFERENT from primary_host_cli (enforced by the refine
    // below). `null` disables second-opinion review entirely.
    review_host_cli: z
      .enum(REVIEW_HOSTS)
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
      .array(z.enum(HOSTS))
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
    // FORGE-202: report-only injection-scanner mode (off | mark; default mark).
    // Consumed today only by the standalone `forge orchestrate scan` verb;
    // boundary enforcement (and any `block` mode) lands with FORGE-203/204.
    tripwire: TripwireSchema,
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

// FORGE-215: cross-phase /deliver knobs. The themed-batching POLICY is a
// pure-skill heuristic (it lives in skills/deliver/SKILL.md, NOT a verb) — this
// block exposes only the configurable CAPS so the heuristic references real
// knobs. Mirrors DriveSchema's nested `.default({})` so a settings.yaml with no
// `deliver:` block still yields full defaults. review_loop_cap + merge_policy
// mirror drive (a batch runs ONE shared review↔fix loop + ONE merge decision).
const DeliverSchema = z
  .object({
    // Max tickets grouped into one shared-worktree/one-PR batch.
    max_batch_size: z.number().int().positive().default(4),
    // Only tickets whose estimate index ≤ this cap (in ESTIMATES order
    // S<M<L<XL) batch; larger tickets are delivered SOLO (one PR each).
    max_batch_estimate: z.enum(ESTIMATES).default('S'),
    // Max review↔fix rounds for the batch before escalating (park to /inbox).
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

// FORGE-197: host-integration opt-ins. Orthogonal to `agents` (which configures
// the orchestrator) — `hosts` declares passive integrations Forge writes into a
// host's OWN config. Today the only key is `claude.status_line`: an opt-in
// (default FALSE) consent flag gating whether `forge upgrade` writes a
// display-only `statusLine` entry into the user's GLOBAL `~/.claude/settings.json`
// (the parked-decision badge). Default off so a global-config write NEVER
// happens without an explicit opt-in. Mirrors DriveSchema's nested-`.default({})`
// pattern so a settings.yaml with no `hosts:` block still yields full defaults.
const HostsSchema = z
  .object({
    claude: z
      .object({
        status_line: z.boolean().default(false),
        // FORGE-202 follow-on: opt-in (default FALSE) consent gating whether
        // `forge upgrade` writes a PostToolUse hook into the user's GLOBAL
        // `~/.claude/settings.json`. The hook (`forge tripwire-hook`) scans
        // untrusted tool/MCP output for prompt-injection. Default off so a
        // global-config write NEVER happens without an explicit opt-in.
        tripwire_hook: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});

// FORGE-179: `/audit` read-only core knobs. Mirrors DriveSchema's nested
// `.default({})` so a settings.yaml with no `audit:` block still yields full
// defaults. ZERO forge-specific paths: scope is auto-discovered from the repo
// tree when `scope_globs` is unset, and protected globs come from the adopter's
// CRITICAL.md + this optional supplement (FORGE-182: NOT agents.preflight_globs
// — its JS-scaffold default would leak forge-shaped paths into a non-forge
// repo's audit; see src/cli/orchestrate/audit.ts resolveProtectedGlobs). The default
// `dimensions` list is the generic audit taxonomy (dead-code / duplication /
// over-export / complexity / dependency-bloat / stale-docs) — see
// docs/audits/refactoring-audit-agent-prompt.md; it names no concrete path.
const AuditSchema = z
  .object({
    // Unset → auto-discover scope by ranking the repo's tracked top-level dirs.
    scope_globs: z.array(z.string().min(1)).optional(),
    // Supplements CRITICAL.md (union, not replacement) for the audit protected set.
    protected_globs: z.array(z.string().min(1)).optional(),
    dimensions: z
      .array(z.string().min(1))
      .default([
        'dead-code',
        'duplication',
        'over-export',
        'complexity',
        'dependency-bloat',
        'stale-docs',
      ]),
    max_findings_per_agent: z.number().int().positive().default(50),
  })
  .default({});

// FORGE-205: docs-coverage knobs for `forge orchestrate doctor --scope docs`.
// Mirrors AuditSchema's nested `.default({})` so a settings.yaml with no
// `docs_coverage:` block still yields full defaults. Each category carries a
// `trigger` glob list (a code change that REQUIRES the doc) + a `satisfy` glob
// list (a doc path that, if ALSO in the same diff, covers the requirement).
// FieldNote ships trigger-empty (satisfy-only — already owned by `/learn`);
// Rationale's CRITICAL.md paths are unioned into its triggers at RUNTIME by
// map.ts (they're per-repo, not a static schema default). Adopter-configurable
// so non-forge repos tune the globs to their own layout (FORGE-182 leak class
// is harmless here: a glob that doesn't match → zero triggers → empty report).
const DocsCoverageCategorySchema = z
  .object({
    trigger: z.array(z.string().min(1)).default([]),
    satisfy: z.array(z.string().min(1)).default([]),
  })
  .strict();

const DocsCoverageSchema = z
  .object({
    enabled: z.boolean().default(true),
    categories: z
      .object({
        Contract: DocsCoverageCategorySchema.default({
          trigger: ['src/schemas/**', 'src/cli/**'],
          satisfy: ['spec/SPEC.md', 'CHANGELOG.md', 'README.md'],
        }),
        Operator: DocsCoverageCategorySchema.default({
          trigger: ['src/cli/init/**', 'src/trackers/**', '**/*settings*.ts'],
          satisfy: ['README.md', 'docs/**'],
        }),
        Walkthrough: DocsCoverageCategorySchema.default({
          trigger: ['spec/PRD.md'],
          satisfy: ['docs/**', 'README.md'],
        }),
        Rationale: DocsCoverageCategorySchema.default({
          trigger: ['spec/decisions/**'],
          satisfy: ['spec/decisions/**', 'spec/SPEC.md'],
        }),
        FieldNote: DocsCoverageCategorySchema.default({
          trigger: [],
          satisfy: ['docs/learnings/**'],
        }),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

// FORGE-200 (Loom I1): the memory-backend selector. A discriminated union on
// `backend` so adding a remote variant (Athena) later is purely additive — the
// only I1 variant is `local` (SQLite WAL+FTS5 under <main-checkout>/.forge/loom.db,
// resolved via src/memory/paths.ts). Wrapped with `.default({ backend: 'local' })`
// so a settings.yaml with no `memory:` block still yields a full default — mirrors
// how `audit`/`drive` mount via nested defaults.
const MemorySchema = z
  .discriminatedUnion('backend', [
    z.object({ backend: z.literal('local') }).strict(),
  ])
  .default({ backend: 'local' });

// FORGE-204 (Search adapter I1): the search-provider selector. A discriminated
// union on `provider` — all four literals accepted for forward-compat, but only
// `native` (keyless URL fetch, Tripwire-scanned at the base) is wired in I1; the
// factory throws NOT_IMPLEMENTED for the others. Wrapped with
// `.default({ provider: 'native' })` so a settings.yaml with no `search:` block
// resolves to the keyless native provider — zero-config adopters get search.
export const SearchSchema = z
  .discriminatedUnion('provider', [
    z.object({ provider: z.literal('native') }).strict(),
    z.object({ provider: z.literal('exa') }).strict(),
    z.object({ provider: z.literal('parallel') }).strict(),
    z.object({ provider: z.literal('perplexity') }).strict(),
  ])
  .default({ provider: 'native' });

// FORGE-155: `forge upgrade` in-flight guard knobs. Mirrors DriveSchema's nested
// `.default({})` so a settings.yaml with no `upgrade:` block still yields full
// defaults. `guard_in_flight` (default TRUE) gates the exit-2 refusal: when on,
// `forge upgrade` refuses (exit 2) if the working tree is dirty or a non-expired
// worker lease exists, unless `--force` is passed. Set false to disable the
// in-flight checks entirely (upgrade proceeds without them).
const UpgradeSchema = z
  .object({
    guard_in_flight: z.boolean().default(true),
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
  // FORGE-215: cross-phase /deliver knobs (batch caps + review loop + merge).
  deliver: DeliverSchema,
  // FORGE-150: legacy block — optional, no default. Honored by the resolver for
  // back-compat; removed in v0.6.
  codex: CodexSchema,
  decisions: DecisionsSchema,
  doctor: DoctorSchema,
  // FORGE-197: host-integration opt-ins (claude.status_line — default false).
  hosts: HostsSchema,
  // FORGE-150: tracked methodology-version pin (FORGE-161). Absent ⇒ no warning
  // (pre-pin repos stay quiet); stamped by `forge upgrade`.
  methodology_version: z.string().min(1).optional(),
  // FORGE-168: optional — unset ⇒ skip verification with a warning.
  verify: VerifySchema.optional(),
  // FORGE-179: `/audit` read-only core knobs (scope/protected globs, dimensions,
  // per-agent finding cap). Nested `.default({})` → absent block yields defaults.
  audit: AuditSchema,
  // FORGE-205: docs-coverage knobs for `doctor --scope docs`. Nested
  // `.default({})` → absent block yields full per-category trigger/satisfy
  // defaults + enabled:true.
  docs_coverage: DocsCoverageSchema,
  // FORGE-200: Loom memory-backend selector. Nested `.default({backend:'local'})`
  // → absent block resolves to the local SQLite backend.
  memory: MemorySchema,
  // FORGE-204: search-provider selector. Nested `.default({provider:'native'})`
  // → absent block resolves to the keyless native provider (Tripwire-scanned at
  // the adapter base).
  search: SearchSchema,
  // FORGE-155: `forge upgrade` in-flight guard (exit-2). Nested `.default({})` →
  // absent block resolves to guard_in_flight: true.
  upgrade: UpgradeSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Verify = z.infer<typeof VerifySchema>;
export type Drive = z.infer<typeof DriveSchema>;
export type Deliver = z.infer<typeof DeliverSchema>;
export type Audit = z.infer<typeof AuditSchema>;
export type DocsCoverage = z.infer<typeof DocsCoverageSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type Search = z.infer<typeof SearchSchema>;

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
