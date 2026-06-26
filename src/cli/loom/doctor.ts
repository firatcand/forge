// FORGE-227: `forge loom doctor` — graph health report.
//
// Reports orphan edges, isolated nodes, stale FTS rows, and invalid node rows
// (each a capped sample + count). Soft-fails (ok + zeroes) when the db is
// missing; a corrupt db that cannot be opened fails loud. Exit code 2 when any
// problem is found (clean graph → 0), mirroring the orchestrate doctor convention.

import { emit, fail, ok } from '../envelope.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

export interface DoctorHandlerArgs {
  readonly ctx: LoomContext;
  readonly json: boolean;
}

export async function runLoomDoctor(args: DoctorHandlerArgs): Promise<{ exitCode: number }> {
  if (!dbExists(args.ctx)) {
    return {
      exitCode: emit(
        ok({
          node_count: 0,
          edge_count: 0,
          nodes_by_kind: {},
          edges_by_kind: {},
          orphan_edges: { count: 0, sample: [] },
          isolated_nodes: { count: 0, sample: [] },
          stale_fts_rows: { count: 0, sample: [] },
          invalid_rows: { count: 0, sample: [] },
          invalid_edges: { count: 0, sample: [] },
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
          `loom doctor: could not open loom.db at ${args.ctx.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  try {
    const health = backend.doctor();
    // Only genuine CORRUPTION drives a non-zero exit: orphan edges (missing
    // endpoint), stale FTS rows (no backing node), invalid rows (fail schema).
    // Isolated nodes are a benign structural observation (a learning with no task
    // link, a leaf task) — reported, but they must NOT make doctor "fail" on
    // every real repo, so they do not affect the exit code.
    const corruption =
      health.orphan_edges.count +
      health.stale_fts_rows.count +
      health.invalid_rows.count +
      health.invalid_edges.count;
    const code = emit(
      ok({ ...health, corruption_count: corruption, warnings: args.ctx.warnings }),
      { json: args.json },
    );
    // Clean graph → 0; corruption found → 2 (informational findings, not a crash).
    return { exitCode: corruption > 0 ? 2 : code };
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'LOOM_DOCTOR_FAILED',
          `loom doctor: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  } finally {
    backend.close();
  }
}
