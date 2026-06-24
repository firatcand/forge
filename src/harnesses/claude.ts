import {
  HarnessError,
  type DispatchOpts,
  type HealthResult,
  type IHarness,
  type ReviewVerdict,
  type SubagentHandle,
} from './base.ts';
import { spawnSubprocess, type SpawnSubprocess } from './subprocess.ts';
import { parseHarnessVerdict } from './verdict-parser.ts';

export type ClaudeSpawnSubagent = (
  renderedPrompt: string,
  opts: DispatchOpts,
) => Promise<SubagentHandle>;

export interface ClaudeHarnessOpts {
  // Optional as of FORGE-223: a review-only ClaudeHarness (runReview via the
  // `claude -p` subprocess) needs no in-session callback. The dispatch path
  // still requires it — enforced at call time in dispatchSubagent, not the ctor.
  readonly spawnSubagent?: ClaudeSpawnSubagent;
  // FORGE-223: subprocess spawner for runReview. Defaults to the real
  // spawnSubprocess; tests inject a fake (mirrors CodexHarness).
  readonly spawnSubprocess?: SpawnSubprocess;
  // /review N3: pass `env` (defaults to process.env) so healthCheck can
  // detect whether the harness is actually running inside a Claude Code
  // session. Lets tests inject `env: { CLAUDE_CODE: '1' }` without
  // mutating real process.env. NOTE: this is the *healthCheck* env only —
  // runReview deliberately forwards DispatchOpts.env (see below), never this.
  readonly env?: NodeJS.ProcessEnv;
}

const CC_SESSION_ENV = 'CLAUDE_CODE';
const CLAUDE_BIN = 'claude';

export class ClaudeHarness implements IHarness {
  readonly host = 'claude' as const;
  readonly #spawnSubagent: ClaudeSpawnSubagent | undefined;
  readonly #spawn: SpawnSubprocess;
  readonly #env: NodeJS.ProcessEnv;

  constructor(opts: ClaudeHarnessOpts = {}) {
    this.#spawnSubagent = opts.spawnSubagent;
    this.#spawn = opts.spawnSubprocess ?? spawnSubprocess;
    this.#env = opts.env ?? process.env;
  }

  async dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle> {
    // FORGE-223: dispatch still requires an in-session callback — TypeScript
    // cannot call the Task tool primitive directly. Validate at call time
    // (the ctor no longer does) and surface a typed CALLBACK_MISSING rather
    // than a raw TypeError when it is absent or not a function.
    if (typeof this.#spawnSubagent !== 'function') {
      throw new HarnessError(
        'CALLBACK_MISSING',
        'claude',
        'ClaudeHarness.dispatchSubagent requires a spawnSubagent callback. Provide one from the hosting Claude Code skill — TypeScript cannot call the Task tool primitive directly.',
      );
    }
    return this.#spawnSubagent(renderedPrompt, opts);
  }

  // FORGE-223: Claude as a second-opinion reviewer via a non-interactive
  // `claude -p` subprocess (NOT the in-session Task tool — review needs no
  // session). Mirrors CodexHarness.runReview:
  //   - diff via stdin (FORGE-166): a large diff in argv blows the OS exec
  //     arg-size limit (SPAWN_FAILED). `claude -p "<prompt>"` with piped stdin
  //     feeds BOTH the argv prompt and the stdin content to the model.
  //   - prompt LAST in argv: matches `claude --help`'s positional [prompt] and
  //     subprocess.ts argsExcerpt's "last arg is the prompt" redaction.
  //   - no permission/tool flags (per FORGE-223 AC): review is read-only
  //     analysis, so default permission behavior is fine; the subprocess
  //     kill-timeout is the backstop if a model ever tries an approval-gated tool.
  async runReview(
    diff: string,
    reviewPrompt: string,
    opts: DispatchOpts,
  ): Promise<ReviewVerdict> {
    const prompt = `${reviewPrompt}\n\nThe diff under review is provided via stdin.`;
    const result = await this.#spawn(
      CLAUDE_BIN,
      ['-p', '--output-format', 'text', '--no-session-persistence', prompt],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        // FORGE-223 (Codex review H1): forward DispatchOpts.env ONLY — never the
        // ctor #env (which defaults to process.env). subprocess.ts merges any
        // provided env wholesale and only applies the SAFE_ENV_KEYS allowlist
        // when env is undefined; passing process.env here would re-leak
        // ANTHROPIC_API_KEY / tracker tokens into the review subprocess.
        env: opts.env,
        host: 'claude',
        stdinPayload: diff,
      },
    );
    return parseHarnessVerdict({ host: 'claude', stdout: result.stdout });
  }

  // /review N3: previously returned { ok: true } unconditionally. Now
  // reports ok:false when not running inside a Claude Code session so
  // `forge orchestrate doctor` produces an accurate signal — the Task
  // tool primitive is only available inside CC.
  // FORGE-223: this signal reflects the DISPATCH path (in-session Task tool).
  // The review path (runReview) shells out to the `claude` binary and is NOT
  // gated by CLAUDE_CODE — doctor treats claude as a primary/dispatch host here.
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
