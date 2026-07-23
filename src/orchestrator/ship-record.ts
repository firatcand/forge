// FORGE-231: fenced ship-record writes (spec/ORCHESTRATOR.md §Ship record).
// The record is the durable WRITE-AHEAD for external ship effects: the
// reviewed binding is minted at review-pass (or the single-host direct path);
// base/pr populate at their own write-ahead stages (FORGE-234 call sites).
// Every write is a casGuardedWrite revision transition — single committer,
// post-acquire revalidation, conservative recovery.

import { lstatSync, readFileSync } from 'node:fs';
import { CasError, OrchestratorError } from '../core/errors.ts';
import {
  acquireCasMarker,
  casGuardedWrite,
  releaseCasMarker,
  type CasHolderIdentity,
} from '../core/fs-atomic.ts';
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
      // Replay — the write-ahead already committed. The fence still runs
      // (impl R2 MAJ-2): a caller whose lease died since the original write
      // must not treat the replay as its own success.
      opts.fence?.();
      return current;
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
        opts.fence?.(); // replay success still requires a live caller
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
export interface BaseResolutionBinding {
  repo: string;
  branch: string;
  push_remote: string;
}

export interface BaseResolutionOptions {
  base: BaseResolutionBinding;
  /** The reviewed binding this base belongs to — a superseded attempt must not write. */
  expectedReviewAttemptId: string;
  expectedReviewedHeadSha: string;
  holder: CasHolderIdentity;
  fence?: () => void;
}

function sameBase(a: BaseResolutionBinding, b: BaseResolutionBinding): boolean {
  return a.repo === b.repo && a.branch === b.branch && a.push_remote === b.push_remote;
}

// FORGE-232: the base-resolution write-ahead (plan v3 §upsertBaseResolution).
// NEVER creates the record — base resolution cannot mint the trusted reviewed
// binding (Codex plan R2 #3). The only legal mutation is base:null → base;
// the same base is replay success (fence + binding validation still run); a
// different stored base or a reviewed-binding mismatch is a hard conflict —
// the durable PR identity is never retargeted by replay.
export function upsertBaseResolution(
  forgeDir: string,
  taskId: string,
  opts: BaseResolutionOptions,
): ShipRecord {
  const validateBinding = (current: ShipRecord): void => {
    if (
      current.review_attempt_id !== opts.expectedReviewAttemptId ||
      current.reviewed_head_sha !== opts.expectedReviewedHeadSha
    ) {
      throw new OrchestratorError(
        'STALE_ATTEMPT',
        `ship record for task ${taskId} is bound to a different reviewed attempt — this base resolution is superseded and must not be written`,
        { taskId, attemptId: opts.expectedReviewAttemptId },
      );
    }
  };

  const attempt = (): ShipRecord => {
    const current = readShipRecord(forgeDir, taskId);
    if (current === null) {
      throw new OrchestratorError(
        'STATE_NOT_FOUND',
        `no ship record for task ${taskId} — base resolution never creates it (the reviewed binding must be minted first)`,
        { taskId },
      );
    }
    validateBinding(current);
    if (current.base !== null) {
      if (sameBase(current.base, opts.base)) {
        // Replay — but validated UNDER the CAS marker (impl-R1 MAJ #3): a
        // concurrent reviewed-binding writer between the unguarded read and
        // return would otherwise let a stale caller report replay success.
        const held = acquireCasMarker(
          shipRecordFilePath(forgeDir, taskId),
          current.revision,
          opts.holder,
          revisionOf,
        );
        try {
          if (held.raw === null) {
            throw new OrchestratorError('STATE_NOT_FOUND', `ship record for task ${taskId} vanished during replay`, { taskId });
          }
          const reread = ShipRecordSchema.safeParse(JSON.parse(held.raw));
          if (!reread.success) {
            throw new OrchestratorError('SCHEMA_INVALID', `ship record for task ${taskId} failed schema validation`, { taskId });
          }
          validateBinding(reread.data);
          if (reread.data.base === null || !sameBase(reread.data.base, opts.base)) {
            throw new OrchestratorError(
              'STATE_VERSION_CONFLICT',
              `ship record for task ${taskId} changed during replay validation`,
              { taskId },
            );
          }
          opts.fence?.();
          return reread.data;
        } finally {
          releaseCasMarker(held);
        }
      }
      throw new OrchestratorError(
        'STATE_VERSION_CONFLICT',
        `ship record for task ${taskId} already holds a DIFFERENT base resolution — never overwritten`,
        { taskId },
      );
    }
    const next: ShipRecord = {
      ...current,
      revision: current.revision + 1,
      base: { ...opts.base },
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
      expectedVersion: current.revision,
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
    if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
      // Accept ONLY an exact same-base, same-binding concurrent commit.
      const current = readShipRecord(forgeDir, taskId);
      if (
        current !== null &&
        current.review_attempt_id === opts.expectedReviewAttemptId &&
        current.reviewed_head_sha === opts.expectedReviewedHeadSha &&
        current.base !== null &&
        sameBase(current.base, opts.base)
      ) {
        opts.fence?.();
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
