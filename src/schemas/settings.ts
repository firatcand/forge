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
    primary_host_cli: z
      .enum(['claude', 'codex', 'cursor', 'gemini'])
      .default('claude'),
    review_host_cli: z
      .enum(['claude', 'codex', 'cursor', 'gemini'])
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
      'src/cli/migrate.ts',
      'spec/**',
      'CRITICAL.md',
      'CLAUDE.md',
      'AGENTS.md',
      'package.json',
      'phases.yaml',
    ]),
  })
  // .refine() before .default({}) — the collision check must see the
  // resolved object after inner defaults expand.
  .refine(
    (d) => d.review_host_cli === null || d.review_host_cli !== d.primary_host_cli,
    {
      message:
        'review_host_cli must differ from primary_host_cli (or be null to disable second-opinion review)',
    },
  )
  .default({});

const DesignSchema = z
  .object({
    mode: z.enum(['project_owned', 'reference_external']).default('project_owned'),
    reference: z.string().optional(),
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
