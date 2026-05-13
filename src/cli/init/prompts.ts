import { z } from 'zod';
import { prompt as loggerPrompt, errorBlock } from '../../core/logger.ts';
import { basename } from 'node:path';

// FORGE-19 plan §4. Filesystem-safe slug (length ≤ 64, alnum + dot/underscore/hyphen).
// Reject leading dot/hyphen, the literal name `node_modules`.
export const PROJECT_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// owner/repo per plan §4 prompt 4 sub-prompt.
export const GITHUB_REPO_RE = /^[^\s/]+\/[^\s/]+$/;

export function validateProjectName(input: string): true | string {
  const v = input.trim();
  if (v.length === 0) return 'project name is required';
  if (v.length > 64) return 'project name must be 64 characters or fewer';
  if (!PROJECT_NAME_RE.test(v)) {
    return 'project name must match /^[a-zA-Z0-9._-]+$/ (alnum, dot, underscore, hyphen)';
  }
  if (v === 'node_modules') return 'project name "node_modules" is reserved';
  if (v.startsWith('.')) return 'project name may not start with "."';
  if (v.startsWith('-')) return 'project name may not start with "-"';
  return true;
}

export function validateGithubRepo(input: string): true | string {
  const v = input.trim();
  if (v.length === 0) return 'repo is required';
  if (!GITHUB_REPO_RE.test(v)) return 'repo must be in the form "owner/repo"';
  return true;
}

export function validateNonEmpty(label: string) {
  return (input: string): true | string => {
    if (input.trim().length === 0) return `${label} is required`;
    return true;
  };
}

const TrackerLinearSchema = z.object({
  type: z.literal('linear'),
  config: z.object({ team_id: z.string().min(1) }),
});
const TrackerGithubSchema = z.object({
  type: z.literal('github'),
  config: z.object({ repo: z.string().regex(GITHUB_REPO_RE) }),
});
const TrackerNotionSchema = z.object({
  type: z.literal('notion'),
  config: z.object({
    database_id: z.string().min(1),
    mcp_command: z
      .array(z.string().min(1))
      .min(1)
      .default(['npx', '-y', '@notionhq/notion-mcp-server']),
    mcp_env: z.record(z.string(), z.string()).default({}),
  }),
});
const TrackerSchema = z.discriminatedUnion('type', [
  TrackerLinearSchema,
  TrackerGithubSchema,
  TrackerNotionSchema,
]);

const SecretsEnvFile = z.object({
  manager: z.literal('env_file'),
  env_file_path: z.string().min(1),
});
const SecretsOnePassword = z.object({
  manager: z.literal('1password'),
  vault: z.string().min(1),
});
const SecretsDoppler = z.object({
  manager: z.literal('doppler'),
  project: z.string().min(1),
  config: z.string().min(1),
});
const SecretsAws = z.object({
  manager: z.literal('aws_secrets'),
  region: z.string().min(1),
  prefix: z.string().optional(),
});
const SecretsInfisical = z.object({
  manager: z.literal('infisical'),
  workspace_id: z.string().min(1),
  env: z.string().min(1),
});
const SecretsSchema = z.discriminatedUnion('manager', [
  SecretsEnvFile,
  SecretsOnePassword,
  SecretsDoppler,
  SecretsAws,
  SecretsInfisical,
]);

const HostCliEnum = z.enum(['claude', 'codex', 'cursor', 'gemini']);

const AgentsAnswersSchema = z
  .object({
    max_concurrent: z.number().int().min(1).max(50),
    retry_attempts: z.number().int().min(0).max(100),
    primary_host_cli: HostCliEnum,
    review_host_cli: HostCliEnum.nullable(),
  })
  .refine(
    (d) => d.review_host_cli === null || d.review_host_cli !== d.primary_host_cli,
    {
      message:
        'review_host_cli must differ from primary_host_cli (or be null to disable second-opinion review)',
    },
  );

const DesignAnswersSchema = z.object({
  mode: z.enum(['project_owned', 'reference_external']),
  reference: z.string().optional(),
});

