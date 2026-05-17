// `forge orchestrate run start` — create a new orchestrator run.
//
// A run is a single supervisor session — one main Claude Code or Codex window.
// Each session calls this once at boot. Run state is metadata only:
//   .forge/orchestrator/runs/<run_id>/manifest.json
//   .forge/orchestrator/runs/<run_id>/notifications.jsonl (empty)
//
// User approval source: invocation of /forge-orchestrate is implicit approval.

import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { RunStartArgsSchema, type RunStartArgs } from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface RunManifest {
  readonly version: 1;
  readonly run_id: string;
  readonly started_at: string;
  readonly name: string | null;
  readonly host: string;
}

export async function runOrchestrateRunStart(
  args: RunStartArgs,
): Promise<{ exitCode: number }> {
  const parsed = RunStartArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  const runId = uuidv7();
  const runDir = path.join(opts.forgeDir, 'orchestrator', 'runs', runId);
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to create run dir: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }
  const manifest: RunManifest = {
    version: 1,
    run_id: runId,
    started_at: new Date().toISOString(),
    name: opts.name ?? null,
    host: resolveHostFromEnv(),
  };
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to write manifest: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }
  // Touch notifications.jsonl so attach can tail immediately.
  const notifPath = path.join(runDir, 'notifications.jsonl');
  try {
    const fd = openSync(notifPath, 'a');
    closeSync(fd);
  } catch {
    /* best-effort */
  }
  return { exitCode: emit(ok({ run_id: runId, manifest_path: manifestPath }), { json: opts.json }) };
}

function resolveHostFromEnv(): string {
  // Best-effort host detection. Each adopter host sets a discriminator env var.
  if (process.env.CLAUDE_CODE) return 'claude-code';
  if (process.env.CURSOR) return 'cursor';
  if (process.env.CODEX_CLI) return 'codex-cli';
  if (process.env.GEMINI_CLI) return 'gemini-cli';
  return process.env.FORGE_HOST ?? 'unknown';
}

export const runStartHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Start a new orchestrator run (writes runs/<id>/manifest.json).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const name = parseFlag(rest, 'name');
    const json = hasFlag(rest, 'json');
    return runOrchestrateRunStart({ forgeDir, json, ...(name ? { name } : {}) });
  },
};
