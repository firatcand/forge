// FORGE-231: fenced ship-record writes (spec/ORCHESTRATOR.md §Ship record).
// The record is the durable WRITE-AHEAD for external ship effects: the
// reviewed binding is minted at review-pass (or the single-host direct path);
// base/pr populate at their own write-ahead stages (FORGE-234 call sites).
// Every write is a casGuardedWrite revision transition — single committer,
// post-acquire revalidation, conservative recovery.

import { lstatSync, readFileSync } from 'node:fs';
import { CasError, OrchestratorError } from '../core/errors.ts';
import { casGuardedWrite, type CasHolderIdentity } from '../core/fs-atomic.ts';
import { ShipRecordSchema, type ShipRecord } from '../schemas/ship-record.ts';
import { shipRecordFilePath } from './questions/paths.ts';

const RECORD_MAX_BYTES = 256 * 1024;

function revisionOf(raw: string): number {
  const parsed = JSON.parse(raw) as { revision?: unknown };
  if (typeof parsed?.revision !== 'number' || !Number.isInteger(parsed.revision)) {
    throw new OrchestratorError('SCHEMA_INVALID', 'ship-record.json has no integer revision', {});
  }
  return parsed.revision;
}

// Capped, no-symlink read. Absent → null; schema-invalid → typed error
// (fail-closed — an unversionable record cannot participate in shipping).
export function readShipRecord(forgeDir: string, taskId: string): ShipRecord | null {
  const p = shipRecordFilePath(forgeDir, taskId);
  let raw: string;
  try {
    const st = lstatSync(p);
    if (!st.isFile()) {
      throw new OrchestratorError('IO_ERROR', `ship record at ${p} is not a regular file`, { taskId });
    }
    if (st.size > RECORD_MAX_BYTES) {
      throw new OrchestratorError('IO_ERROR', `ship record at ${p} exceeds the size cap`, { taskId });
    }
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    if (err instanceof OrchestratorError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OrchestratorError('IO_ERROR', `cannot read ship record for task ${taskId}`, { taskId, cause: err });
  }
  const parsed = ShipRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError('SCHEMA_INVALID', `ship record for task ${taskId} failed schema validation`, {
      taskId,
      zodError: parsed.error.message,
    });
  }
  return parsed.data;
}

export interface ReviewedBindingOptions {
  reviewedHeadSha: string;
  reviewAttemptId: string;
  holder: CasHolderIdentity;
  /** Fence predicate for the guarded write (operation-specific; optional). */
  fence?: () => void;
}

// Mint (or refresh) the reviewed binding — the §C3 write-ahead that runs
// BEFORE the task-state CAS to `reviewed`. Semantics:
// - absent record → create at revision 1 (progressive init: base/pr null);
// - same (review_attempt_id, reviewed_head_sha) → crash-replay no-op;
// - different binding (re-review after drift) → fenced update: new binding,
//   RESET merge_attempt to not_started, KEEP base/pr (PR identity survives a
//   head update; merge proof was never local).
export function upsertReviewedBinding(
  forgeDir: string,
  taskId: string,
  opts: ReviewedBindingOptions,
): ShipRecord {
  const attempt = (): ShipRecord => {
    const current = readShipRecord(forgeDir, taskId);
    if (
      current !== null &&
      current.review_attempt_id === opts.reviewAttemptId &&
      current.reviewed_head_sha === opts.reviewedHeadSha
    ) {
      return current; // replay — the write-ahead already committed
    }
    const next: ShipRecord = current === null
      ? {
          version: 1,
          task_id: taskId,
          revision: 1,
          reviewed_head_sha: opts.reviewedHeadSha,
          review_attempt_id: opts.reviewAttemptId,
          base: null,
          pr: null,
          merge_attempt: 'not_started',
          updated_at: new Date().toISOString(),
        }
      : {
          ...current,
          revision: current.revision + 1,
          reviewed_head_sha: opts.reviewedHeadSha,
          review_attempt_id: opts.reviewAttemptId,
          merge_attempt: 'not_started',
          updated_at: new Date().toISOString(),
        };
    const validated = ShipRecordSchema.safeParse(next);
    if (!validated.success) {
      throw new OrchestratorError('SCHEMA_INVALID', `ship record for task ${taskId} failed schema validation`, {
        taskId,
        zodError: validated.error.message,
      });
    }
    casGuardedWrite({
      filePath: shipRecordFilePath(forgeDir, taskId),
      expectedVersion: current === null ? 'create' : current.revision,
      holder: opts.holder,
      readVersion: revisionOf,
      fence: opts.fence,
      buildContent: () => JSON.stringify(validated.data),
    });
    return validated.data;
  };

  try {
    return attempt();
  } catch (err) {
    // One concurrent-replay retry: a racing writer may have committed the
    // SAME binding (crash-replay from another invocation).
    if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
      const current = readShipRecord(forgeDir, taskId);
      if (
        current !== null &&
        current.review_attempt_id === opts.reviewAttemptId &&
        current.reviewed_head_sha === opts.reviewedHeadSha
      ) {
        return current;
      }
      throw new OrchestratorError(
        'STATE_VERSION_CONFLICT',
        `ship record for task ${taskId} changed concurrently`,
        { taskId, cause: err },
      );
    }
    if (err instanceof OrchestratorError) throw err;
    throw new OrchestratorError('IO_ERROR', `ship record write failed for task ${taskId}`, { taskId, cause: err });
  }
}
