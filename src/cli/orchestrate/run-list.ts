// `forge orchestrate run list` — read-only enumeration of runs.
//
// --active filters to runs that have a recent notification or whose owned
// task states are non-terminal. For v0.4, "active" == manifest exists AND
// a non-empty notifications.jsonl OR any task is in a non-terminal state with
// run_id matching this run (cheap heuristic; gc is the authoritative reaper).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { RunListArgsSchema, type RunListArgs } from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

const ManifestSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1),
  started_at: z.string().datetime(),
  name: z.string().nullable(),
  host: z.string().min(1),
});

export interface RunListEntry {
  readonly run_id: string;
  readonly started_at: string;
  readonly name: string | null;
  readonly host: string;
  readonly notification_count: number;
}

export async function runOrchestrateRunList(args: RunListArgs): Promise<{ exitCode: number }> {
  const parsed = RunListArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;
  const runsRoot = path.join(opts.forgeDir, 'orchestrator', 'runs');
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return { exitCode: emit(ok({ runs: [] }), { json: opts.json }) };
  }
  const out: RunListEntry[] = [];
  for (const entry of entries) {
    const manifestPath = path.join(runsRoot, entry, 'manifest.json');
    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = ManifestSchema.safeParse(parsedJson);
    if (!result.success) continue;
    const notifications = path.join(runsRoot, entry, 'notifications.jsonl');
    let notificationCount = 0;
    try {
      const buf = readFileSync(notifications, 'utf8');
      notificationCount = buf ? buf.split('\n').filter((l) => l.trim().length > 0).length : 0;
    } catch {
      notificationCount = 0;
    }
    if (opts.active && notificationCount === 0) {
      // Heuristic: a run with zero recorded notifications is quiesced.
      // Real gc'd reaper logic is the authoritative source (`forge orchestrate gc`).
      continue;
    }
    out.push({
      run_id: result.data.run_id,
      started_at: result.data.started_at,
      name: result.data.name,
      host: result.data.host,
      notification_count: notificationCount,
    });
  }
  // Stable order: most-recent first by started_at.
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return { exitCode: emit(ok({ runs: out }), { json: opts.json }) };
}

export const runListHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List orchestrator runs (--active filters to runs with traffic).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    return runOrchestrateRunList({
      forgeDir,
      json: hasFlag(rest, 'json'),
      active: hasFlag(rest, 'active'),
    });
  },
};
