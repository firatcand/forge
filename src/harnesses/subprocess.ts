import { isAbsolute } from 'node:path';
import { execa, ExecaError } from 'execa';
import { HarnessError, type HarnessHost } from './base.ts';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_ARG_EXCERPT_BYTES = 200;
const MAX_STDERR_EXCERPT_BYTES = 2000;

// Allowlist of env vars forwarded to AI subprocesses (codex / gemini).
//
// /review H1: codex and gemini are AI CLIs that ship arbitrary context to
// external APIs. Inheriting `process.env` by default would forward
// LINEAR_API_KEY, GITHUB_TOKEN, ANTHROPIC_API_KEY, and any secret loaded
// by the adopter's secret-manager into every model inference. We forward
// only the keys a subprocess needs to *run* (HOME/PATH/locale/term);
// callers that need a specific secret in the subprocess must pass it
// explicitly via DispatchOpts.env.
const SAFE_ENV_KEYS = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NODE_ENV',
  'USER',
  'USERNAME',
  'SHELL',
] as const;

function buildSubprocessEnv(
  override: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return override ? { ...base, ...override } : base;
}

// /review I3: error details previously stored the full `args` array, which
// includes the rendered worker prompt (potentially containing diff content
// and internal task context). If the error was serialised to a PR description
// or remote log, the prompt would leak. We keep only a short excerpt of the
// last arg (typically the prompt) — enough to identify which call failed,
// not enough to leak meaningful content.
function argsExcerpt(args: readonly string[]): string {
  const last = args[args.length - 1] ?? '';
  return last.slice(0, MAX_ARG_EXCERPT_BYTES);
}

export interface SpawnOpts {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly host: HarnessHost;
}

export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export type SpawnSubprocess = (
  command: string,
  args: readonly string[],
  opts: SpawnOpts,
) => Promise<SpawnResult>;

export const spawnSubprocess: SpawnSubprocess = async (command, args, opts) => {
  // /review I2: cwd is passed directly to spawn — validate at the boundary
  // before any side-effect can occur. Catches accidental relative-path
  // callers and any callsite that builds cwd from untrusted input.
  if (!isAbsolute(opts.cwd)) {
    throw new HarnessError(
      'SPAWN_FAILED',
      opts.host,
      `cwd must be an absolute path; got "${opts.cwd}"`,
      { command, cwd: opts.cwd },
    );
  }

  const startedAt = Date.now();
  try {
    const result = await execa(command, [...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES,
      // /review N2: NodeJS.ProcessEnv values are `string | undefined`,
      // but SpawnOpts.env is `Readonly<Record<string, string>>` — no
      // `undefined` values can flow in, so the runtime shape is correct.
      env: buildSubprocessEnv(opts.env),
      extendEnv: false,
      reject: false,
      all: false,
      encoding: 'utf8',
      stripFinalNewline: false,
    });

    const durationMs = Date.now() - startedAt;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    // /review B3 — guard order is load-bearing. With reject:false, execa
    // returns a result object instead of throwing on failure. When the
    // binary itself is missing (ENOENT), `result.code === 'ENOENT'` AND
    // `result.failed === true` AND `result.exitCode === undefined`. We
    // MUST check `spawnCode === 'ENOENT'` BEFORE the `result.failed`
    // branch — otherwise ENOENT surfaces as NON_ZERO_EXIT with the
    // misleading "exited with code undefined" message. The cast accepts
    // that execa's published types do not surface `.code` on the success
    // return shape; the field exists at runtime when `failed` is true.
    const spawnCode = (result as { code?: string }).code;

    if (spawnCode === 'ENOENT') {
      throw new HarnessError(
        'BINARY_NOT_FOUND',
        opts.host,
        `${command} not found on PATH. Install the ${opts.host} CLI or remove ${opts.host} from .forge/settings.yaml.`,
        { command, cause: spawnCode },
      );
    }

    if (result.timedOut) {
      throw new HarnessError(
        'TIMEOUT',
        opts.host,
        `${command} exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms and was killed`,
        {
          command,
          args_excerpt: argsExcerpt(args),
          durationMs,
          stderr_excerpt: stderr.slice(0, MAX_STDERR_EXCERPT_BYTES),
        },
      );
    }

    if (result.failed || (result.exitCode ?? 0) !== 0) {
      throw new HarnessError(
        'NON_ZERO_EXIT',
        opts.host,
        `${command} exited with code ${result.exitCode}`,
        {
          command,
          args_excerpt: argsExcerpt(args),
          exitCode: result.exitCode ?? -1,
          stderr_excerpt: stderr.slice(0, MAX_STDERR_EXCERPT_BYTES),
        },
      );
    }

    return { stdout, stderr, exitCode: result.exitCode ?? 0, durationMs };
  } catch (err) {
    if (err instanceof HarnessError) throw err;

    if (err instanceof ExecaError) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        throw new HarnessError(
          'BINARY_NOT_FOUND',
          opts.host,
          `${command} not found on PATH. Install the ${opts.host} CLI or remove ${opts.host} from .forge/settings.yaml.`,
          { command, cause: code },
          { cause: err },
        );
      }
      throw new HarnessError(
        'SPAWN_FAILED',
        opts.host,
        `${command} failed to spawn: ${err.shortMessage ?? err.message}`,
        { command, args_excerpt: argsExcerpt(args) },
        { cause: err },
      );
    }

    throw new HarnessError(
      'SPAWN_FAILED',
      opts.host,
      `${command} failed to spawn`,
      { command, args_excerpt: argsExcerpt(args) },
      { cause: err },
    );
  }
};
