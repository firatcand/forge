// FORGE-200 (Loom I1): `forge loom reindex` — rebuild the local memory graph
// from plans/phases.yaml + docs/learnings/**.

import path from 'node:path';

import { scanText } from '../../security/tripwire/scan.ts';
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

// FORGE-229 (THREAT-MODEL I2b-2, boundary sanitizer): `/pickup-task` runs
// `forge loom reindex --json` and surfaces its output to the implementer, so the
// warning list is an untrusted→prompt channel. Most warnings are constants, but
// some reindex sources still embed repo-derived content (a learning/file path, a
// task ref). Scan EVERY warning at this boundary and replace any that trips
// Tripwire as hostile with a fixed constant — the same engine + bar recall uses,
// so a single choke point covers all current and future warning producers.
export function sanitizeReindexWarnings(warnings: readonly string[]): string[] {
  return warnings.map((w) =>
    scanText(w, 'loom_reindex').severity === 'hostile'
      ? 'loom reindex: a warning was withheld (flagged as potentially unsafe)'
      : w,
  );
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
    // FORGE-218: the projector reads orchestrator history under <repoRoot>/.forge
    // (loom has no --forge-dir flag — see context.ts).
    const forgeDir = path.join(args.ctx.repoRoot, '.forge');
    const result = await reindex({ repoRoot: args.ctx.repoRoot, forgeDir, backend });
    return {
      exitCode: emit(
        ok({
          scope: 'all',
          nodes: result.nodes,
          edges: result.edges,
          learning_nodes: result.learning_nodes,
          // FORGE-218: honest output — surface the projector's counts too.
          file_nodes: result.file_nodes,
          touches_edges: result.touches_edges,
          // FORGE-219: code-symbol counts from the tree-sitter extractor.
          symbol_nodes: result.symbol_nodes,
          defines_edges: result.defines_edges,
          // FORGE-229: reference + mention edge counts.
          references_edges: result.references_edges,
          references_unresolved: result.references_unresolved,
          symbols_rejected: result.symbols_rejected,
          mentions_edges: result.mentions_edges,
          source_file_nodes: result.source_file_nodes,
          // FORGE-226: decision counts from the three-source decision projector.
          decision_nodes: result.decision_nodes,
          decided_in_edges: result.decided_in_edges,
          affects_edges: result.affects_edges,
          db_path: args.ctx.location,
          warnings: sanitizeReindexWarnings([...warnings, ...result.warnings]),
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
    await backend.close();
  }
}
