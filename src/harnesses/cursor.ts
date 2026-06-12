// FORGE-160: CursorHarness — subprocess-backed primary dispatch via the beta
// Cursor CLI (`agent -p --force --output-format json <prompt>`, CURSOR_API_KEY
// auth passthrough). Modeled on CodexHarness (subprocess shape) but PRIMARY-ONLY:
// runReview throws NOT_SUPPORTED (review hosts remain codex | gemini).
//
// Beta gate (defense in depth with the schema refine in src/schemas/settings.ts):
// the ctor throws EXPERIMENTAL_GATE_CLOSED unless `betaOptIn: true` is passed.
// createHarness threads this from loaded settings (agents.cursor_host_beta_opt_in)
// at the call site — the factory does NOT read settings globally.
//
// Tests are MOCK-DRIVEN ONLY: a live `cursor`/`agent` CLI is never invoked. The
// subprocess seam (opts.spawnSubprocess) lets conformance/arg-shape tests pin a
// fake spawn.

import {
  HarnessError,
  isHarnessError,
  notSupported,
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
import { classifyDispatch, safe } from './codex.ts';

// The Cursor CLI's headless binary. The print-mode invocation is
// `agent -p --force --output-format json "<prompt>"` per cursor.com/docs
// (retrieved 2026-06-12; the CLI is beta and the binary name may stabilize to
// `cursor-agent` — kept as a single const so a rename is one edit).
const CURSOR_BIN = 'agent';
const HEALTH_TIMEOUT_MS = 5_000;
const BETA_FLAG = 'agents.cursor_host_beta_opt_in';

export interface CursorHarnessOpts {
  readonly spawnSubprocess?: SpawnSubprocess;
  readonly env?: NodeJS.ProcessEnv;
  /** Beta opt-in (agents.cursor_host_beta_opt_in). Required — ctor throws otherwise. */
  readonly betaOptIn?: boolean;
}

export class CursorHarness implements IHarness {
  readonly host = 'cursor' as const;
  readonly #spawn: SpawnSubprocess;
  readonly #env: NodeJS.ProcessEnv;

  constructor(opts: CursorHarnessOpts = {}) {
    if (opts.betaOptIn !== true) {
      throw new HarnessError(
        'EXPERIMENTAL_GATE_CLOSED',
        'cursor',
        `CursorHarness is beta. Set ${BETA_FLAG}: true in .forge/settings.yaml to opt in. The Cursor CLI is beta (security safeguards still evolving).`,
      );
    }
    this.#spawn = opts.spawnSubprocess ?? spawnSubprocess;
    this.#env = opts.env ?? process.env;
  }

  async dispatchSubagent(
    renderedPrompt: string,
    opts: DispatchOpts,
  ): Promise<SubagentHandle> {
    // CURSOR_API_KEY auth passthrough: merge the harness env's key into the
    // dispatch env so the spawned CLI authenticates. opts.env (the caller's
    // safe allowlist) wins when it already carries the key.
    const env = this.#mergeApiKey(opts.env);
    const pending = this.#spawn(
      CURSOR_BIN,
      ['-p', '--force', '--output-format', 'json', renderedPrompt],
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        ...(env ? { env } : {}),
        host: 'cursor',
      },
    );

    return {
      taskId: opts.taskId,
      attemptId: opts.attemptId,
      wait: async () => classifyDispatch(await safe(pending)),
    };
  }

  async runReview(
    _diff: string,
    _reviewPrompt: string,
    _opts: DispatchOpts,
  ): Promise<ReviewVerdict> {
    // Review hosts remain codex | gemini — cursor is primary-only.
    throw notSupported('cursor', 'runReview');
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
    const result = await this.#spawn(CURSOR_BIN, ['--version'], {
      cwd: process.cwd(),
      timeoutMs: HEALTH_TIMEOUT_MS,
      host: 'cursor',
    });
    return result.stdout.trim();
  }

  /** Merge CURSOR_API_KEY from the harness env into the dispatch env if present. */
  #mergeApiKey(
    callerEnv: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> | undefined {
    const key = this.#env.CURSOR_API_KEY;
    if (!key) return callerEnv ? { ...callerEnv } : undefined;
    return { CURSOR_API_KEY: key, ...(callerEnv ?? {}) };
  }
}
