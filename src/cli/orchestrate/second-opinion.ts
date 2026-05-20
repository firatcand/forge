// `forge orchestrate second-opinion` (FORGE-89 / P2-T21) — dispatch a
// second-opinion review through the IHarness adapter keyed off
// settings.review_host_cli. Sole boundary that knows about review_host_cli:
// the skill body is host-agnostic.
//
// Reads diff + prompt from files (skill writes them to /tmp), calls
// createHarness(review_host_cli).runReview(...), emits a JSON envelope with
// the ReviewVerdict.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';

// Caps for caller-supplied input files. Codex/gemini context windows are
// the harder limit downstream, but these caps catch obvious mistakes before
// burning a subprocess invocation. Precedent: MAX_STDOUT_BYTES in
// src/harnesses/subprocess.ts caps output; same shape for input.
export const MAX_DIFF_BYTES = 1_000_000;   // 1MB — typical diffs are <50KB
export const MAX_PROMPT_BYTES = 200_000;   // 200KB — six-piece briefs are <10KB

import {
  SecondOpinionArgsSchema,
  type SecondOpinionArgs,
} from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { loadSettings } from '../../core/settings.ts';
import {
  createHarness,
  isHarnessError,
  type HarnessHost,
  type IHarness,
  type ReviewVerdict,
  type SpawnSubprocess,
} from '../../harnesses/index.ts';
import { SettingsError } from '../../core/errors.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface SecondOpinionResult {
  readonly exitCode: number;
}

// Factory the verb uses to build the harness. The default delegates to the
// production createHarness, but tests inject a fake to avoid spawning real
// codex/gemini subprocesses (mirrors the spawnSubprocess injection pattern
// established in src/harnesses/codex.ts).
export type SecondOpinionHarnessFactory = (
  host: HarnessHost,
  spawnSubprocess?: SpawnSubprocess,
) => IHarness;

const defaultFactory: SecondOpinionHarnessFactory = (host, spawnSubprocess) => {
  if (host === 'claude') {
    throw new Error(
      `createHarness('claude') is not a reviewer — review_host_cli must be 'codex' or 'gemini'`,
    );
  }
  return createHarness(host, spawnSubprocess ? { spawnSubprocess } : {});
};

export interface RunSecondOpinionDeps {
  readonly factory?: SecondOpinionHarnessFactory;
  readonly spawnSubprocess?: SpawnSubprocess;
}

