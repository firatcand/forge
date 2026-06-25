// FORGE-200 (Loom I1): `forge loom status` — node/edge counts + by_kind + db_path.
//
// Missing db → ok with zeroes + a note (honest zero output; never crashes). A
// db that exists but cannot be opened (corrupt) fails loud.

import { emit, fail, ok } from '../envelope.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

export interface StatusHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
}

export async function runLoomStatus(args: StatusHandlerArgs): Promise<{ exitCode: number }> {
  if (!dbExists(args.ctx)) {
    return {
      exitCode: emit(
        ok({
          node_count: 0,
          edge_count: 0,
          // Explicit zero for all kinds (honest zero output; file added in I2a,
          // symbol in I2b-1, decision in I3).
          by_kind: { task: 0, learning: 0, file: 0, symbol: 0, decision: 0 },
          db_path: args.ctx.dbPath,
          warnings: [
            ...args.ctx.warnings,
            `no loom.db at ${args.ctx.dbPath} — run \`forge loom reindex --scope all\` to build it`,
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
          `loom status: could not open loom.db at ${args.ctx.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const status = backend.status();
    return {
      exitCode: emit(
        ok({
          node_count: status.node_count,
          edge_count: status.edge_count,
          // status() already guarantees explicit task+learning keys.
          by_kind: status.by_kind,
          db_path: status.db_path,
          warnings: args.ctx.warnings,
        }),
        { json: args.json },
      ),
    };
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_STATUS_FAILED',
          `loom status: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    backend.close();
  }
}
