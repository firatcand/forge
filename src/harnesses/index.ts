export * from './base.ts';
export {
  spawnSubprocess,
  DEFAULT_TIMEOUT_MS,
  MAX_STDOUT_BYTES,
  type SpawnOpts,
  type SpawnResult,
  type SpawnSubprocess,
} from './subprocess.ts';
export {
  parseHarnessVerdict,
  synthesizeVerdict,
  type ParseOpts,
  type ReviewableHost,
} from './verdict-parser.ts';
export {
  ClaudeHarness,
  type ClaudeHarnessOpts,
  type ClaudeSpawnSubagent,
} from './claude.ts';
export { CodexHarness, type CodexHarnessOpts } from './codex.ts';
export { GeminiHarness, type GeminiHarnessOpts } from './gemini.ts';
export { CursorHarness, type CursorHarnessOpts } from './cursor.ts';

import { ClaudeHarness, type ClaudeSpawnSubagent } from './claude.ts';
import { CodexHarness } from './codex.ts';
import { GeminiHarness } from './gemini.ts';
import { CursorHarness } from './cursor.ts';
import { HarnessError, type HarnessHost, type IHarness } from './base.ts';
import type { SpawnSubprocess } from './subprocess.ts';

export interface CreateHarnessOpts {
  readonly spawnSubagent?: ClaudeSpawnSubagent;
  readonly spawnSubprocess?: SpawnSubprocess;
  readonly env?: NodeJS.ProcessEnv;
  // FORGE-160: explicit beta gate for the cursor host, threaded from loaded
  // settings (agents.cursor_host_beta_opt_in) AT THE CALL SITE. The factory must
  // not read settings globally; cursor without `cursorBetaOptIn: true` throws a
  // typed EXPERIMENTAL_GATE_CLOSED naming the flag (defense in depth with the
  // schema refine). Ignored for non-cursor hosts.
  readonly cursorBetaOptIn?: boolean;
}

export function createHarness(
  host: HarnessHost,
  opts: CreateHarnessOpts = {},
): IHarness {
  switch (host) {
    case 'claude':
      if (!opts.spawnSubagent) {
        // /review B2: typed error so isHarnessError() narrows correctly
        // across the entire harness boundary; matches the message of the
        // ClaudeHarness ctor itself, which throws the same code when an
        // adopter constructs ClaudeHarness directly without a callback.
        throw new HarnessError(
          'CALLBACK_MISSING',
          'claude',
          'createHarness("claude") requires opts.spawnSubagent — see ClaudeHarness docstring.',
        );
      }
      return new ClaudeHarness({
        spawnSubagent: opts.spawnSubagent,
        env: opts.env,
      });
    case 'codex':
      return new CodexHarness({ spawnSubprocess: opts.spawnSubprocess });
    case 'gemini':
      return new GeminiHarness({
        spawnSubprocess: opts.spawnSubprocess,
        env: opts.env,
      });
    case 'cursor':
      // The CursorHarness ctor also enforces the gate; the factory passes the
      // call-site opt-in through. When false/undefined the ctor throws
      // EXPERIMENTAL_GATE_CLOSED naming agents.cursor_host_beta_opt_in.
      return new CursorHarness({
        spawnSubprocess: opts.spawnSubprocess,
        env: opts.env,
        betaOptIn: opts.cursorBetaOptIn === true,
      });
  }
}
