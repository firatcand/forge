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
}

export class ClaudeHarness implements IHarness {
  readonly host = 'claude' as const;
  readonly #spawnSubagent: ClaudeSpawnSubagent;

  constructor(opts: ClaudeHarnessOpts) {
    if (!opts || typeof opts.spawnSubagent !== 'function') {
      throw new HarnessError(
        'CALLBACK_MISSING',
        'claude',
        'ClaudeHarness requires a spawnSubagent callback. Provide one from the hosting Claude Code skill — TypeScript cannot call the Task tool primitive directly.',
      );
    }
    this.#spawnSubagent = opts.spawnSubagent;
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

  async healthCheck(): Promise<HealthResult> {
    return { ok: true, version: 'in-session' };
  }

  async detectVersion(): Promise<string> {
    return 'in-session';
  }
}
