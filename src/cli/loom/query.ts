// FORGE-227: `forge loom query` — ad-hoc node lookup by id / kind / title.
//
// Soft-fails (ok + empty) when the db is missing so it never crashes on a fresh
// repo; a db that exists but cannot be opened (corrupt) fails loud. At least one
// filter is required (enforced in the dispatcher).

import { emit, fail, ok } from '../envelope.ts';
import type { QueryFilter } from '../../memory/types.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

export interface QueryHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
  readonly filter: QueryFilter;
}

export async function runLoomQuery(args: QueryHandlerArgs): Promise<{ exitCode: number }> {
  if (!(await dbExists(args.ctx))) {
    return {
      exitCode: emit(
        ok({
          nodes: [],
          db_path: args.ctx.location,
          warnings: [
            ...args.ctx.warnings,
            `no loom graph at ${args.ctx.location} — run \`forge loom reindex --scope all\` first; returning no nodes`,
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
          `loom query: could not open loom.db at ${args.ctx.location}: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const nodes = await backend.query(args.filter);
    return {
      exitCode: emit(
        ok({ nodes, db_path: args.ctx.location, warnings: args.ctx.warnings }),
        { json: args.json },
      ),
    };
  } catch (err) {
    // A corrupt node row (bad attrs JSON / unknown kind / over-bound field)
    // fails loud rather than silently dropping rows.
    return {
      exitCode: emit(
        fail(
          'LOOM_QUERY_FAILED',
          `loom query: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    await backend.close();
  }
}