export const InitAnswersSchema = z.object({
  project: z.object({
    name: z.string().min(1).max(64).regex(PROJECT_NAME_RE),
    description: z.string().optional(),
  }),
  goal: z.string().min(1),
  tracker: TrackerSchema,
  secrets: SecretsSchema,
  agents: AgentsAnswersSchema,
  design: DesignAnswersSchema,
});

export type InitAnswers = z.infer<typeof InitAnswersSchema>;

export interface CollectAnswersOptions {
  cwd: string;
  positionalName?: string;
}

interface NumberConfirmModule {
  number?: (opts: { message: string; default?: number; validate?: (v: number | undefined) => true | string }) => Promise<number>;
  confirm?: (opts: { message: string; default?: boolean }) => Promise<boolean>;
}

let numberConfirmOverride: NumberConfirmModule | null = null;

export function __setNumberConfirmForTests(mod: NumberConfirmModule | null): void {
  numberConfirmOverride = mod;
}

async function loadNumberConfirm(): Promise<Required<NumberConfirmModule>> {
  if (numberConfirmOverride?.number && numberConfirmOverride?.confirm) {
    return {
      number: numberConfirmOverride.number,
      confirm: numberConfirmOverride.confirm,
    };
  }
  const mod = await import('@inquirer/prompts');
  return {
    number: mod.number as Required<NumberConfirmModule>['number'],
    confirm: mod.confirm as Required<NumberConfirmModule>['confirm'],
  };
}

function validateInt(min: number, max: number, label: string) {
  return (v: number | undefined): true | string => {
    if (v === undefined || Number.isNaN(v)) return `${label} is required`;
    if (!Number.isInteger(v)) return `${label} must be an integer`;
    if (v < min) return `${label} must be ≥ ${min}`;
    if (v > max) return `${label} must be ≤ ${max}`;
    return true;
  };
}

const HOST_CLI_CHOICES = ['claude', 'codex', 'cursor', 'gemini'] as const;
const SECRET_MGR_CHOICES = [
  'env_file',
  '1password',
  'doppler',
  'aws_secrets (adapter pending)',
  'infisical (adapter pending)',
] as const;

function stripPendingSuffix(choice: string): string {
  return choice.replace(/ \(adapter pending\)$/, '');
}

