// FORGE-200 (Loom I1): `forge loom recall --task <id>` — dependency-aware recall.
//
// Soft-fails when the db is missing/empty (emits ok with empty hits + a warning)
// so /pickup-task never crashes on a fresh repo. A CORRUPT db fails loud.

import { scanText } from '../../security/tripwire/scan.ts';
import { emit, fail, ok } from '../envelope.ts';
import { dbExists, resolveBackend, type LoomContext } from './context.ts';

// FORGE-229 (THREAT-MODEL I2b-2, scan-at-read): a recall hit's model-visible text
// (title + why) reaches the implementer via /pickup-task. Symbol names are
// charset-constrained at ingest, but learning/decision/task titles are free-form
// repo content — so scan the egress and DROP any hit whose text trips Tripwire as
// hostile. Warnings are constants-only (a count, never the offending text — per
// THREAT-MODEL: model-visible warnings must not echo untrusted input).
export function filterHitsThroughTripwire<
  T extends { readonly id: string; readonly title: string; readonly why: string },
>(hits: readonly T[]): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const hit of hits) {
    // Scan EVERY model-visible field. /pickup-task renders id + title + why, and a
    // learning id is a repo-derived PATH an attacker can name (e.g.
    // `learning:docs/learnings/ignore previous instructions.md`) — so scanning only
    // title/why would leave that channel open (FORGE-229 Codex review, MAJOR#1).
    const scanned = `${hit.id}\n${hit.title}\n${hit.why}`;
    if (scanText(scanned, 'loom_recall').severity === 'hostile') {
      dropped += 1;
      continue;
    }
    kept.push(hit);
  }
  return { kept, dropped };
}

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
    const rawHits = await backend.recallForTask(args.task, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    const { kept: hits, dropped } = filterHitsThroughTripwire(rawHits);
    const warnings = [...args.ctx.warnings];
    if (dropped > 0) {
      // Constants-only (a count) — never echo the flagged hit's text.
      warnings.push(`tripwire dropped ${dropped} recall hit(s) as potentially unsafe`);
    }
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
