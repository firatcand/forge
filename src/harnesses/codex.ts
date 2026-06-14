import {
  isHarnessError,
  type DispatchOpts,
  type HealthResult,
  type IHarness,
  type ReviewVerdict,
  type SubagentHandle,
  type SubagentResult,
} from './base.ts';
import {
  spawnSubprocess,
  type SpawnSubprocess,
  type SpawnResult,
} from './subprocess.ts';
import { parseHarnessVerdict } from './verdict-parser.ts';

const CODEX_BIN = 'codex';
const HEALTH_TIMEOUT_MS = 5_000;

export interface CodexHarnessOpts {
  readonly spawnSubprocess?: SpawnSubprocess;
}

export class CodexHarness implements IHarness {
  readonly host = 'codex' as const;
  readonly #spawn: SpawnSubprocess;

  constructor(opts: CodexHarnessOpts = {}) {
    this.#spawn = opts.spawnSubprocess ?? spawnSubprocess;
  }

  async dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle> {
    // FORGE-210 (R7): when a routed model is supplied, inject `--model <id>`
    // BEFORE the rendered prompt (never after — codex treats the trailing
    // positional as the prompt). Absent → argv unchanged (back-compat).
    const args = opts.model
      ? ['exec', '--color', 'never', '--model', opts.model, renderedPrompt]
      : ['exec', '--color', 'never', renderedPrompt];
    const pending = this.#spawn(
      CODEX_BIN,
      args,
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        host: 'codex',
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
    // FORGE-166: pass the diff via stdin, NOT argv. Embedding a large diff in
    // the prompt argument blows the OS exec arg-size limit (SPAWN_FAILED).
    // codex appends piped stdin as a <stdin> block, so the reviewer still sees
    // the full diff. The argv prompt stays bounded (instructions only).
    const prompt = `${reviewPrompt}\n\nThe diff under review is provided via stdin (a <stdin> block).`;
    const result = await this.#spawn(
      CODEX_BIN,
      ['exec', '--color', 'never', prompt],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        host: 'codex',
        stdinPayload: diff,
      },
    );
    return parseHarnessVerdict({ host: 'codex', stdout: result.stdout });
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

  // /review N1: detectVersion uses process.cwd() because `codex --version`
  // does not depend on the working directory. Dispatch / review calls use
  // opts.cwd because their behaviour DOES depend on cwd (sandbox pin,
  // workspace-local config). The asymmetry is intentional.
  async detectVersion(): Promise<string> {
    const result = await this.#spawn(CODEX_BIN, ['--version'], {
      cwd: process.cwd(),
      timeoutMs: HEALTH_TIMEOUT_MS,
      host: 'codex',
    });
    return result.stdout.trim();
  }
}

export type SafeResult =
  | { ok: true; value: SpawnResult }
  | { ok: false; error: unknown };

export async function safe(p: Promise<SpawnResult>): Promise<SafeResult> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

export function classifyDispatch(r: SafeResult): SubagentResult {
  if (r.ok) {
    return {
      verdict: 'completed',
      exitCode: r.value.exitCode,
      durationMs: r.value.durationMs,
    };
  }
  if (isHarnessError(r.error) && r.error.code === 'TIMEOUT') {
    return { verdict: 'timeout', exitCode: -1, durationMs: 0 };
  }
  return { verdict: 'spawn_error', exitCode: -1, durationMs: 0 };
}