export async function collectAnswers(opts: CollectAnswersOptions): Promise<InitAnswers> {
  const { cwd, positionalName } = opts;
  const defaultName = positionalName ?? basename(cwd);

  // 1. project name (skip if positional)
  let name: string;
  if (positionalName !== undefined) {
    const check = validateProjectName(positionalName);
    if (check !== true) {
      throw new Error(`invalid project name "${positionalName}": ${check}`);
    }
    name = positionalName;
  } else {
    name = (await loggerPrompt('Project name?', {
      default: defaultName,
      validate: validateProjectName,
    })).trim();
  }

  // 2. description
  const description = (
    await loggerPrompt('One-line description? (optional)', { default: '' })
  ).trim();

  // 3. goal
  const goal = (
    await loggerPrompt('What is the project goal? (free text — saved to spec/BRIEF.md)', {
      validate: validateNonEmpty('goal'),
    })
  ).trim();

  // 4. tracker
  const trackerType = (await loggerPrompt('Which task tracker?', {
    choices: ['linear', 'github', 'notion'],
    default: 'linear',
  })) as 'linear' | 'github' | 'notion';

  let tracker: InitAnswers['tracker'];
  if (trackerType === 'linear') {
    const teamId = (
      await loggerPrompt('Linear team_id?', { validate: validateNonEmpty('team_id') })
    ).trim();
    tracker = { type: 'linear', config: { team_id: teamId } };
  } else if (trackerType === 'github') {
    const repo = (
      await loggerPrompt('GitHub repo (owner/repo)?', { validate: validateGithubRepo })
    ).trim();
    tracker = { type: 'github', config: { repo } };
  } else {
    const databaseId = (
      await loggerPrompt('Notion database_id?', { validate: validateNonEmpty('database_id') })
    ).trim();
    tracker = {
      type: 'notion',
      config: {
        database_id: databaseId,
        mcp_command: ['npx', '-y', '@notionhq/notion-mcp-server'],
        mcp_env: {},
      },
    };
  }

  // 5. secret manager
  const secretChoice = (await loggerPrompt('Which secret manager?', {
    choices: SECRET_MGR_CHOICES as unknown as readonly string[],
    default: 'env_file',
  })) as string;
  const secretMgr = stripPendingSuffix(secretChoice) as
    | 'env_file'
    | '1password'
    | 'doppler'
    | 'aws_secrets'
    | 'infisical';
  let secrets: InitAnswers['secrets'];
  if (secretMgr === 'env_file') {
    const p = (
      await loggerPrompt('Env file path?', { default: './.env.local' })
    ).trim();
    secrets = { manager: 'env_file', env_file_path: p || './.env.local' };
  } else if (secretMgr === '1password') {
    const vault = (
      await loggerPrompt('1Password vault?', { validate: validateNonEmpty('vault') })
    ).trim();
    secrets = { manager: '1password', vault };
  } else if (secretMgr === 'doppler') {
    const project = (
      await loggerPrompt('Doppler project?', { validate: validateNonEmpty('project') })
    ).trim();
    const config = (
      await loggerPrompt('Doppler config?', { validate: validateNonEmpty('config') })
    ).trim();
    secrets = { manager: 'doppler', project, config };
  } else if (secretMgr === 'aws_secrets') {
    const region = (
      await loggerPrompt('AWS region?', { validate: validateNonEmpty('region') })
    ).trim();
    secrets = { manager: 'aws_secrets', region };
  } else {
    const wid = (
      await loggerPrompt('Infisical workspace_id?', { validate: validateNonEmpty('workspace_id') })
    ).trim();
    const env = (
      await loggerPrompt('Infisical env?', { validate: validateNonEmpty('env') })
    ).trim();
    secrets = { manager: 'infisical', workspace_id: wid, env };
  }

  const { number: askNumber, confirm: askConfirm } = await loadNumberConfirm();
  // not used yet but reserve for E14 / E2 path callers
  void askConfirm;

  // 6. max_concurrent
  const maxConcurrent = await askNumber({
    message: 'Max concurrent tasks?',
    default: 10,
    validate: validateInt(1, 50, 'max_concurrent'),
  });

  // 7. retry_attempts
  const retryAttempts = await askNumber({
    message: 'Retry attempts on failure?',
    default: 10,
    validate: validateInt(0, 100, 'retry_attempts'),
  });

  // 8. primary host cli
  const primaryHostCli = (await loggerPrompt('Primary host CLI (writes code)?', {
    choices: HOST_CLI_CHOICES as unknown as readonly string[],
    default: 'claude',
  })) as 'claude' | 'codex' | 'cursor' | 'gemini';

  // 9. review host cli — re-prompt on collision
  const reviewChoices = [...HOST_CLI_CHOICES, 'none'] as const;
  let reviewHostCli: 'claude' | 'codex' | 'cursor' | 'gemini' | null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const reviewChoice = (await loggerPrompt('Review host CLI (second-opinion)?', {
      choices: reviewChoices as unknown as readonly string[],
      default: primaryHostCli === 'codex' ? 'claude' : 'codex',
    })) as string;
    const value = reviewChoice === 'none' ? null : (reviewChoice as 'claude' | 'codex' | 'cursor' | 'gemini');
    const candidate = AgentsAnswersSchema.safeParse({
      max_concurrent: maxConcurrent,
      retry_attempts: retryAttempts,
      primary_host_cli: primaryHostCli,
      review_host_cli: value,
    });
    if (candidate.success) {
      reviewHostCli = value;
      break;
    }
    const msg = candidate.error.issues[0]?.message ?? 'invalid review_host_cli selection';
    errorBlock('Invalid review host CLI', msg);
  }

  const answers: InitAnswers = {
    project: {
      name,
      ...(description.length > 0 ? { description } : {}),
    },
    goal,
    tracker,
    secrets,
    agents: {
      max_concurrent: maxConcurrent,
      retry_attempts: retryAttempts,
      primary_host_cli: primaryHostCli,
      review_host_cli: reviewHostCli,
    },
    design: { mode: 'project_owned' },
  };

  const parsed = InitAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    throw new Error(
      `init answers failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}
