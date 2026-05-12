import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InitAnswers } from './prompts.ts';

export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface ProbeResult {
  key: string;
  label: string;
  status: ProbeStatus;
  message?: string;
  installLink?: string;
}

export interface ValidationReport {
  results: ProbeResult[];
  unverified: string[];
  gitFatal: boolean;
}

export type ExecaLike = (
  cmd: string,
  args: readonly string[],
  opts: { timeout: number; reject: false; cwd?: string },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean; failed?: boolean }>;

export interface ValidateOptions {
  cwd: string;
  timeoutMs?: number;
  exec?: ExecaLike;
  // Env-var reader seam. Defaults to process.env. Injected for tests so
  // probes that depend on env vars (e.g. LINEAR_API_KEY) are deterministic.
  getEnv?: (name: string) => string | undefined;
  // When true, treat as headless CI: all probes auto-skip after recording status
  autoSkipFailures?: boolean;
  // When confirmer returns true, the failed probe is appended to unverified[] and init continues.
  // When false (default), the caller treats validation as fatal.
  onProbeFailure?: (probe: ProbeResult) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const HOST_CLI_INSTALL: Record<'claude' | 'codex' | 'cursor' | 'gemini', string> = {
  claude: 'https://docs.claude.com/claude-code',
  codex: 'https://github.com/openai/codex',
  cursor: 'https://cursor.sh/',
  gemini: 'https://github.com/google-gemini/gemini-cli',
};

function parseGitVersion(stdout: string): { major: number; minor: number } | null {
  const m = stdout.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  return { major, minor };
}

async function runProbe(
  key: string,
  label: string,
  installLink: string | undefined,
  exec: ExecaLike,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
  passPredicate: (r: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }) => true | string,
  failMessage: string,
): Promise<ProbeResult> {
  try {
    const r = await exec(cmd, args, { timeout: timeoutMs, reject: false });
    if (r.timedOut) {
      return { key, label, status: 'fail', message: `${failMessage} (probe timed out after ${timeoutMs}ms)`, installLink };
    }
    const verdict = passPredicate(r);
    if (verdict === true) {
      return { key, label, status: 'pass' };
    }
    return { key, label, status: 'fail', message: typeof verdict === 'string' ? verdict : failMessage, installLink };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { key, label, status: 'fail', message: `${failMessage} (${msg})`, installLink };
  }
}

async function probeGit(exec: ExecaLike, timeoutMs: number): Promise<ProbeResult> {
  return runProbe(
    'git',
    'git ≥ 2.20',
    'https://git-scm.com/downloads',
    exec,
    'git',
    ['--version'],
    timeoutMs,
    (r) => {
      if (r.exitCode !== 0) return 'git not found on PATH';
      const v = parseGitVersion(r.stdout);
      if (!v) return 'could not parse git version output';
      if (v.major < 2 || (v.major === 2 && v.minor < 20)) {
        return `git ${v.major}.${v.minor} found; ≥ 2.20 required (forge orchestrator uses worktrees)`;
      }
      return true;
    },
    'git ≥ 2.20 is required; forge orchestrator uses worktrees.',
  );
}

async function probeHostCli(
  key: string,
  cli: 'claude' | 'codex' | 'cursor' | 'gemini',
  label: string,
  exec: ExecaLike,
  timeoutMs: number,
): Promise<ProbeResult> {
  return runProbe(
    key,
    label,
    HOST_CLI_INSTALL[cli],
    exec,
    cli,
    ['--version'],
    timeoutMs,
    (r) => (r.exitCode === 0 ? true : `${cli} --version exited ${r.exitCode}`),
    `${label} host CLI \`${cli}\` not found on PATH.`,
  );
}

async function probeMcp(
  key: string,
  needle: 'linear' | 'notion',
  exec: ExecaLike,
  timeoutMs: number,
  hostIsClaude: boolean,
): Promise<ProbeResult> {
  if (!hostIsClaude) {
    return {
      key,
      label: `${needle} MCP`,
      status: 'skip',
      message: `Primary host is not claude — verify ${needle} MCP manually for your host CLI.`,
      installLink:
        needle === 'linear' ? 'https://linear.app/docs/mcp' : 'https://developers.notion.com/docs/mcp',
    };
  }
  return runProbe(
    key,
    `${needle} MCP`,
    needle === 'linear' ? 'https://linear.app/docs/mcp' : 'https://developers.notion.com/docs/mcp',
    exec,
    'claude',
    ['mcp', 'list'],
    timeoutMs,
    (r) => {
      if (r.exitCode !== 0) return `\`claude mcp list\` exited ${r.exitCode}`;
      const haystack = (r.stdout + '\n' + r.stderr).toLowerCase();
      return haystack.includes(needle) ? true : `${needle} not in \`claude mcp list\` output`;
    },
    `${needle} MCP not detected.`,
  );
}

