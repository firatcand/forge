import { execa, ExecaError } from 'execa';
import { HarnessError, type HarnessHost } from './base.ts';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

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
  const startedAt = Date.now();
  try {
    const result = await execa(command, [...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_STDOUT_BYTES,
      env: opts.env as Record<string, string> | undefined,
      reject: false,
      all: false,
      encoding: 'utf8',
      stripFinalNewline: false,
    });

    const durationMs = Date.now() - startedAt;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const spawnCode = (result as { code?: string }).code;

    if (spawnCode === 'ENOENT') {
      throw new HarnessError(
        'BINARY_NOT_FOUND',
        opts.host,
        `${command} not found on PATH. Install the ${opts.host} CLI or remove ${opts.host} from .forge/settings.yaml.`,
        { command, args, cause: spawnCode },
      );
    }

    if (result.timedOut) {
      throw new HarnessError(
        'TIMEOUT',
        opts.host,
        `${command} exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms and was killed`,
        { command, args, durationMs, stderr_excerpt: stderr.slice(0, 2000) },
      );
    }

    if (result.failed || (result.exitCode ?? 0) !== 0) {
      throw new HarnessError(
        'NON_ZERO_EXIT',
        opts.host,
        `${command} exited with code ${result.exitCode}`,
        {
          command,
          args,
          exitCode: result.exitCode ?? -1,
          stderr_excerpt: stderr.slice(0, 2000),
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
          { command, args, cause: code },
          { cause: err },
        );
      }
      throw new HarnessError(
        'SPAWN_FAILED',
        opts.host,
        `${command} failed to spawn: ${err.shortMessage ?? err.message}`,
        { command, args },
        { cause: err },
      );
    }

    throw new HarnessError(
      'SPAWN_FAILED',
      opts.host,
      `${command} failed to spawn`,
      { command, args },
      { cause: err },
    );
  }
};
