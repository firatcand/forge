// FORGE-235: `forge orchestrate merge-tick` — reconcile merge_pending tasks.
// Promotes on exact live merge proof; REPORTS every non-terminal observation
// with zero state mutation (FORGE-237 automates those transitions).

import * as path from 'node:path';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../../core/settings.ts';
import { SettingsError } from '../../core/errors.ts';
import { MergeTickArgsSchema, type MergeTickArgs } from '../../schemas/cli-args.ts';
import {
  isOperatorAction,
  runMergeTick,
  type MergeTickDeps,
  type TickResult,
} from '../../orchestrator/merge-tick.ts';
import { readMergeAttestation, readReconciliationRecord } from '../../orchestrator/reconciliation-record.ts';
import { readShipRecord } from '../../orchestrator/ship-record.ts';
import { readTaskState } from '../../orchestrator/state-machine.ts';
import { appendNotificationEvent } from '../../orchestrator/events.ts';
import { createMergeHost } from '../../repo-hosts/detect.ts';
import { createTracker } from './tracker-factory.ts';
import { TrackerError, isRetriableTrackerErrorCode } from '../../trackers/errors.ts';
import { emit, fail, ok } from '../envelope.ts';
import { ghExec } from './gh-exec.ts';

export interface MergeTickVerbDeps {
  depsFor?: (taskId: string) => Promise<MergeTickDeps | null>;
}

// Fair scan (plan v5 Δ22): oldest last_probed_at first so a cap can never
// starve a task; unreadable/unbound tasks sort LAST and never block the scan.
function scanOrder(forgeDir: string, taskIds: readonly string[]): string[] {
  const keyed = taskIds.map((taskId) => {
    try {
      readTaskState(forgeDir, taskId); // unreadable/misbound state ⇒ broken
      const journal = readReconciliationRecord(forgeDir, taskId);
      const probedAt = journal?.last_probed_at;
      return { taskId, key: probedAt === null || probedAt === undefined ? 0 : Date.parse(probedAt), broken: false };
    } catch {
      return { taskId, key: Number.MAX_SAFE_INTEGER, broken: true };
    }
  });
  keyed.sort((a, b) => (a.broken === b.broken ? a.key - b.key : a.broken ? 1 : -1));
  return keyed.map((k) => k.taskId);
}

