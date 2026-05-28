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
} from './subprocess.ts';
import { parseHarnessVerdict } from './verdict-parser.ts';
import { classifyDispatch, safe } from './codex.ts';

const GEMINI_BIN = 'gemini';
const HEALTH_TIMEOUT_MS = 10_000;
const EXPERIMENTAL_ENV = 'FORGE_GEMINI_EXPERIMENTAL';

export interface GeminiHarnessOpts {
  readonly spawnSubprocess?: SpawnSubprocess;
  readonly env?: NodeJS.ProcessEnv;
}

export class GeminiHarness implements IHarness {
  readonly host = 'gemini' as const;
  readonly #spawn: SpawnSubprocess;

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
    const pending = this.#spawn(
      GEMINI_BIN,
      ['-p', renderedPrompt, '--approval-mode=yolo'],
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
    // FORGE-166: pass the diff via stdin, NOT argv (see CodexHarness.runReview).
    // gemini reads piped stdin as additional context; the argv prompt stays
    // bounded so a large diff can't exceed the OS exec arg-size limit.
    const prompt = `${reviewPrompt}\n\nThe diff under review is provided via stdin.`;
    const result = await this.#spawn(
      GEMINI_BIN,
      ['-p', prompt, '--approval-mode=yolo'],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        host: 'gemini',
        stdinPayload: diff,
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

  // /review N1: detectVersion uses process.cwd() because `gemini --version`
  // does not depend on the working directory (no config-file resolution).
  // Other spawn calls use opts.cwd because their behaviour DOES depend on
  // cwd (file reads, sandbox pin). The asymmetry is intentional, not drift.
  async detectVersion(): Promise<string> {
    const result = await this.#spawn(GEMINI_BIN, ['--version'], {
      cwd: process.cwd(),
      timeoutMs: HEALTH_TIMEOUT_MS,
      host: 'gemini',
    });
    return result.stdout.trim();
  }
}

// /review I4: the `npx @google/gemini-cli` auto-fallback was removed.
// Auto-fetching a pre-1.0 package from npm at runtime on every dispatch
// was a supply-chain surface — a malicious or breaking publish would
// land in adopter sessions without any pinning. Adopters who want a
// non-PATH install can alias themselves:
//   alias gemini='npx -y @google/gemini-cli@<pinned-version>'
// or install globally: `npm i -g @google/gemini-cli`. If `gemini` is
// not on PATH, dispatchSubagent / runReview / healthCheck surface
// BINARY_NOT_FOUND with an actionable install hint from spawnSubprocess.
