import {
  HarnessError,
  isHarnessError,
  type DispatchOpts,
  type HealthResult,
  type IHarness,
  type ReviewVerdict,
  type SubagentHandle,
} from './base.ts';
import {
  spawnSubprocess,
  type SpawnSubprocess,
  type SpawnResult,
} from './subprocess.ts';
import { parseHarnessVerdict } from './verdict-parser.ts';
import { classifyDispatch } from './codex.ts';

const GEMINI_BIN = 'gemini';
const NPX_BIN = 'npx';
const NPX_PACKAGE = '@google/gemini-cli';
const HEALTH_TIMEOUT_MS = 10_000;
const EXPERIMENTAL_ENV = 'FORGE_GEMINI_EXPERIMENTAL';

export interface GeminiHarnessOpts {
  readonly spawnSubprocess?: SpawnSubprocess;
  readonly env?: NodeJS.ProcessEnv;
}

interface ResolvedBinary {
  readonly command: string;
  readonly leadingArgs: readonly string[];
}

export class GeminiHarness implements IHarness {
  readonly host = 'gemini' as const;
  readonly #spawn: SpawnSubprocess;
  #binary: ResolvedBinary | undefined;

  constructor(opts: GeminiHarnessOpts = {}) {
    const env = opts.env ?? process.env;
    if (env[EXPERIMENTAL_ENV] !== '1') {
      throw new HarnessError(
        'EXPERIMENTAL_GATE_CLOSED',
        'gemini',
        `GeminiHarness is experimental. Set ${EXPERIMENTAL_ENV}=1 to opt in. The gemini CLI is pre-1.0 and its flags may change.`,
      );
    }
    this.#spawn = opts.spawnSubprocess ?? spawnSubprocess;
  }

  async dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle> {
    const bin = await this.#resolveBinary();
    const pending = this.#spawn(
      bin.command,
      [...bin.leadingArgs, '-p', renderedPrompt, '--approval-mode=yolo'],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        host: 'gemini',
      },
    );

    return {
      taskId: opts.taskId,
      attemptId: opts.attemptId,
      wait: async () => classifyDispatch(await safe(pending)),
    };
  }

  async runReview(
    diff: string,
    reviewPrompt: string,
    opts: DispatchOpts,
  ): Promise<ReviewVerdict> {
    const bin = await this.#resolveBinary();
    const prompt = `${reviewPrompt}\n\n## Diff\n\n${diff}`;
    const result = await this.#spawn(
      bin.command,
      [...bin.leadingArgs, '-p', prompt, '--approval-mode=yolo'],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        host: 'gemini',
      },
    );
    return parseHarnessVerdict({ host: 'gemini', stdout: result.stdout });
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const version = await this.detectVersion();
      return { ok: true, version };
    } catch (err) {
      return {
        ok: false,
        message: isHarnessError(err) ? err.message : String(err),
      };
    }
  }

  async detectVersion(): Promise<string> {
    const bin = await this.#resolveBinary();
    const result = await this.#spawn(
      bin.command,
      [...bin.leadingArgs, '--version'],
      { cwd: process.cwd(), timeoutMs: HEALTH_TIMEOUT_MS, host: 'gemini' },
    );
    return result.stdout.trim();
  }

  async #resolveBinary(): Promise<ResolvedBinary> {
    if (this.#binary) return this.#binary;
    try {
      await this.#spawn(GEMINI_BIN, ['--version'], {
        cwd: process.cwd(),
        timeoutMs: HEALTH_TIMEOUT_MS,
        host: 'gemini',
      });
      this.#binary = { command: GEMINI_BIN, leadingArgs: [] };
    } catch (err) {
      if (isHarnessError(err) && err.code === 'BINARY_NOT_FOUND') {
        this.#binary = { command: NPX_BIN, leadingArgs: [NPX_PACKAGE] };
      } else {
        throw err;
      }
    }
    return this.#binary;
  }
}

type SafeResult =
  | { ok: true; value: SpawnResult }
  | { ok: false; error: unknown };

async function safe(p: Promise<SpawnResult>): Promise<SafeResult> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}