// `createMergeHost` needs the ship record to learn the repo, so it returns null
// both when there is genuinely no host AND when the record is unreadable. Only
// the second is operator action — classify it here so a corrupt record surfaces
// with its failure key instead of masquerading as a transient probe failure.
function noHostResult(forgeDir: string, taskId: string, runId: string): TickResult {
  let detail: string | null = null;
  try {
    const record = readShipRecord(forgeDir, taskId);
    if (record === null) detail = 'no ship record exists for this task';
    else if (record.pr === null || record.base === null) detail = 'ship record is missing its pr/base binding';
  } catch (err) {
    detail = `ship record unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (detail !== null) {
    const failureKey = `${taskId}:record_invalid:unreadable`;
    const hint =
      'Inspect .forge/orchestrator/tasks/<task>/ship-record.json — forge cannot reconcile a task whose PR identity is missing or misbound.';
    // Operator action always carries a DURABLE notification, not just stdout.
    try {
      appendNotificationEvent(forgeDir, runId, {
        type: 'fatal',
        ts: new Date().toISOString(),
        run_id: runId,
        reason: `task ${taskId}: ship record is unreadable or misbound`,
        details: { task_id: taskId, failure_key: failureKey, disposition: 'ship_record_invalid_reported', guidance: hint },
      } as never);
    } catch {
      // the report itself is the durable handling; the event is a surface
    }
    return {
      task_id: taskId,
      disposition: 'ship_record_invalid_reported',
      detail,
      failure_key: failureKey,
      action_hint: hint,
    };
  }
  return {
    task_id: taskId,
    disposition: 'probe_unavailable',
    detail: 'no RepoHost could be constructed from the persisted identity',
  };
}

// A `shipped` task whose tracker is already synced has nothing left to
// reconcile; keeping it in the scan would burn the --limit budget forever.
function needsReconciliation(forgeDir: string, taskId: string, state: string): boolean {
  if (state === 'merge_pending') return true;
  if (state !== 'shipped') return false;
  if (readMergeAttestation(forgeDir, taskId).kind !== 'valid') return true;
  try {
    return readReconciliationRecord(forgeDir, taskId)?.tracker_sync.status !== 'done';
  } catch {
    return true;
  }
}

// "Broken" means: this tick will resolve LOCALLY, with no network call. Such a
// task must never consume a probe slot — an unreadable ship record would
// otherwise hold the oldest position every round (its report cannot stamp a
// fairness timestamp) and starve tasks that genuinely need probing.
function isBroken(forgeDir: string, taskId: string): boolean {
  let state;
  try {
    state = readTaskState(forgeDir, taskId);
    readReconciliationRecord(forgeDir, taskId);
  } catch {
    return true;
  }
  try {
    const record = readShipRecord(forgeDir, taskId);
    if (record === null || record.pr === null || record.base === null) return true;
  } catch {
    return true;
  }
  if (state.state !== 'shipped') return false;
  // An INVALID attestation short-circuits the resume ladder before its probe;
  // an ABSENT one does not (that path live-probes), so only the former is local.
  const att = readMergeAttestation(forgeDir, taskId);
  if (att.kind === 'invalid') return true;
  if (att.kind !== 'valid') return false;
  // Proven merge + exhausted tracker sync: the resume ladder resolves this
  // entirely from local files (`tracker_sync_exhausted_reported`), so it must
  // not hold a probe slot either.
  try {
    return readReconciliationRecord(forgeDir, taskId)?.tracker_sync.status === 'failed';
  } catch {
    return true;
  }
}

function mergePendingTasks(forgeDir: string): string[] {
  const root = path.join(forgeDir, 'orchestrator', 'tasks');
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  return entries.filter((taskId) => {
    try {
      return needsReconciliation(forgeDir, taskId, readTaskState(forgeDir, taskId).state);
    } catch {
      // An UNREADABLE or misbound state file is exactly the corruption the
      // path↔payload binding detects — it must be scanned and reported, not
      // silently dropped. `scanOrder` puts it last so it cannot starve anyone.
      return true;
    }
  });
}

export async function runOrchestrateMergeTick(
  args: MergeTickArgs,
  verbDeps: MergeTickVerbDeps = {},
): Promise<{ exitCode: number }> {
  const parsed = MergeTickArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  let mergePolicy: 'approval' | 'auto' = 'approval';
  // Unique per invocation: the merge reservation is owner-scoped, so two
  // concurrent ticks sharing a run id could settle each other's reservation.
  // It is ALSO the directory name notifications are written under, so it must
  // stay path-safe — a ':' is illegal on Windows and every keyed fatal would be
  // silently swallowed by the append's catch.
  const runId = `merge-tick-${randomUUID()}`;
  try {
    const settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
    mergePolicy = settings.ship.merge_policy;
  } catch (err) {
    if (err instanceof SettingsError && err.code !== 'FILE_NOT_FOUND') {
      return { exitCode: emit(fail(err.code, err.message, false), { json: opts.json }) };
    }
  }

  const targets = opts.taskId ? [opts.taskId] : scanOrder(opts.forgeDir, mergePendingTasks(opts.forgeDir));
  // `--limit` bounds LIVE PROBES, which is the expensive, rate-limited part.
  // Locally-broken tasks are pure file reads that never reach the network, so
  // they are always included: capping them starves corruption reporting, and
  // letting them displace healthy tasks starves reconciliation. Neither is
  // necessary — they are simply different budgets.
  const broken = opts.taskId ? [] : targets.filter((t) => isBroken(opts.forgeDir, t));
  const healthy = opts.taskId ? targets : targets.filter((t) => !broken.includes(t));
  const capped = opts.limit !== undefined && healthy.length > opts.limit;
  const scanned = [...(capped ? healthy.slice(0, opts.limit) : healthy), ...broken];

  const results: TickResult[] = [];
  for (const taskId of scanned) {
    // Per-task containment covers BOTH dep construction and the tick itself: a
    // task with a corrupt persisted identity must never starve the rest of the
    // scan (plan v5 Δ22).
    try {
      const deps = verbDeps.depsFor
        ? await verbDeps.depsFor(taskId)
        : await productionDeps(opts.forgeDir, taskId, runId);
      if (deps === null) {
        results.push(noHostResult(opts.forgeDir, taskId, runId));
        continue;
      }
      results.push(await runMergeTick({ forgeDir: opts.forgeDir, taskId, mergePolicy }, deps));
    } catch (err) {
      results.push({
        task_id: taskId,
        disposition: 'probe_unavailable',
        detail: `tick failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const operatorAction = results.filter((r) => isOperatorAction(r.disposition));
  return {
    exitCode: emit(
      ok({
        // Notifications for this scan live under orchestrator/runs/<run_id>/.
        run_id: runId,
        scanned: scanned.length,
        // Never silent truncation (plan v5 Δ22). The cap applies to live
        // probes; locally-broken tasks are reported in full alongside them.
        ...(capped ? { capped: true, total_candidates: targets.length, probe_limit: opts.limit } : {}),
        promoted: results.filter((r) => r.disposition === 'promoted').length,
        operator_action: operatorAction.length,
        results,
      }),
      { json: opts.json },
    ),
  };
}

async function productionDeps(forgeDir: string, taskId: string, runId: string): Promise<MergeTickDeps | null> {
  const host = await createMergeHost(forgeDir, taskId, ghExec);
  if (host === null) return null;
  const settings = (() => {
    try {
      return loadSettings(path.join(forgeDir, 'settings.yaml'));
    } catch {
      return null;
    }
  })();
  return {
    repoHost: host,
    runId,
    tracker: {
      markDone: async () => {
        if (settings === null) return { ok: false as const, retriable: false, detail: 'no settings.yaml' };
        try {
          const handle = createTracker(settings, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
          await handle.tracker.updateState(taskId, 'done');
          return { ok: true as const };
        } catch (err) {
          if (err instanceof TrackerError) {
            return { ok: false as const, retriable: isRetriableTrackerErrorCode(err.code), detail: err.message.slice(0, 300) };
          }
          return { ok: false as const, retriable: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
        }
      },
    },
    emitShipped: (pr, stateVersion) => {
      try {
        appendNotificationEvent(forgeDir, runId, {
          type: 'shipped',
          ts: new Date().toISOString(),
          run_id: runId,
          task_id: taskId,
          state_version: stateVersion,
          pr_url: pr.url,
        } as never);
      } catch {
        // advisory — loss after the CAS is accepted (ORCHESTRATOR:585)
      }
    },
    emitFatal: (failureKey, reason, details) => {
      try {
        appendNotificationEvent(forgeDir, runId, {
          type: 'fatal',
          ts: new Date().toISOString(),
          run_id: runId,
          reason,
          details: { ...details, failure_key: failureKey },
        } as never);
      } catch {
        // durable handling is the report itself; the event is a surface
      }
    },
  };
}
