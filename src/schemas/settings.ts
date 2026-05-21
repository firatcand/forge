import { z } from 'zod';

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
    // Launch command for the Notion MCP server. forge spawns its own client over
    // stdio (it does not piggyback on the host CLI's MCP connection). Default is
    // the official Notion MCP server via npx; override to point at a different
    // server binary or version. Required env (e.g. NOTION_TOKEN) inherits from
    // process.env — NOT routed through the secrets manager (per SPEC).
    mcp_command: z
      .array(z.string().min(1))
      .min(1)
      .default(['npx', '-y', '@notionhq/notion-mcp-server']),
    // Additional env vars merged on top of process.env when spawning the MCP
    // server. Use for non-secret config (region, custom workspace URL, etc.).
    mcp_env: z.record(z.string(), z.string()).default({}),
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

const AgentsSchema = z
  .object({
    max_concurrent: z.number().int().positive().default(10),
    retry_attempts: z.number().int().nonnegative().default(10),
    retry_backoff_ms_max: z.number().int().positive().default(300_000),
    poll_interval_ms: z.number().int().positive().default(30_000),
    worktree_root: z.string().default('./.forge/worktrees'),
    on_persistent_failure: z
      .enum(['notify', 'block_task', 'move_to_next'])
      .default('notify'),
    // FORGE-88: primary harnesses are claude / codex / gemini. `cursor` was
    // never wired up to a runtime adapter and is dropped without a back-compat
    // shim (CLAUDE.md "no backwards-compat shims" convention).
    primary_host_cli: z
      .enum(['claude', 'codex', 'gemini'])
      .default('claude'),
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
    // FORGE-152: which agent root files (CLAUDE.md / AGENTS.md / GEMINI.md)
    // the project writes. Enum values match primary_host_cli / review_host_cli
    // for schema consistency. Empty (absent or explicit []) is promoted to
    // [primary_host_cli] by the .transform() below — see
    // test/unit/settings.schema.test.ts for the contract.
    enabled_root_files: z
      .array(z.enum(['claude', 'codex', 'gemini']))
      .default([]),
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
  .default({});

const DesignSchema = z
  .object({
    mode: z.enum(['project_owned', 'reference_external']).default('project_owned'),
    reference: z.string().optional(),
  })
  .default({});

// Added 2026-05-18 (FORGE-105 P2.5-T13) — closed-loop workflow control.
// auto_codex_enabled is the disable lever consumed by `forge codex-suggest`.
// auto_codex_token_cap is RESERVED — defined in SPEC §Auto-codex skill-level
// hooks but NOT enforced by codex-suggest. Passive suggestions bound nothing
// meaningful; the field is kept here so settings.yaml stays SPEC-compliant.
// Follow-up: amend SPEC to either drop the field or build session accounting.
const CodexSchema = z
  .object({
    auto_codex_enabled: z.boolean().default(true),
    auto_codex_token_cap: z.number().int().nonnegative().default(50_000),
  })
  .default({});

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
  codex: CodexSchema,
  decisions: DecisionsSchema,
  doctor: DoctorSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;

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
