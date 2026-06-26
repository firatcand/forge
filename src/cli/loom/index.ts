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

import {
  NODE_KINDS,
  MEMORY_ID_MAX_LEN,
  MEMORY_TITLE_MAX_LEN,
  type NodeKind,
} from '../../schemas/memory.ts';
import type { QueryFilter } from '../../memory/types.ts';
import { emit, fail } from '../envelope.ts';
import { hasFlag, parseFlag } from '../orchestrate/flags.ts';
import { parseValuedFlag, parsePositiveInt } from './args.ts';
import { resolveContext } from './context.ts';
import { runLoomReindex } from './reindex.ts';
import { runLoomRecall } from './recall.ts';
import { runLoomStatus } from './status.ts';
import { runLoomQuery } from './query.ts';
import { runLoomTraverse } from './traverse.ts';
import { runLoomDoctor } from './doctor.ts';

export interface LoomDispatcherOpts {
  readonly cwd: string;
}

export const LOOM_VERB_NAMES = ['reindex', 'recall', 'status', 'query', 'traverse', 'doctor'] as const;

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
    case 'query': {
      const id = parseValuedFlag(verbArgs, 'id');
      const kindRaw = parseValuedFlag(verbArgs, 'kind');
      const title = parseValuedFlag(verbArgs, 'title');
      const limit = parsePositiveInt(verbArgs, 'limit');
      for (const [name, v] of [
        ['id', id],
        ['kind', kindRaw],
        ['title', title],
        ['limit', limit],
      ] as const) {
        if (v instanceof Error) return invalidArgs('query', `--${name}: ${v.message}`, json);
      }
      const idVal = id as string | undefined;
      const kindVal = kindRaw as string | undefined;
      const titleVal = title as string | undefined;
      const limitVal = limit as number | undefined;
      if (idVal === undefined && kindVal === undefined && titleVal === undefined) {
        return invalidArgs('query', 'at least one of --id / --kind / --title is required', json);
      }
      if (idVal !== undefined && idVal.length > MEMORY_ID_MAX_LEN) {
        return invalidArgs('query', `--id exceeds ${MEMORY_ID_MAX_LEN} chars`, json);
      }
      if (titleVal !== undefined && titleVal.length > MEMORY_TITLE_MAX_LEN) {
        return invalidArgs('query', `--title exceeds ${MEMORY_TITLE_MAX_LEN} chars`, json);
      }
      if (kindVal !== undefined && !(NODE_KINDS as readonly string[]).includes(kindVal)) {
        return invalidArgs('query', `--kind must be one of ${NODE_KINDS.join('|')}`, json);
      }
      const filter: QueryFilter = {
        ...(idVal !== undefined ? { id: idVal } : {}),
        ...(kindVal !== undefined ? { kind: kindVal as NodeKind } : {}),
        ...(titleVal !== undefined ? { title: titleVal } : {}),
        ...(limitVal !== undefined ? { limit: limitVal } : {}),
      };
      const ctx = resolveContext(opts.cwd);
      return runLoomQuery({ ctx, json, filter });
    }
    case 'traverse': {
      const node = parseValuedFlag(verbArgs, 'node');
      const depth = parsePositiveInt(verbArgs, 'depth');
      const limit = parsePositiveInt(verbArgs, 'limit');
      if (node instanceof Error) return invalidArgs('traverse', `--node: ${node.message}`, json);
      if (depth instanceof Error) return invalidArgs('traverse', `--depth: ${depth.message}`, json);
      if (limit instanceof Error) return invalidArgs('traverse', `--limit: ${limit.message}`, json);
      if (node === undefined) return invalidArgs('traverse', '--node <id> is required', json);
      if (node.length > MEMORY_ID_MAX_LEN) {
        return invalidArgs('traverse', `--node exceeds ${MEMORY_ID_MAX_LEN} chars`, json);
      }
      const ctx = resolveContext(opts.cwd);
      return runLoomTraverse({
        ctx,
        json,
        node,
        ...(depth !== undefined ? { depth } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }
    case 'doctor': {
      const ctx = resolveContext(opts.cwd);
      return runLoomDoctor({ ctx, json });
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

// Shared INVALID_ARGS emitter for the verb dispatch cases (FORGE-227).
function invalidArgs(verb: string, msg: string, json: boolean): { exitCode: number } {
  return { exitCode: emit(fail('INVALID_ARGS', `loom ${verb}: ${msg}`, false), { json }) };
}

function usage(): string {
  return [
    'Usage: forge loom <verb> [options]',
    '',
    'Verbs:',
    '  reindex   Rebuild the local memory graph from plans/phases.yaml + docs/learnings/** (--scope all).',
    '  recall    Dependency-aware recall for a task (--task <id> [--limit <n>]); structural hits rank over FTS.',
    '  status    Node/edge counts + by-kind breakdown + db path.',
    '  query     Look up nodes by --id / --kind / --title substring (>=1 required) [--limit <n>].',
    '  traverse  Reachable subgraph from --node <id> over edges both ways [--depth <n>] [--limit <n>].',
    '  doctor    Graph health: orphan edges, isolated nodes, stale FTS rows, invalid rows (exit 2 if any).',
    '',
    'Flags:',
    '  --json    Emit a stable JSON envelope on stdout.',
    '  --task    (recall) Task id — phases id or tracker issue id.',
    '  --limit   (recall/query/traverse) Cap the number of hits/nodes.',
    '  --scope   (reindex) Source scope; I1 supports only "all".',
    '  --id      (query) Exact node id.',
    '  --kind    (query) Node kind: task|learning|file|symbol|decision.',
    '  --title   (query) Case-insensitive title substring (literal; wildcards escaped).',
    '  --node    (traverse) Root node id.',
    '  --depth   (traverse) Max hops out from the root (default 2).',
    '',
  ].join('\n') + '\n';
}
