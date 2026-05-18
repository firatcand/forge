import {
  HarnessError,
  notSupported,
  type DispatchOpts,
  type HealthResult,
  type IHarness,
  type ReviewVerdict,
  type SubagentHandle,
} from './base.ts';

export type ClaudeSpawnSubagent = (
  renderedPrompt: string,
  opts: DispatchOpts,
) => Promise<SubagentHandle>;

export interface ClaudeHarnessOpts {
  readonly spawnSubagent: ClaudeSpawnSubagent;
  // /review N3: pass `env` (defaults to process.env) so healthCheck can
  // detect whether the harness is actually running inside a Claude Code
  // session. Lets tests inject `env: { CLAUDE_CODE: '1' }` without
  // mutating real process.env.
  readonly env?: NodeJS.ProcessEnv;
}

const CC_SESSION_ENV = 'CLAUDE_CODE';

export class ClaudeHarness implements IHarness {
  readonly host = 'claude' as const;
  readonly #spawnSubagent: ClaudeSpawnSubagent;
  readonly #env: NodeJS.ProcessEnv;

  constructor(opts: ClaudeHarnessOpts) {
    if (!opts || typeof opts.spawnSubagent !== 'function') {
      throw new HarnessError(
        'CALLBACK_MISSING',
        'claude',
        'ClaudeHarness requires a spawnSubagent callback. Provide one from the hosting Claude Code skill — TypeScript cannot call the Task tool primitive directly.',
      );
    }
    this.#spawnSubagent = opts.spawnSubagent;
    this.#env = opts.env ?? process.env;
  }

  dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle> {
    return this.#spawnSubagent(renderedPrompt, opts);
  }

  async runReview(
    _diff: string,
    _reviewPrompt: string,
    _opts: DispatchOpts,
  ): Promise<ReviewVerdict> {
    throw notSupported('claude', 'runReview');
  }

  // /review N3: previously returned { ok: true } unconditionally. Now
  // reports ok:false when not running inside a Claude Code session so
  // `forge orchestrate doctor` produces an accurate signal — the Task
  // tool primitive is only available inside CC.
  async healthCheck(): Promise<HealthResult> {
    if (this.#env[CC_SESSION_ENV]) {
      return { ok: true, version: 'in-session' };
    }
    return {
      ok: false,
      message: `ClaudeHarness requires running inside a Claude Code session (process.env.${CC_SESSION_ENV} is unset). Set primary_host_cli to codex or gemini in .forge/settings.yaml when running outside CC.`,
    };
  }

  async detectVersion(): Promise<string> {
    return 'in-session';
  }
}
