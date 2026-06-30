// FORGE-227: `forge loom traverse` — bounded reachable subgraph from a node.
//
// Soft-fails (ok + empty) when the db is missing; a corrupt db fails loud. The
// returned subgraph is node- and edge-capped; `truncated` flags that a cap hit.

import { emit, fail, ok } from '../envelope.ts';
import type { TraverseOptions } from '../../memory/types.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

export interface TraverseHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
  readonly node: string;
  readonly depth?: number;
  readonly limit?: number;
}

export async function runLoomTraverse(args: TraverseHandlerArgs): Promise<{ exitCode: number }> {
  if (!(await dbExists(args.ctx))) {
    return {
      exitCode: emit(
        ok({
          root: args.node,
          nodes: [],
          edges: [],
          truncated: false,
          db_path: args.ctx.location,
          warnings: [
            ...args.ctx.warnings,
            `no loom graph at ${args.ctx.location} — run \`forge loom reindex --scope all\` first; returning empty subgraph`,
          ],
        }),
        { json: args.json },
      ),
    };
  }

  let backend;
  try {
    backend = await resolveBackend(args.ctx);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_DB_CORRUPT',
          `loom traverse: could not open loom.db at ${args.ctx.location}: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const opts: TraverseOptions = {
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    };
    const sub = await backend.traverse(args.node, opts);
    const warnings = [...args.ctx.warnings];
    if (sub.nodes.length === 0) {
      warnings.push(`node '${args.node}' not found in loom.db; returning empty subgraph`);
    }
    return {
      exitCode: emit(
        ok({
          root: sub.root,
          nodes: sub.nodes,
          edges: sub.edges,
          truncated: sub.truncated,
          db_path: args.ctx.location,
          warnings,
        }),
        { json: args.json },
      ),
    };
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_TRAVERSE_FAILED',
          `loom traverse: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    await backend.close();
  }
}
