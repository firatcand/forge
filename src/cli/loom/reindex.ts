// FORGE-200 (Loom I1): `forge loom reindex` — rebuild the local memory graph
// from plans/phases.yaml + docs/learnings/**.

import { emit, fail, ok } from '../envelope.ts';
import { reindex } from '../../memory/ingest.ts';
import { resolveBackend, type LoomContext } from './context.ts';

export interface ReindexHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
  // I1 ships only `--scope all`; any other value is accepted + ignored with a
  // warning (forward-compat with future scopes).
  readonly scope?: string;
}

export async function runLoomReindex(args: ReindexHandlerArgs): Promise<{ exitCode: number }> {
  const warnings: string[] = [];
  if (args.scope !== undefined && args.scope !== 'all') {
    warnings.push(`unknown --scope '${args.scope}' — I1 supports only 'all'; proceeding with 'all'`);
  }

  let backend;
  try {
    backend = await resolveBackend(args.ctx);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_DB_OPEN_FAILED',
          `loom reindex: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const result = await reindex({ repoRoot: args.ctx.repoRoot, backend });
    return {
      exitCode: emit(
        ok({
          scope: 'all',
          nodes: result.nodes,
          edges: result.edges,
          learning_nodes: result.learning_nodes,
          db_path: args.ctx.dbPath,
          warnings: [...warnings, ...result.warnings],
        }),
        { json: args.json },
      ),
    };
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_REINDEX_FAILED',
          `loom reindex: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    backend.close();
  }
}
