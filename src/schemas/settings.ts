import { z } from 'zod';

const LinearTrackerSchema = z.object({
  type: z.literal('linear'),
  config: z.object({ team_id: z.string() }),
});

const GithubTrackerSchema = z.object({
  type: z.literal('github'),
  config: z.object({ repo: z.string() }),
});

const MotionTrackerSchema = z.object({
  type: z.literal('motion'),
  config: z.object({ workspace_id: z.string() }),
});

export const TrackerSchema = z.discriminatedUnion('type', [
  LinearTrackerSchema,
  GithubTrackerSchema,
  MotionTrackerSchema,
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
  })
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
  tracker: TrackerSchema,
  secrets: SecretsSchema,
  agents: AgentsSchema,
  design: DesignSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;

export type LinearTracker = z.infer<typeof LinearTrackerSchema>;
export type GithubTracker = z.infer<typeof GithubTrackerSchema>;
export type MotionTracker = z.infer<typeof MotionTrackerSchema>;
export type Tracker = z.infer<typeof TrackerSchema>;

export type EnvFileSecrets = z.infer<typeof EnvFileSecretsSchema>;
export type OnePasswordSecrets = z.infer<typeof OnePasswordSecretsSchema>;
export type AwsSecrets = z.infer<typeof AwsSecretsSchema>;
export type DopplerSecrets = z.infer<typeof DopplerSecretsSchema>;
export type InfisicalSecrets = z.infer<typeof InfisicalSecretsSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;
