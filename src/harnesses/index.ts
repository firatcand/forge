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
import type { HarnessHost, IHarness } from './base.ts';
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
        throw new Error(
          'createHarness("claude") requires opts.spawnSubagent — see ClaudeHarness docstring.',
        );
      }
      return new ClaudeHarness({ spawnSubagent: opts.spawnSubagent });
    case 'codex':
      return new CodexHarness({ spawnSubprocess: opts.spawnSubprocess });
    case 'gemini':
      return new GeminiHarness({
        spawnSubprocess: opts.spawnSubprocess,
        env: opts.env,
      });
  }
}
