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

import { ClaudeHarness, type ClaudeSpawnSubagent } from './claude.ts';
import { CodexHarness } from './codex.ts';
import { GeminiHarness } from './gemini.ts';
import { HarnessError, type HarnessHost, type IHarness } from './base.ts';
import type { SpawnSubprocess } from './subprocess.ts';

export interface CreateHarnessOpts {
  readonly spawnSubagent?: ClaudeSpawnSubagent;
  readonly spawnSubprocess?: SpawnSubprocess;
  readonly env?: NodeJS.ProcessEnv;
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
  }
}
