// FORGE-200 (Loom I1): `forge loom recall --task <id>` — dependency-aware recall.
//
// Soft-fails when the db is missing/empty (emits ok with empty hits + a warning)
// so /pickup-task never crashes on a fresh repo. A CORRUPT db fails loud.

import { emit, fail, ok } from '../envelope.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

export interface RecallHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
  readonly task?: string;
  readonly limit?: number;
}

export async function runLoomRecall(args: RecallHandlerArgs): Promise<{ exitCode: number }> {
  if (!args.task || args.task.length === 0) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', 'loom recall: --task <id> is required.', false),
        { json: args.json },
      ),
    };
  }

  // Soft-fail: no db yet (never reindexed) → empty hits + a warning, exit 0.
  if (!(await dbExists(args.ctx))) {
    return {
      exitCode: emit(
        ok({
          task: args.task,
          hits: [],
          learning_nodes: 0,
          db_path: args.ctx.location,
          warnings: [
            ...args.ctx.warnings,
            `no loom graph at ${args.ctx.location} — run \`forge loom reindex --scope all\` first; returning empty recall`,
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
    // A db that exists but cannot be opened/initialized is corrupt → fail loud.
    return {
      exitCode: emit(
        fail(
          'LOOM_DB_CORRUPT',
          `loom recall: could not open loom.db at ${args.ctx.location}: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const status = await backend.status();
    const hits = await backend.recallForTask(args.task, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    const warnings = [...args.ctx.warnings];
    if (status.node_count === 0) {
      warnings.push('loom.db is empty — run `forge loom reindex --scope all`; returning empty recall');
    } else if (hits.length === 0) {
      warnings.push(`no recall hits for task '${args.task}' (task absent or no linked learnings/fts matches)`);
    }
    return {
      exitCode: emit(
        ok({
          task: args.task,
          hits,
          learning_nodes: status.by_kind.learning ?? 0,
          node_count: status.node_count,
          edge_count: status.edge_count,
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
          'LOOM_RECALL_FAILED',
          `loom recall: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    await backend.close();
  }
}