export async function runOrchestrateSecondOpinion(
  args: SecondOpinionArgs,
  deps: RunSecondOpinionDeps = {},
): Promise<SecondOpinionResult> {
  const parsed = SecondOpinionArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), {
        json: args.json,
      }),
    };
  }
  const opts = parsed.data;

  // Load settings to resolve review_host_cli. Failure modes:
  //   - SettingsError NOT_FOUND → adopter has no .forge/settings.yaml (running
  //     outside a forge project). Surface SETTINGS_NOT_FOUND.
  //   - SettingsError VALIDATION_ERROR → schema mismatch (e.g., gemini without
  //     FORGE_GEMINI_EXPERIMENTAL=1). Surface INVALID_SETTINGS with the zod issues.
  //   - SettingsError YAML_PARSE_ERROR → malformed yaml. Surface INVALID_SETTINGS.
  const settingsPath = path.join(opts.forgeDir, 'settings.yaml');
  let settings;
  try {
    settings = loadSettings(settingsPath);
  } catch (err) {
    if (err instanceof SettingsError) {
      const code = err.code === 'FILE_NOT_FOUND' ? 'SETTINGS_NOT_FOUND' : 'INVALID_SETTINGS';
      return {
        exitCode: emit(
          fail(code, err.message, false, { settingsPath, settingsCode: err.code }),
          { json: opts.json },
        ),
      };
    }
    throw err;
  }

  const reviewHost = settings.agents.review_host_cli;
  if (reviewHost === null) {
    return {
      exitCode: emit(
        fail(
          'REVIEW_DISABLED',
          `second-opinion review is disabled — settings.agents.review_host_cli is null at ${settingsPath}. Set it to 'codex' or 'gemini' to enable.`,
          false,
          { settingsPath },
        ),
        { json: opts.json },
      ),
    };
  }

  // Read diff + prompt files. Two separate reads so the failing input is
  // identified in the error envelope. Size check via stat() BEFORE readFileSync
  // so a 1GB file doesn't get pulled into memory just to be rejected.
  const diffResult = readBoundedFile(opts.diffPath, MAX_DIFF_BYTES, 'diff');
  if ('error' in diffResult) {
    return { exitCode: emit(diffResult.error, { json: opts.json }) };
  }
  const diff = diffResult.content;

  const promptResult = readBoundedFile(opts.promptPath, MAX_PROMPT_BYTES, 'prompt');
  if ('error' in promptResult) {
    return { exitCode: emit(promptResult.error, { json: opts.json }) };
  }
  const prompt = promptResult.content;

  // Build the harness. Tests inject a factory; production uses createHarness.
  const factory = deps.factory ?? defaultFactory;
  let harness: IHarness;
  try {
    harness = factory(reviewHost, deps.spawnSubprocess);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'HARNESS_INIT_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { reviewHost },
        ),
        { json: opts.json },
      ),
    };
  }

  // cwd defaults to forgeDir's parent (the worktree itself); subprocess
  // behaviour depends on cwd (sandbox pin for codex, --cwd for gemini).
  const cwd = opts.cwd ?? path.dirname(opts.forgeDir);
  const attemptId = uuidv7();

  let verdict: ReviewVerdict;
  try {
    verdict = await harness.runReview(diff, prompt, {
      cwd,
      taskId: opts.taskId,
      attemptId,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    if (isHarnessError(err)) {
      // Map the harness's error codes through to the envelope so callers can
      // distinguish BINARY_NOT_FOUND / TIMEOUT / INVALID_STDOUT etc. without
      // string-matching messages.
      const retriable = err.code === 'TIMEOUT' || err.code === 'SPAWN_FAILED';
      return {
        exitCode: emit(
          fail(err.code, err.message, retriable, {
            host: err.host,
            ...err.details,
          }),
          { json: opts.json },
        ),
      };
    }
    return {
      exitCode: emit(
        fail(
          'REVIEW_FAILED',
          err instanceof Error ? err.message : String(err),
          false,
          { reviewHost },
        ),
        { json: opts.json },
      ),
    };
  }

  return {
    exitCode: emit(
      ok({
        host: reviewHost,
        task_id: opts.taskId,
        attempt_id: attemptId,
        verdict,
      }),
      { json: opts.json },
    ),
  };
}

// Read a caller-supplied input file with an upfront size check via stat().
// Returns either `{ content }` on success or `{ error: Envelope }` so the
// caller can early-return through emit() without duplicating envelope plumbing.
function readBoundedFile(
  filePath: string,
  maxBytes: number,
  kind: 'diff' | 'prompt',
): { content: string } | { error: ReturnType<typeof fail> } {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    return {
      error: fail(
        'MISSING_INPUT',
        `failed to stat ${kind} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { [`${kind}Path`]: filePath },
      ),
    };
  }
  if (size > maxBytes) {
    return {
      error: fail(
        kind === 'diff' ? 'DIFF_TOO_LARGE' : 'PROMPT_TOO_LARGE',
        `${kind} at ${filePath} is ${size} bytes; max is ${maxBytes}. Narrow the input or split into multiple reviews.`,
        false,
        { [`${kind}Path`]: filePath, size, max: maxBytes },
      ),
    };
  }
  try {
    return { content: readFileSync(filePath, 'utf8') };
  } catch (err) {
    return {
      error: fail(
        'MISSING_INPUT',
        `failed to read ${kind} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        false,
        { [`${kind}Path`]: filePath },
      ),
    };
  }
}

export const secondOpinionHandler: VerbHandler = {
  band: 'mutate',
  synopsis:
    'Dispatch a second-opinion review through review_host_cli (codex | gemini); emits a ReviewVerdict envelope.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? '';
    const diffPath = parseFlag(rest, 'diff') ?? '';
    const promptPath = parseFlag(rest, 'prompt') ?? '';
    const cwd = parseFlag(rest, 'cwd');
    const timeoutRaw = parseFlag(rest, 'timeout-ms');
    const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
    const json = hasFlag(rest, 'json');
    return runOrchestrateSecondOpinion({
      taskId,
      diffPath,
      promptPath,
      forgeDir,
      json,
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs !== undefined && !Number.isNaN(timeoutMs) ? { timeoutMs } : {}),
    });
  },
};
