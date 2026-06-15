// FORGE-200 (Loom I1): the `forge loom <verb>` dispatcher.
//
// Mirrors the orchestrate dispatcher SHAPE (envelope, --json, --help usage,
// unknown verb → fail envelope) but simpler — three flat verbs, no nesting.
//
// NOTE on the lazy sqlite import (Codex B1): these handlers import the backend /
// factory / ingest modules NORMALLY. That is safe because `node:sqlite` is
// lazy-imported INSIDE db.ts:openDb() — importing this dispatcher (or its
// handlers, in tests / --help) loads ZERO sqlite until a verb actually opens the
// db. src/bin/forge.ts additionally dynamic-imports this module only inside the
// `command === 'loom'` branch, so non-loom invocations never touch loom code.

import { emit, fail } from '../envelope.ts';
import { hasFlag, parseFlag } from '../orchestrate/flags.ts';
import { resolveContext } from './context.ts';
import { runLoomReindex } from './reindex.ts';
import { runLoomRecall } from './recall.ts';
import { runLoomStatus } from './status.ts';

export interface LoomDispatcherOpts {
  readonly cwd: string;
}

export const LOOM_VERB_NAMES = ['reindex', 'recall', 'status'] as const;

export async function dispatchLoom(
  rest: readonly string[],
  opts: LoomDispatcherOpts,
): Promise<{ exitCode: number }> {
  const sub = rest[0];
  if (!sub) {
    process.stderr.write(usage());
    return { exitCode: 1 };
  }
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return { exitCode: 0 };
  }

  const json = hasFlag(rest, 'json');
  const verbArgs = rest.slice(1);

  switch (sub) {
    case 'reindex': {
      const ctx = resolveContext(opts.cwd);
      const scope = parseFlag(verbArgs, 'scope');
      return runLoomReindex({ ctx, json, ...(scope !== undefined ? { scope } : {}) });
    }
    case 'recall': {
      const ctx = resolveContext(opts.cwd);
      const task = parseFlag(verbArgs, 'task');
      const limit = parseLimit(verbArgs);
      if (limit instanceof Error) {
        return {
          exitCode: emit(fail('INVALID_ARGS', `loom recall: ${limit.message}`, false), { json }),
        };
      }
      return runLoomRecall({
        ctx,
        json,
        ...(task !== undefined ? { task } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    case 'status': {
      const ctx = resolveContext(opts.cwd);
      return runLoomStatus({ ctx, json });
    }
    default:
      return {
        exitCode: emit(
          fail(
            'UNKNOWN_VERB',
            `forge loom: unknown verb '${sub}'. Run \`forge loom --help\` for the list.`,
            false,
          ),
          { json },
        ),
      };
  }
}

// Parse --limit into a positive integer, or undefined if absent, or an Error on
// a malformed value (fail loudly — no silent fallback).
function parseLimit(args: readonly string[]): number | undefined | Error {
  const raw = parseFlag(args, 'limit');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return new Error(`--limit must be a positive integer (got '${raw}')`);
  }
  return n;
}

function usage(): string {
  return [
    'Usage: forge loom <verb> [options]',
    '',
    'Verbs:',
    '  reindex   Rebuild the local memory graph from plans/phases.yaml + docs/learnings/** (--scope all).',
    '  recall    Dependency-aware recall for a task (--task <id> [--limit <n>]); structural hits rank over FTS.',
    '  status    Node/edge counts + by-kind breakdown + db path.',
    '',
    'Flags:',
    '  --json    Emit a stable JSON envelope on stdout.',
    '  --task    (recall) Task id — phases id or tracker issue id.',
    '  --limit   (recall) Cap the number of hits.',
    '  --scope   (reindex) Source scope; I1 supports only "all".',
    '',
  ].join('\n') + '\n';
}
