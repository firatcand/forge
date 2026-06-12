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
// FORGE-117: init emits only database_id for Notion. The legacy
// mcp_command/mcp_env fields are deprecated (accepted+ignored by the settings
// schema; removed in v0.6) — new projects must not be born with them.
const TrackerNotionSchema = z.object({
  type: z.literal('notion'),
  config: z.object({
    database_id: z.string().min(1),
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

// FORGE-88: primary/review enums diverge. Primary may be any of the three
// supported harnesses; review excludes claude (different-model-lineage rule).
// FORGE-160: cursor joins primary (beta — gated by cursor_host_beta_opt_in in
// the settings schema) and enabled_root_files (passive breadcrumb, ungated).
const PrimaryHostCliEnum = z.enum(['claude', 'codex', 'gemini', 'cursor']);
const ReviewHostCliEnum = z.enum(['codex', 'gemini']);
// FORGE-152/FORGE-160: enabled_root_files. Init writes one root file per
// selected agent (CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules/forge-context.mdc).
const EnabledRootFileEnum = z.enum(['claude', 'codex', 'gemini', 'cursor']);

const AgentsAnswersSchema = z
  .object({
    max_concurrent: z.number().int().min(1).max(50),
    retry_attempts: z.number().int().min(0).max(100),
    primary_host_cli: PrimaryHostCliEnum,
    review_host_cli: ReviewHostCliEnum.nullable(),
    // FORGE-152: which agent root files to write at init. Enforce at least 1
    // — empty would leave the project without any agent surface. Settings
    // schema's .transform() promotes empty to [primary_host_cli], but init's
    // contract is stricter: never produce an answer set with 0 root files.
    enabled_root_files: z.array(EnabledRootFileEnum).min(1),
  })
  .refine(
    (d) => d.review_host_cli === null || d.review_host_cli !== d.primary_host_cli,
    {
      message:
        'review_host_cli must differ from primary_host_cli (or be null to disable second-opinion review)',
    },
  )
  // FORGE-152: enabled_root_files must include primary_host_cli — the
  // primary harness MUST have its root file written or it won't see any
  // project context on launch. Allow extras beyond primary (e.g., user
  // primary=claude but also wants AGENTS.md so Codex teammates can pair).
  .refine((d) => d.enabled_root_files.includes(d.primary_host_cli), {
    message:
      'enabled_root_files must include primary_host_cli — the primary harness needs its root file',
    path: ['enabled_root_files'],
  })
  // FORGE-160 (GPT-5.5 review): init NEVER produces the beta opt-in flag, yet
  // cursor-as-primary requires `agents.cursor_host_beta_opt_in: true` to pass
  // the SettingsSchema check. A non-interactive answer set with
  // `primary_host_cli: cursor` (the interactive prompt can't select it) would
  // otherwise write every artifact, THEN fail the final settings validation —
  // leaving a broken half-init. Reject it HERE, at the answers-validation stage,
  // BEFORE any artifact is written. cursor stays fine in enabled_root_files
  // (the passive breadcrumb); only cursor-as-PRIMARY is gated.
  .refine((d) => d.primary_host_cli !== 'cursor', {
    message:
      'primary_host_cli: cursor is not supported by `forge init` — it requires agents.cursor_host_beta_opt_in: true, and init never produces that beta flag. Init with a non-cursor primary (cursor may stay in enabled_root_files as a passive breadcrumb), then set primary_host_cli: cursor and cursor_host_beta_opt_in: true in .forge/settings.yaml manually.',
    path: ['primary_host_cli'],
  });

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
  // FORGE-108: init-time observation, NOT persisted to settings.yaml. Gates
  // the agent-level `gh auth status` probe in validate.ts so users who pair
  // a non-GitHub tracker (Linear / Notion) with GitHub code hosting still
  // get their auth checked. The existing tracker-conditional gh probe at
  // validate.ts probeTracker(github) is a separate concern (tracker-API auth).
  // `.default(false)` keeps existing test fixtures parsing without churn —
  // the interactive prompt always supplies an explicit value at init time.
  github_connected: z.boolean().default(false),
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
  // FORGE-152: checkbox prompt for multi-agent root file selection. Pulled
  // from @inquirer/prompts (the same package the other prompts use).
  checkbox?: (opts: {
    message: string;
    choices: ReadonlyArray<{ name: string; value: string; checked?: boolean }>;
    validate?: (
      choices: ReadonlyArray<{ value: string }>,
    ) => boolean | string | Promise<boolean | string>;
  }) => Promise<readonly string[]>;
}

let numberConfirmOverride: NumberConfirmModule | null = null;

export function __setNumberConfirmForTests(mod: NumberConfirmModule | null): void {
  numberConfirmOverride = mod;
}

async function loadNumberConfirm(): Promise<Required<NumberConfirmModule>> {
  if (
    numberConfirmOverride?.number &&
    numberConfirmOverride?.confirm &&
    numberConfirmOverride?.checkbox
  ) {
    return {
      number: numberConfirmOverride.number,
      confirm: numberConfirmOverride.confirm,
      checkbox: numberConfirmOverride.checkbox,
    };
  }
  const mod = await import('@inquirer/prompts');
  return {
    number: mod.number as Required<NumberConfirmModule>['number'],
    confirm: mod.confirm as Required<NumberConfirmModule>['confirm'],
    checkbox: mod.checkbox as Required<NumberConfirmModule>['checkbox'],
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

// FORGE-88: primary may include gemini, but only when FORGE_GEMINI_EXPERIMENTAL=1.
// We compute the list at call-time so the env-gate change is visible without
// restarting the process; tests can toggle the env var around collectAnswers().
function primaryHostCliChoices(): readonly ('claude' | 'codex' | 'gemini')[] {
  const base = ['claude', 'codex'] as const;
  return process.env.FORGE_GEMINI_EXPERIMENTAL === '1'
    ? [...base, 'gemini']
    : base;
}
function reviewHostCliChoices(): readonly ('codex' | 'gemini')[] {
  const base = ['codex'] as const;
  return process.env.FORGE_GEMINI_EXPERIMENTAL === '1'
    ? [...base, 'gemini']
    : base;
}
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
      config: { database_id: databaseId },
    };
  }

  // 5. GitHub connected? (FORGE-108)
  // Init-time observation; gates the agent-level gh auth status probe in
  // validate.ts. Decoupled from tracker choice so non-GitHub-tracker users
  // (Linear, Notion) who still use GitHub for code hosting get their auth
  // checked. Loads inquirer's confirm prompt lazily (same module as the
  // existing checkbox/number prompts).
  // Skip the prompt when tracker is already GitHub — the user has already
  // declared GitHub usage, and the agent-level probe in validate.ts is
  // suppressed in that case (probeTracker(github) covers it). Asking again
  // is redundant Q&A. Set the flag to `true` informationally; the validate
  // guard `&& tracker.type !== 'github'` keeps the redundant probe off.
  // (Codex second-opinion catch — the original code asked unconditionally,
  // producing UX ambiguity when paired with the validate-side suppression.)
  let githubConnected: boolean;
  if (tracker.type === 'github') {
    githubConnected = true;
  } else {
    const { confirm: askConfirmAgents } = await loadNumberConfirm();
    // `default: false` so Enter-through-everything stays consistent with
    // PRD §Feature 3: "all defaults work without user input → valid project."
    // Defaulting to true would surface a `gh auth status` failure on machines
    // that don't have `gh` installed (common when tracker is Linear/Notion).
    githubConnected = await askConfirmAgents({
      message: 'Are you using GitHub for code hosting? (validates `gh auth status` if yes)',
      default: false,
    });
  }

  // 6. secret manager
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

  // 7. max_concurrent
  const maxConcurrent = await askNumber({
    message: 'Max concurrent tasks?',
    default: 10,
    validate: validateInt(1, 50, 'max_concurrent'),
  });

  // 8. retry_attempts
  const retryAttempts = await askNumber({
    message: 'Retry attempts on failure?',
    default: 10,
    validate: validateInt(0, 100, 'retry_attempts'),
  });

  // 9. primary host cli (FORGE-88: gemini gated on FORGE_GEMINI_EXPERIMENTAL=1)
  const primaryHostCli = (await loggerPrompt('Primary host CLI (writes code)?', {
    choices: primaryHostCliChoices() as unknown as readonly string[],
    default: 'claude',
  })) as 'claude' | 'codex' | 'gemini' | 'cursor';

  // 10. review host cli — re-prompt on collision
  const reviewChoices = [...reviewHostCliChoices(), 'none'] as const;
  // Pick the first non-colliding option as default; falls back to 'none'
  // when primary occupies the only available review slot (e.g. primary=codex
  // without the gemini gate → review choices is just ['codex','none']).
  const defaultReview =
    (reviewChoices as readonly string[]).find((c) => c !== primaryHostCli) ?? 'none';
  let reviewHostCli: 'codex' | 'gemini' | null;
  while (true) {
    const reviewChoice = (await loggerPrompt('Review host CLI (second-opinion)?', {
      choices: reviewChoices as unknown as readonly string[],
      default: defaultReview,
    })) as string;
    const value = reviewChoice === 'none' ? null : (reviewChoice as 'codex' | 'gemini');
    // FORGE-152: the enabled_root_files field is collected AFTER this loop.
    // Seed it with the primary so the .min(1) + must-include-primary refinements
    // pass here — they're validated for real once the checkbox prompt fires
    // below. This loop only enforces the review/primary collision rule.
    const candidate = AgentsAnswersSchema.safeParse({
      max_concurrent: maxConcurrent,
      retry_attempts: retryAttempts,
      primary_host_cli: primaryHostCli,
      review_host_cli: value,
      enabled_root_files: [primaryHostCli],
    });
    if (candidate.success) {
      reviewHostCli = value;
      break;
    }
    const msg = candidate.error.issues[0]?.message ?? 'invalid review_host_cli selection';
    errorBlock('Invalid review host CLI', msg);
  }

  // 11. FORGE-152: which agent root files to write?
  // Pre-check the primary host CLI; user can add codex / gemini as additional
  // root files for teammates on those agents. Empty selection auto-falls back
  // to [primary_host_cli] in the validator below.
  const { checkbox } = await loadNumberConfirm();
  const rootFileChoices = [
    {
      name: 'Claude Code (CLAUDE.md)',
      value: 'claude',
      checked: primaryHostCli === 'claude',
    },
    {
      name: 'Codex (AGENTS.md)',
      value: 'codex',
      checked: primaryHostCli === 'codex',
    },
    {
      name: 'Gemini (GEMINI.md)',
      value: 'gemini',
      checked: primaryHostCli === 'gemini',
    },
    // FORGE-160: cursor breadcrumb. Adds the gitignored
    // .cursor/rules/forge-context.mdc rule + the .agents/skills / .cursor/agents
    // farm. Selecting it here is the PASSIVE breadcrumb (ungated); cursor as the
    // PRIMARY dispatch host is set in settings.yaml behind cursor_host_beta_opt_in.
    {
      name: 'Cursor (.cursor/rules/forge-context.mdc)',
      value: 'cursor',
      checked: primaryHostCli === 'cursor',
    },
  ] as const;
  const enabledRootFilesRaw = (await checkbox({
    message:
      'Which agent root files should this project write? (primary is auto-selected; add others for teammates on other agents)',
    choices: rootFileChoices,
    validate: (selected) => {
      if (selected.length === 0) return 'Select at least one agent root file.';
      const values = selected.map((s) => s.value);
      if (!values.includes(primaryHostCli)) {
        return `Selection must include the primary host CLI (${primaryHostCli}).`;
      }
      return true;
    },
  })) as readonly ('claude' | 'codex' | 'gemini' | 'cursor')[];
  const enabledRootFiles: ('claude' | 'codex' | 'gemini' | 'cursor')[] = [...enabledRootFilesRaw];

  const answers: InitAnswers = {
    project: {
      name,
      ...(description.length > 0 ? { description } : {}),
    },
    goal,
    tracker,
    github_connected: githubConnected,
    secrets,
    agents: {
      max_concurrent: maxConcurrent,
      retry_attempts: retryAttempts,
      primary_host_cli: primaryHostCli,
      review_host_cli: reviewHostCli,
      enabled_root_files: enabledRootFiles,
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