async function probeSecretManager(
  answers: InitAnswers,
  exec: ExecaLike,
  timeoutMs: number,
  cwd: string,
): Promise<ProbeResult | null> {
  const s = answers.secrets;
  switch (s.manager) {
    case 'env_file': {
      const p = resolve(cwd, s.env_file_path);
      const exists = existsSync(p);
      return {
        key: 'secret_mgr_env_file',
        label: 'env file',
        status: exists ? 'pass' : 'fail',
        message: exists ? undefined : `env file \`${s.env_file_path}\` does not exist yet — create it before running orchestrator.`,
      };
    }
    case '1password':
      return runProbe(
        'secret_mgr_op',
        '1Password CLI',
        'https://1password.com/downloads/command-line/',
        exec,
        'op',
        ['--version'],
        timeoutMs,
        (r) => (r.exitCode === 0 ? true : `op --version exited ${r.exitCode}`),
        '1Password CLI `op` not found.',
      );
    case 'doppler':
      return runProbe(
        'secret_mgr_doppler',
        'Doppler CLI',
        'https://docs.doppler.com/docs/install-cli',
        exec,
        'doppler',
        ['--version'],
        timeoutMs,
        (r) => (r.exitCode === 0 ? true : `doppler --version exited ${r.exitCode}`),
        'Doppler CLI not found.',
      );
    case 'aws_secrets':
      return runProbe(
        'secret_mgr_aws_secrets',
        'AWS CLI (adapter pending)',
        'https://docs.aws.amazon.com/cli/',
        exec,
        'aws',
        ['--version'],
        timeoutMs,
        (r) => (r.exitCode === 0 ? true : `aws --version exited ${r.exitCode}`),
        'AWS CLI not detected; adapter not yet implemented.',
      );
    case 'infisical':
      return runProbe(
        'secret_mgr_infisical',
        'Infisical CLI (adapter pending)',
        'https://infisical.com/docs/cli/overview',
        exec,
        'infisical',
        ['--version'],
        timeoutMs,
        (r) => (r.exitCode === 0 ? true : `infisical --version exited ${r.exitCode}`),
        'Infisical CLI not detected; adapter not yet implemented.',
      );
  }
}

async function probeTracker(answers: InitAnswers, exec: ExecaLike, timeoutMs: number): Promise<ProbeResult | null> {
  const t = answers.tracker;
  const hostIsClaude = answers.agents.primary_host_cli === 'claude';
  switch (t.type) {
    case 'linear':
      // Linear MCP probe is for the user-facing /push-to-linear skill, NOT
      // the orchestrator runtime. The orchestrator's LinearTracker uses
      // @linear/sdk with LINEAR_API_KEY (see probeLinearApiKey, plumbed
      // separately in validateTooling). Keep this as a soft `skip` when
      // missing so init doesn't fail on adopters who don't use the skill.
      return probeMcp('linear_mcp', 'linear', exec, timeoutMs, hostIsClaude);
    case 'github':
      return runProbe(
        'gh',
        'GitHub CLI',
        'https://cli.github.com/',
        exec,
        'gh',
        ['auth', 'status'],
        timeoutMs,
        (r) => (r.exitCode === 0 ? true : `gh auth status exited ${r.exitCode}`),
        '`gh` CLI not authenticated.',
      );
    case 'notion':
      return probeMcp('notion_mcp', 'notion', exec, timeoutMs, hostIsClaude);
  }
}

// LinearTracker (the orchestrator's runtime adapter, separate from the
// /push-to-linear skill) talks to Linear's GraphQL API via @linear/sdk.
// LINEAR_API_KEY env var is REQUIRED at orchestrator runtime; we check it
// at init time so adopters discover the requirement before their first
// `forge orchestrate` run fails. See docs/adapters/linear.md.
function probeLinearApiKey(getEnv: (name: string) => string | undefined): ProbeResult {
  const key = 'linear_api_key';
  const label = 'LINEAR_API_KEY env var';
  const installLink = 'https://linear.app/settings/account/security';
  const value = getEnv('LINEAR_API_KEY');
  if (value !== undefined && value.trim().length > 0) {
    return { key, label, status: 'pass' };
  }
  return {
    key,
    label,
    status: 'fail',
    message:
      'LINEAR_API_KEY not set. The orchestrator uses @linear/sdk directly (not the MCP server). ' +
      'Mint a Personal API Key at linear.app/settings/account/security and export it before `forge orchestrate`.',
    installLink,
  };
}

export async function validateTooling(
  answers: InitAnswers,
  opts: ValidateOptions,
): Promise<ValidationReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = opts.exec ?? (execa as unknown as ExecaLike);
  const getEnv = opts.getEnv ?? ((n: string) => process.env[n]);

  // Parallel — probes are independent.
  const tasks: Promise<ProbeResult | null>[] = [
    probeGit(exec, timeoutMs),
    probeHostCli('primary_host', answers.agents.primary_host_cli, 'Primary', exec, timeoutMs),
  ];

  if (answers.agents.review_host_cli !== null) {
    tasks.push(probeHostCli('review_host', answers.agents.review_host_cli, 'Review', exec, timeoutMs));
  }
  tasks.push(probeTracker(answers, exec, timeoutMs));
  if (answers.tracker.type === 'linear') {
    tasks.push(Promise.resolve(probeLinearApiKey(getEnv)));
  }
  tasks.push(probeSecretManager(answers, exec, timeoutMs, opts.cwd));

  const settled = await Promise.all(tasks);
  const results = settled.filter((r): r is ProbeResult => r !== null);

  const unverified: string[] = [];
  let gitFatal = false;

  for (const r of results) {
    if (r.status === 'fail') {
      if (r.key === 'git') {
        gitFatal = true;
        continue;
      }
      if (opts.autoSkipFailures) {
        unverified.push(r.key);
        continue;
      }
      if (opts.onProbeFailure) {
        const skip = await opts.onProbeFailure(r);
        if (skip) {
          unverified.push(r.key);
        } else {
          // Treat as fatal — caller decides how to surface.
          gitFatal = false;
          throw new Error(`probe ${r.key} failed and user declined to skip: ${r.message ?? ''}`);
        }
      } else {
        unverified.push(r.key);
      }
    }
  }

  return { results, unverified, gitFatal };
}
