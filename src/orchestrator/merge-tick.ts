// FORGE-235: the merge-pending reconciliation coordinator (plan v5).
//
// SCOPE (owner decision 2026-07-29, split): this ticket ships the TERMINAL
// path only. The ONLY task-state write it performs is `merge_pending →
// shipped`, and only from an EXACT live merge proof re-validated under the
// state marker. Every non-terminal observation (drift, red CI, closed PR,
// taint, policy loss, …) becomes a TYPED REPORT with ZERO state mutation.
//
// Why that is safe rather than merely smaller: leaving `merge_pending` for a
// non-terminal destination requires an ownership-reacquisition primitive forge
// does not have (the worker lease is released on entering merge_pending, while
// `claim` accepts only `unclaimed` and `dispatch` requires a live lease) — see
// FORGE-237. Because no negative outcome writes state here, neither the
// ownership wedge nor "stale negative evidence overrides a real merge" can
// occur. Today nothing reconciles merge_pending at all, so reporting is
// strictly more information than the status quo.
//
// Concurrency shape (plan v5 Δ18): probe live holding NOTHING → acquire the
// state marker → re-validate the observation's identity under it → commit.
// A marker is never held across network I/O; a stale observation can never
// commit.

import { OrchestratorError } from '../core/errors.ts';
import type { CasHolderIdentity } from '../core/fs-atomic.ts';
import type { MergeAttestation } from '../schemas/merge-attestation.ts';
import type { MergeReservation, ReconciliationSubject } from '../schemas/reconciliation.ts';
import type { ShipRecord } from '../schemas/ship-record.ts';
import type { ChecksResult, MergeAttemptOutcome, MergeResult, PullRequestRef } from '../repo-hosts/types.ts';
import type { RepoHost } from '../repo-hosts/base.ts';
import { evaluateProbeBar } from '../repo-hosts/github.ts';
import { readShipRecord } from './ship-record.ts';
import {
  JournalAbort,
  mintMergeAttestation,
  readMergeAttestation,
  readReconciliationRecord,
  tickHolder,
  updateReconciliationRecord,
  type AttestationWrite,
} from './reconciliation-record.ts';
import { readTaskState } from './state-machine.ts';

// ─── Dispositions ────────────────────────────────────────────────────────────

/** Waiting class: retried on the next tick; never emits a fatal. */
export const WAITING_DISPOSITIONS = [
  'promoted', // terminal success (not "waiting", but also not operator action)
  'checks_pending',
  'probe_unavailable',
  'reservation_contended',
  'lease_leftover_deferred',
  'merge_call_failed_reported',
  'not_merge_pending',
] as const;

/** Operator-action class: typed report + KEYED fatal, durably re-emittable. */
export const OPERATOR_DISPOSITIONS = [
  'reconciliation_invalid_reported',
  'tainted_reported',
  'pr_closed_reported',
  'drift_reported',
  'ci_red_reported',
  'policy_loss_reported',
  'merge_unsupported_reported',
  'merge_budget_exhausted_reported',
  'ship_record_invalid_reported',
  'attestation_invalid_reported',
  'shipped_unproven_reported',
  'tracker_sync_exhausted_reported',
] as const;

export type Disposition =
  | (typeof WAITING_DISPOSITIONS)[number]
  | (typeof OPERATOR_DISPOSITIONS)[number];

export function isOperatorAction(d: Disposition): boolean {
  return (OPERATOR_DISPOSITIONS as readonly string[]).includes(d);
}

export interface TickResult {
  task_id: string;
  disposition: Disposition;
  detail: string;
  /** Deterministic key: the fatal id anchor + report dedup identity. */
  failure_key?: string;
  pr?: PullRequestRef;
  expected?: { base_branch?: string; reviewed_head_sha?: string };
  observed?: { base_ref?: string; merged_head_sha?: string; head_sha?: string; failing?: unknown };
  /** Truthful next step — never suggests an action forge cannot perform yet. */
  action_hint?: string;
}

// FORGE-237 owns every lifecycle transition out of merge_pending; until then
// the hints must not promise actions the CLI refuses (claim requires
// `unclaimed`; cancel excludes merge_pending).
const RECORD_INVALID_HINT =
  'The durable ship record or task state under this task is unreadable or declares another task_id (a copied/restored .forge tree does this). forge refuses to reconcile it — inspect .forge/orchestrator/tasks/<task>/ and restore the correct files.';

const DEFERRED_HINT =
  'forge cannot perform this lifecycle transition yet (FORGE-237). Immediate options: fix the condition on the SAME reviewed head (restore policy / re-run checks), or merge the exact recorded reviewed head manually — forge will then promote it to shipped on the next tick.';

// ─── Ports ───────────────────────────────────────────────────────────────────

export interface TrackerDonePort {
  markDone: () => Promise<{ ok: true } | { ok: false; retriable: boolean; detail: string }>;
}

export interface MergeTickDeps {
  /** Observation + (tick only) merge capability. gc passes an observer whose mergeAtomic is absent. */
  repoHost: Pick<RepoHost, 'mergeResult' | 'headSha' | 'probe' | 'requiredChecksGreen'> &
    Partial<Pick<RepoHost, 'mergeAtomic'>>;
  tracker: TrackerDonePort;
  runId: string;
  now?: () => Date;
  /** Bounded tracker-sync policy (post-merge failure can never falsify `shipped`). */
  trackerSyncMaxAttempts?: number;
  /** Streak beyond which unexplained merge-call failures are REPORTED as exhausted. */
  mergeFailureBudget?: number;
  /** Emitted after the state CAS; advisory (loss accepted — ORCHESTRATOR:585). */
  emitShipped?: (pr: PullRequestRef, stateVersion: number) => void;
  emitFatal?: (failureKey: string, reason: string, details: Record<string, unknown>) => void;
  /** Reservation staleness before takeover is considered (takeover still requires a fresh not-merged probe). */
  reservationTtlMs?: number;
  /** How long a tracker-sync attempt may be in flight before it is treated as abandoned. */
  trackerSyncTtlMs?: number;
}

export interface MergeTickArgs {
  forgeDir: string;
  taskId: string;
  mergePolicy: 'approval' | 'auto';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function subjectOf(record: ShipRecord): ReconciliationSubject | null {
  if (record.pr === null || record.base === null) return null;
  return {
    cycle: record.cycle,
    pr: record.pr,
    reviewed_head_sha: record.reviewed_head_sha,
    ship_record_revision: record.revision,
  };
}

function report(
  taskId: string,
  disposition: Disposition,
  detail: string,
  extra: Omit<TickResult, 'task_id' | 'disposition' | 'detail'> = {},
): TickResult {
  return { task_id: taskId, disposition, detail, ...extra };
}

// EVERY operator-action report goes through here, so the contract ("a
// deterministic failure_key + a truthful hint + a keyed fatal") cannot depend
// on which code path observed the condition. Before this existed, the same
// condition seen via mergeAtomic instead of the direct probe produced a report
// with no durable fatal.
function operatorReport(
  deps: MergeTickDeps,
  taskId: string,
  disposition: (typeof OPERATOR_DISPOSITIONS)[number],
  args: {
    failureKey: string;
    detail: string;
    reason: string;
    hint: string;
    pr?: PullRequestRef;
    expected?: TickResult['expected'];
    observed?: TickResult['observed'];
    fatalDetails?: Record<string, unknown>;
  },
): TickResult {
  deps.emitFatal?.(args.failureKey, args.reason, {
    task_id: taskId,
    failure_key: args.failureKey,
    disposition,
    ...(args.pr ? { pr_url: args.pr.url } : {}),
    ...(args.fatalDetails ?? {}),
    guidance: args.hint,
  });
  return report(taskId, disposition, args.detail, {
    failure_key: args.failureKey,
    ...(args.pr ? { pr: args.pr } : {}),
    ...(args.expected ? { expected: args.expected } : {}),
    ...(args.observed ? { observed: args.observed } : {}),
    action_hint: args.hint,
  });
}

function exactProof(result: MergeResult, record: ShipRecord): boolean {
  return (
    result.merged &&
    record.base !== null &&
    result.base_ref === record.base.branch &&
    result.merged_head_sha === record.reviewed_head_sha
  );
}

// ─── The tick ────────────────────────────────────────────────────────────────

export async function runMergeTick(args: MergeTickArgs, deps: MergeTickDeps): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const holder: CasHolderIdentity = tickHolder(deps.runId);
  const { forgeDir, taskId } = args;

  // ── 0. Local preconditions (no network yet) ──
  let state;
  try {
    state = readTaskState(forgeDir, taskId);
  } catch (err) {
    return operatorReport(deps, taskId, 'ship_record_invalid_reported', {
      failureKey: `${taskId}:record_invalid:state`,
      detail: `task state unreadable: ${err instanceof Error ? err.message : String(err)}`,
      reason: `task ${taskId}: state.json is unreadable or misbound`,
      hint: RECORD_INVALID_HINT,
    });
  }

  if (state.state !== 'merge_pending' && state.state !== 'shipped') {
    return report(taskId, 'not_merge_pending', `task is '${state.state}', not merge_pending`);
  }

  // The journal is not optional bookkeeping: the tick's streaks, reservations
  // and tracker-sync budget all live there, and every write to it is wrapped in
  // a diagnostic catch. A CORRUPT journal would therefore degrade silently —
  // waiting dispositions with no memory, and a promotion whose tracker sync is
  // skipped forever. Preflight it and report instead.
  //
  // This runs BEFORE the resume branch below: the resume ladder needs the
  // journal just as much, since that is where the tracker-sync budget lives.
  try {
    readReconciliationRecord(forgeDir, taskId);
  } catch (err) {
    return operatorReport(deps, taskId, 'reconciliation_invalid_reported', {
      failureKey: `${taskId}:reconciliation_invalid`,
      detail: `reconciliation.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
      reason: `task ${taskId}: the reconciliation journal is corrupt`,
      hint: 'Inspect .forge/orchestrator/tasks/<task>/reconciliation.json. It holds only observation bookkeeping — deleting it is safe and the next tick rebuilds it from a fresh probe.',
    });
  }

  // The resume ladder also serves tasks ALREADY `shipped` (crash after the CAS
  // but before tracker/notification) — evidence-branched per plan v3 Δ13.
  if (state.state === 'shipped') {
    return resumeShipped(args, deps, holder, now);
  }

  let record: ShipRecord | null;
  try {
    record = readShipRecord(forgeDir, taskId);
  } catch (err) {
    return operatorReport(deps, taskId, 'ship_record_invalid_reported', {
      failureKey: `${taskId}:record_invalid:unreadable`,
      detail: `ship record unreadable: ${err instanceof Error ? err.message : String(err)}`,
      reason: `task ${taskId}: ship-record.json is unreadable or misbound`,
      hint: RECORD_INVALID_HINT,
    });
  }
  if (record === null || record.pr === null || record.base === null) {
    return operatorReport(deps, taskId, 'ship_record_invalid_reported', {
      failureKey: `${taskId}:record_invalid:${record?.revision ?? 0}`,
      detail: 'ship record is missing its pr/base binding',
      reason: `task ${taskId}: ship record has no PR identity to reconcile`,
      hint: RECORD_INVALID_HINT,
    });
  }
  const subject = subjectOf(record)!;
  const pr = record.pr;

  // A live worker lease means a crash leftover: defer to gc row 15 rather than
  // reconciling under someone else's ownership.
  // (Checked by the state writer's fence too; reported here for visibility.)

  // ── 1. Probe live — holding NOTHING ──
  let mergeResult: MergeResult;
  try {
    mergeResult = await deps.repoHost.mergeResult(pr);
  } catch (err) {
    await noteProbeFailure(args, subject, holder, now, err instanceof Error ? err.message : String(err));
    return report(taskId, 'probe_unavailable', `merge probe failed: ${err instanceof Error ? err.message : String(err)}`, { pr });
  }

  // ── 2. Merged? ──
  if (mergeResult.merged) {
    if (exactProof(mergeResult, record)) {
      return promote(args, deps, record, mergeResult, holder, now);
    }
    // TAINTED: merged, but not the reviewed head or not the recorded base.
    await noteProbed(args, subject, holder, now, 'tainted merge observed');
    return operatorReport(deps, taskId, 'tainted_reported', {
      failureKey: `${taskId}:tainted:${mergeResult.merged_head_sha}`,
      detail: 'PR merged at an unreviewed head or wrong base — never shipped',
      reason: `task ${taskId} merged at an UNREVIEWED head`,
      hint: 'Revert the merge commit on the base branch and re-ship. forge will never promote a task whose PR merged at an unreviewed head.',
      pr,
      expected: { base_branch: record.base.branch, reviewed_head_sha: record.reviewed_head_sha },
      observed: { base_ref: mergeResult.base_ref, merged_head_sha: mergeResult.merged_head_sha },
      fatalDetails: { merge_commit: mergeResult.merge_commit_sha },
    });
  }

  // ── 3. Not merged ──
  if (mergeResult.state === 'closed_unmerged') {
    await noteProbed(args, subject, holder, now, 'PR closed without merging');
    return operatorReport(deps, taskId, 'pr_closed_reported', {
      failureKey: `${taskId}:pr_closed:${record.cycle}:${pr.number}`,
      detail: 'PR was closed without merging',
      reason: `task ${taskId}: PR closed without merging`,
      hint: DEFERRED_HINT,
      pr,
    });
  }
  if (mergeResult.state === 'unknown') {
    await noteProbeFailure(args, subject, holder, now, mergeResult.reason ?? 'unknown merge state');
    return report(taskId, 'probe_unavailable', `merge state unknown: ${mergeResult.reason ?? 'no reason'}`, { pr });
  }

  // Open PR → head drift?
  const head = await deps.repoHost.headSha(pr);
  if (!head.ok) {
    await noteProbeFailure(args, subject, holder, now, `head unreadable (${head.reason})`);
    return report(taskId, 'probe_unavailable', `PR head unreadable (${head.reason})`, { pr });
  }
  if (head.sha !== record.reviewed_head_sha) {
    await noteProbed(args, subject, holder, now, `head drifted to ${head.sha}`);
    return operatorReport(deps, taskId, 'drift_reported', {
      failureKey: `${taskId}:drift:${head.sha}`,
      detail: 'PR head no longer equals the reviewed SHA',
      reason: `task ${taskId}: PR head drifted from the reviewed SHA`,
      hint: DEFERRED_HINT,
      pr,
      expected: { reviewed_head_sha: record.reviewed_head_sha },
      observed: { head_sha: head.sha },
    });
  }

  // ── 4. Approval policy observes only; auto policy may merge ──
  if (args.mergePolicy !== 'auto') {
    await noteWaiting(args, subject, holder, now, 'open, awaiting human merge');
    return report(taskId, 'checks_pending', 'PR open at the reviewed head — approval policy waits for a human merge', { pr });
  }
  if (typeof deps.repoHost.mergeAtomic !== 'function') {
    // gc holds an OBSERVER: it reconciles proof but never merges (by construction).
    await noteWaiting(args, subject, holder, now, 'observer has no merge capability');
    return report(taskId, 'reservation_contended', 'observer cannot merge — run `forge orchestrate merge-tick`', { pr });
  }

  // Honesty bar must still hold at merge time — fail closed, never wait silently.
  const probe = await deps.repoHost.probe();
  const bar = evaluateProbeBar(probe);
  if (bar !== null) {
    await noteProbed(args, subject, holder, now, `policy bar lost: ${bar}`);
    return operatorReport(deps, taskId, 'policy_loss_reported', {
      failureKey: `${taskId}:policy_loss:${probe.ok ? bar.slice(0, 40) : probe.reason}`,
      detail: `auto-merge withheld: ${bar}`,
      reason: `task ${taskId}: auto-merge policy bar lost`,
      hint: 'Restore the required protection posture on the base branch (blocking checks, squash, no bypass, no merge queue); forge merges on the next tick once the bar passes.',
      pr,
      fatalDetails: { bar },
    });
  }

  const checks = await deps.repoHost.requiredChecksGreen(pr);
  if (checks.status === 'pending') {
    await noteWaiting(args, subject, holder, now, `checks pending (${checks.pending_count})`);
    return report(taskId, 'checks_pending', `${checks.pending_count} required check(s) pending`, { pr });
  }
  if (checks.status === 'unknown') {
    await noteProbeFailure(args, subject, holder, now, `checks unknown: ${checks.reason}`);
    return report(taskId, 'probe_unavailable', `required checks unknown: ${checks.reason}`, { pr });
  }
  if (checks.status === 'red') {
    return reportRedCi(args, deps, record, checks, holder, now);
  }

  // ── 5. Green + exact head + policy intact → reserve, then merge ──
  return mergeUnderReservation(args, deps, record, holder, now);
}

// ─── Journal helpers (no task-state writes — plan v5 Δ17) ────────────────────

async function noteProbeFailure(
  args: MergeTickArgs,
  subject: ReconciliationSubject,
  holder: CasHolderIdentity,
  now: () => Date,
  detail: string,
): Promise<void> {
  try {
    updateReconciliationRecord(args.forgeDir, args.taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => ({
        ...cur,
        last_probed_at: now().toISOString(),
        last_probe_outcome: detail.slice(0, 200),
        probe_failure_streak: cur.probe_failure_streak + 1,
      }),
    });
  } catch {
    // journal is diagnostic; a failure here never blocks reconciliation
  }
}

async function noteWaiting(
  args: MergeTickArgs,
  subject: ReconciliationSubject,
  holder: CasHolderIdentity,
  now: () => Date,
  detail: string,
): Promise<void> {
  try {
    updateReconciliationRecord(args.forgeDir, args.taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => ({
        ...cur,
        last_probed_at: now().toISOString(),
        last_probe_outcome: detail.slice(0, 200),
        // A long-running pending check is EXPECTED waiting — it never feeds
        // the uncertainty streak (plan v5 Δ20).
        probe_failure_streak: 0,
        pending_since: cur.pending_since ?? now().toISOString(),
      }),
    });
  } catch {
    // diagnostic only
  }
}

// Records that a live observation COMPLETED. Every terminal-for-this-tick
// disposition calls it, not just the waiting ones: `last_probed_at` is the
// scan's fairness key, so a task whose observation always ends in an operator
// report (closed PR, drift, taint) would otherwise keep sort key 0 and be
// re-picked ahead of everyone else on every capped scan.
async function noteProbed(
  args: MergeTickArgs,
  subject: ReconciliationSubject,
  holder: CasHolderIdentity,
  now: () => Date,
  detail: string,
): Promise<void> {
  try {
    updateReconciliationRecord(args.forgeDir, args.taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => ({
        ...cur,
        last_probed_at: now().toISOString(),
        last_probe_outcome: detail.slice(0, 200),
        probe_failure_streak: 0,
      }),
    });
  } catch {
    // diagnostic only
  }
}

// ─── Red CI (report only in this ticket) ─────────────────────────────────────

async function reportRedCi(
  args: MergeTickArgs,
  deps: MergeTickDeps,
  record: ShipRecord,
  checks: Extract<ChecksResult, { status: 'red' }>,
  holder: CasHolderIdentity,
  now: () => Date,
): Promise<TickResult> {
  await noteProbed(args, subjectOf(record)!, holder, now, `${checks.failing_count} required check(s) failing`);
  return operatorReport(deps, args.taskId, 'ci_red_reported', {
    failureKey: `${args.taskId}:ci_red:${record.reviewed_head_sha}`,
    detail: `${checks.failing_count} required check(s) failing`,
    reason: `task ${args.taskId}: required checks are red`,
    hint: DEFERRED_HINT,
    pr: record.pr!,
    observed: { failing: checks.failing ?? [] },
    fatalDetails: { failing_count: checks.failing_count, failing: checks.failing ?? [] },
  });
}

// ─── Reservation + merge ─────────────────────────────────────────────────────

async function mergeUnderReservation(
  args: MergeTickArgs,
  deps: MergeTickDeps,
  record: ShipRecord,
  holder: CasHolderIdentity,
  now: () => Date,
): Promise<TickResult> {
  const subject = subjectOf(record)!;
  const ttl = deps.reservationTtlMs ?? 10 * 60 * 1000;

  // The reservation is acquired INSIDE the journal CAS, not decided from an
  // unguarded snapshot: two ticks that both read "no reservation" would
  // otherwise both write one (last writer wins) and both call mergeAtomic.
  // The mutator re-tests the CURRENT record and throws to abort.
  let reservation: MergeReservation;
  try {
    const reserved = updateReconciliationRecord(args.forgeDir, args.taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => {
        const live = cur.merge_reservation;
        if (live && live.status === 'reserved') {
          const age = now().getTime() - Date.parse(live.reserved_at);
          // Takeover is legal only once the holder is stale — and only because
          // the caller reached here on a FRESH not-merged probe.
          if (age < ttl) throw new JournalAbort('contended');
        }
        return {
          ...cur,
          merge_reservation: {
            cycle: record.cycle,
            seq: (live?.seq ?? 0) + 1,
            status: 'reserved',
            owner_run_id: deps.runId,
            reserved_at: now().toISOString(),
            outcome: null,
          },
        };
      },
    });
    reservation = reserved.merge_reservation!;
  } catch (err) {
    return report(
      args.taskId,
      'reservation_contended',
      err instanceof JournalAbort ? 'another tick holds the merge reservation' : 'lost the merge-reservation CAS to a concurrent tick',
      { pr: record.pr! },
    );
  }

  // The ONLY external mutation this ticket performs. A REJECTION (e.g. gh
  // failed to spawn) must not escape: it would leave the reservation held for
  // its whole TTL, skip the fairness stamp, and skip the failure streak.
  let outcome: MergeAttemptOutcome;
  try {
    outcome = await deps.repoHost.mergeAtomic!(record.pr!, record.reviewed_head_sha);
  } catch (err) {
    outcome = { ok: false, reason: 'transport', detail: `merge call threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Settle OUR reservation only: a slow predecessor must never settle the
  // takeover that replaced it (which would admit a third merger).
  const settle = (result: string): void => {
    try {
      updateReconciliationRecord(args.forgeDir, args.taskId, {
        subject,
        holder,
        now,
        mutate: (cur) => {
          const live = cur.merge_reservation;
          const isOurs =
            live !== null &&
            live.seq === reservation.seq &&
            live.cycle === reservation.cycle &&
            live.owner_run_id === reservation.owner_run_id;
          return isOurs ? { ...cur, merge_reservation: { ...live, status: 'settled', outcome: result.slice(0, 200) } } : cur;
        },
      });
    } catch {
      // diagnostic
    }
  };

  if (outcome.ok) {
    settle('ok');
    // NEVER promote on the call's say-so: re-probe for exact proof.
    let confirm: MergeResult;
    try {
      confirm = await deps.repoHost.mergeResult(record.pr!);
    } catch (err) {
      await noteProbed(args, subject, holder, now, 'merge call ok; proof re-read failed');
      return report(args.taskId, 'probe_unavailable', `merge call succeeded; proof re-read failed: ${err instanceof Error ? err.message : String(err)}`, {
        pr: record.pr!,
      });
    }
    if (confirm.merged && exactProof(confirm, record)) {
      return promote(args, deps, record, confirm, holder, now);
    }
    if (confirm.merged) {
      // Merged, but NOT at the reviewed head/base — the call's own tainted
      // detection can be bypassed by a racing external merge.
      await noteProbed(args, subject, holder, now, 'merge landed at an unreviewed head');
      return operatorReport(deps, args.taskId, 'tainted_reported', {
        failureKey: `${args.taskId}:tainted:${confirm.merged_head_sha}`,
        detail: 'merge call succeeded but the PR merged at an unreviewed head or wrong base',
        reason: `task ${args.taskId} merged at an UNREVIEWED head`,
        hint: 'Revert the merge commit on the base branch and re-ship. forge will never promote a task whose PR merged at an unreviewed head.',
        pr: record.pr!,
        expected: { base_branch: record.base!.branch, reviewed_head_sha: record.reviewed_head_sha },
        observed: { base_ref: confirm.base_ref, merged_head_sha: confirm.merged_head_sha },
      });
    }
    await noteProbed(args, subject, holder, now, 'merge call ok; proof not yet observable');
    return report(args.taskId, 'probe_unavailable', 'merge call succeeded but exact proof is not yet observable', {
      pr: record.pr!,
    });
  }

  settle(outcome.reason);
  await noteProbed(args, subject, holder, now, `merge call failed: ${outcome.reason}`);
  switch (outcome.reason) {
    case 'tainted_merge':
      return operatorReport(deps, args.taskId, 'tainted_reported', {
        failureKey: `${args.taskId}:tainted:${outcome.detail.slice(0, 40)}`,
        detail: outcome.detail,
        reason: `task ${args.taskId}: merge landed at an unreviewed head`,
        hint: 'Revert the merge commit on the base branch and re-ship. forge will never promote a task whose PR merged at an unreviewed head.',
        pr: record.pr!,
      });
    case 'pr_closed':
      return operatorReport(deps, args.taskId, 'pr_closed_reported', {
        failureKey: `${args.taskId}:pr_closed:${record.cycle}:${record.pr!.number}`,
        detail: outcome.detail,
        reason: `task ${args.taskId}: PR closed without merging`,
        hint: DEFERRED_HINT,
        pr: record.pr!,
      });
    case 'head_drift':
      return operatorReport(deps, args.taskId, 'drift_reported', {
        failureKey: `${args.taskId}:drift:${outcome.detail.slice(0, 40)}`,
        detail: outcome.detail,
        reason: `task ${args.taskId}: PR head drifted from the reviewed SHA`,
        hint: DEFERRED_HINT,
        pr: record.pr!,
        expected: { reviewed_head_sha: record.reviewed_head_sha },
      });
    case 'checks_not_green':
      return report(args.taskId, 'checks_pending', outcome.detail, { pr: record.pr! });
    case 'protection_rejected':
      return operatorReport(deps, args.taskId, 'policy_loss_reported', {
        failureKey: `${args.taskId}:policy_loss:merge_refused`,
        detail: outcome.detail,
        reason: `task ${args.taskId}: the platform refused the merge`,
        hint: 'Restore the required protection posture; forge merges on the next tick once the bar passes.',
        pr: record.pr!,
      });
    case 'unsupported':
      return operatorReport(deps, args.taskId, 'merge_unsupported_reported', {
        failureKey: `${args.taskId}:merge_unsupported:${record.cycle}`,
        detail: outcome.detail,
        reason: `task ${args.taskId}: forge cannot merge this repository/PR`,
        hint: 'This repository/PR cannot be merged by forge; merge the exact recorded reviewed head manually.',
        pr: record.pr!,
      });
    default: {
      // Unexplained transport failure: journal-only streak (plan v5 Δ17 — NO
      // task-state mutation in this ticket; FORGE-237 converts it to budget).
      const budget = deps.mergeFailureBudget ?? 10;
      let streak = 1;
      try {
        const updated = updateReconciliationRecord(args.forgeDir, args.taskId, {
          subject,
          holder,
          now,
          mutate: (cur) => ({
            ...cur,
            merge_failure_streak: cur.merge_failure_streak + 1,
            last_merge_failure_at: now().toISOString(),
          }),
        });
        streak = updated.merge_failure_streak;
      } catch {
        // diagnostic
      }
      if (streak >= budget) {
        return operatorReport(deps, args.taskId, 'merge_budget_exhausted_reported', {
          failureKey: `${args.taskId}:merge_exhausted:${record.cycle}`,
          detail: `${streak} unexplained merge failures: ${outcome.detail}`,
          reason: `task ${args.taskId}: repeated unexplained merge failures`,
          hint: 'Investigate the platform failure, or merge the exact recorded reviewed head manually.',
          pr: record.pr!,
          fatalDetails: { streak, detail: outcome.detail },
        });
      }
      return report(args.taskId, 'merge_call_failed_reported', outcome.detail, { pr: record.pr! });
    }
  }
}

// ─── Promotion + resume ladder ───────────────────────────────────────────────

async function promote(
  args: MergeTickArgs,
  deps: MergeTickDeps,
  record: ShipRecord,
  proof: Extract<MergeResult, { merged: true }>,
  holder: CasHolderIdentity,
  now: () => Date,
): Promise<TickResult> {
  const { forgeDir, taskId } = args;

  // WRITE-AHEAD: the attestation lands BEFORE the state CAS so a crash after
  // proof is resumable. `mintMergeAttestation` derives the payload from the
  // proof + record itself and re-checks exactness, so nothing here can author
  // a witness the platform did not actually produce. Its fence re-validates
  // the subject under the marker.
  let written: AttestationWrite;
  try {
    written = mintMergeAttestation(forgeDir, taskId, {
      proof,
      record,
      now,
      holder,
      fence: () => {
        const live = readShipRecord(forgeDir, taskId);
        if (live === null || live.revision !== record.revision || live.pr?.number !== record.pr!.number) {
          throw new OrchestratorError('STATE_VERSION_CONFLICT', 'ship record moved while attesting', { taskId });
        }
        // `shipped` is legal here too: the resume ladder attests a task whose
        // state CAS already landed (or a legacy shipped state just re-proven).
        // Any OTHER state means the task left the merge path while we probed.
        const st = readTaskState(forgeDir, taskId);
        if (st.state !== 'merge_pending' && st.state !== 'shipped') {
          throw new OrchestratorError('STALE_ATTEMPT', `task left merge_pending while attesting (${st.state})`, { taskId });
        }
      },
    });
  } catch (err) {
    // The fence refused (ship record or task state moved while we probed) or
    // the write faulted. Both are transient and touched NO task state: report
    // waiting and re-derive from a fresh probe on the next tick.
    return report(taskId, 'probe_unavailable', `attestation deferred: ${err instanceof Error ? err.message : String(err)}`, {
      pr: record.pr!,
    });
  }
  if (written.kind === 'corrupt') {
    return operatorReport(deps, taskId, 'attestation_invalid_reported', {
      failureKey: `${taskId}:attestation_invalid`,
      detail: written.detail,
      reason: `task ${taskId}: merge attestation is corrupt`,
      hint: 'Inspect merge-attestation.json; forge never overwrites a conflicting attestation.',
      pr: record.pr!,
    });
  }

  return finishPromotion(args, deps, written.attestation, holder, now);
}

// The resume ladder (plan v3 Δ13): ensure shipped → ensure tracker Done →
// advisory notification. Runnable from ANY crash point, by tick or gc.
async function finishPromotion(
  args: MergeTickArgs,
  deps: MergeTickDeps,
  attestation: MergeAttestation,
  holder: CasHolderIdentity,
  now: () => Date,
): Promise<TickResult> {
  const { forgeDir, taskId } = args;
  const { commitMergePromotion } = await import('./state-machine.ts');
  let stateVersion: number;
  try {
    stateVersion = commitMergePromotion(forgeDir, taskId, attestation, holder);
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'LEASE_EXISTS') {
      return report(taskId, 'lease_leftover_deferred', 'a live worker lease remains — deferring to gc row 15', {
        pr: attestation.pr,
      });
    }
    return report(taskId, 'probe_unavailable', `promotion commit failed: ${err instanceof Error ? err.message : String(err)}`, {
      pr: attestation.pr,
    });
  }

  // Tracker sync: a post-merge failure can NEVER falsify `shipped` — the
  // repository really did merge. It is a durable sync divergence with its own
  // BOUNDED, idempotent policy (plan v3 Δ13): already-done never re-calls,
  // exhausted never re-calls, and a non-retriable failure exhausts at once.
  const maxAttempts = deps.trackerSyncMaxAttempts ?? 5;
  const subject: ReconciliationSubject = {
    cycle: attestation.cycle,
    pr: attestation.pr,
    reviewed_head_sha: attestation.reviewed_head_sha,
    ship_record_revision: attestation.ship_record_revision,
  };
  // Acquire the attempt INSIDE the journal CAS, OWNER-SCOPED. `pending` alone
  // cannot distinguish "an attempt is in flight" from "settled, retry later":
  // a contender would count the in-flight attempt as consumed and emit a false
  // exhaustion fatal, and a crash mid-call would leave the budget ambiguous
  // forever. The reservation records who and since when, so a contender waits
  // while it is live and a STALE final attempt settles to `failed`.
  const syncTtl = deps.trackerSyncTtlMs ?? 5 * 60 * 1000;
  let attempts: number;
  let priorError = 'tracker sync previously exhausted';
  try {
    const reserved = updateReconciliationRecord(forgeDir, taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => {
        const st = cur.tracker_sync;
        if (st.status === 'done') throw new JournalAbort('sync_done');
        if (st.status === 'failed') {
          priorError = st.last_error ?? priorError;
          throw new JournalAbort('sync_exhausted');
        }
        const inFlight =
          st.owner_run_id !== null &&
          st.reserved_at !== null &&
          now().getTime() - Date.parse(st.reserved_at) < syncTtl &&
          st.owner_run_id !== deps.runId;
        if (inFlight) throw new JournalAbort('sync_in_flight');
        // A stale reservation on the LAST allowed attempt means the owner died
        // mid-call: settle it as failed rather than leaving it pending forever.
        if (st.attempts >= maxAttempts) {
          priorError = st.last_error ?? 'tracker sync abandoned mid-attempt';
          return {
            ...cur,
            tracker_sync: { ...st, status: 'failed', owner_run_id: null, reserved_at: null, last_error: priorError },
          };
        }
        return {
          ...cur,
          tracker_sync: {
            status: 'pending',
            attempts: st.attempts + 1,
            last_error: st.last_error,
            owner_run_id: deps.runId,
            reserved_at: now().toISOString(),
          },
        };
      },
    });
    if (reserved.tracker_sync.status === 'failed') {
      return trackerExhausted(deps, taskId, attestation, reserved.tracker_sync.attempts, priorError);
    }
    attempts = reserved.tracker_sync.attempts;
  } catch (err) {
    if (err instanceof JournalAbort && err.reason === 'sync_done') {
      deps.emitShipped?.(attestation.pr, stateVersion);
      return report(taskId, 'promoted', 'merge proven; task shipped', { pr: attestation.pr });
    }
    if (err instanceof JournalAbort && err.reason === 'sync_in_flight') {
      // Someone else owns this attempt — the merge IS proven and the task IS
      // shipped; only the bookkeeping is another tick's job.
      deps.emitShipped?.(attestation.pr, stateVersion);
      return report(taskId, 'promoted', 'merge proven; task shipped (tracker sync in flight elsewhere)', {
        pr: attestation.pr,
      });
    }
    if (err instanceof JournalAbort && err.reason === 'sync_exhausted') {
      const prior = readReconciliationRecord(forgeDir, taskId)?.tracker_sync.attempts ?? maxAttempts;
      return trackerExhausted(deps, taskId, attestation, prior, priorError);
    }
    // The reservation could not be persisted — do NOT call the tracker without
    // a durable record of the attempt; the next tick retries from a known count.
    deps.emitShipped?.(attestation.pr, stateVersion);
    return report(taskId, 'promoted', 'merge proven; task shipped (tracker sync deferred — journal unavailable)', {
      pr: attestation.pr,
    });
  }

  const res = await deps.tracker.markDone();
  const exhausted = !res.ok && (attempts >= maxAttempts || !res.retriable);

  // Settle ONLY the exact reservation we took. A tick that stalled past the TTL
  // and lost the seat must not write its late answer over the successor's
  // state — nor raise a fatal derived from it.
  let stillOurs = true;
  try {
    updateReconciliationRecord(forgeDir, taskId, {
      subject,
      holder,
      now,
      mutate: (cur) => {
        const st = cur.tracker_sync;
        if (st.status === 'done') {
          stillOurs = false;
          return cur;
        }
        // Exact-token match: owner AND the attempt we reserved. A cleared owner
        // means someone else already settled this slot.
        if (st.owner_run_id !== deps.runId || st.attempts !== attempts) {
          stillOurs = false;
          return cur;
        }
        return {
          ...cur,
          tracker_sync: {
            status: res.ok ? 'done' : exhausted ? 'failed' : 'pending',
            attempts,
            last_error: res.ok ? null : res.detail.slice(0, 500),
            owner_run_id: null,
            reserved_at: null,
          },
        };
      },
    });
  } catch {
    stillOurs = false;
  }

  if (!stillOurs) {
    // Our answer no longer describes the live state; the owner of record will
    // report. The merge itself is proven either way.
    deps.emitShipped?.(attestation.pr, stateVersion);
    return report(taskId, 'promoted', 'merge proven; task shipped (tracker sync owned elsewhere)', {
      pr: attestation.pr,
    });
  }

  deps.emitShipped?.(attestation.pr, stateVersion);

  if (exhausted) {
    return trackerExhausted(deps, taskId, attestation, attempts, (res as { detail: string }).detail);
  }
  return report(taskId, 'promoted', 'merge proven; task shipped', { pr: attestation.pr });
}

function trackerExhausted(
  deps: MergeTickDeps,
  taskId: string,
  attestation: MergeAttestation,
  attempts: number,
  detail: string,
): TickResult {
  return operatorReport(deps, taskId, 'tracker_sync_exhausted_reported', {
    failureKey: `${taskId}:tracker_sync:${attestation.merge_commit_sha}`,
    detail: `shipped; tracker not updated after ${attempts} attempt(s): ${detail}`,
    reason: `task ${taskId}: shipped, but tracker sync exhausted`,
    hint: 'Close the tracker issue manually. The task IS shipped — this is a sync divergence, never a merge problem.',
    pr: attestation.pr,
    fatalDetails: { attempts, detail },
  });
}

// Resume for a task ALREADY `shipped` (crash after the CAS, or a legacy state).
async function resumeShipped(
  args: MergeTickArgs,
  deps: MergeTickDeps,
  holder: CasHolderIdentity,
  now: () => Date,
): Promise<TickResult> {
  const { forgeDir, taskId } = args;
  const att = readMergeAttestation(forgeDir, taskId);
  if (att.kind === 'invalid') {
    return operatorReport(deps, taskId, 'attestation_invalid_reported', {
      failureKey: `${taskId}:attestation_invalid`,
      detail: att.detail,
      reason: `task ${taskId}: merge attestation is corrupt`,
      hint: 'Inspect merge-attestation.json; forge never overwrites a conflicting attestation.',
    });
  }
  if (att.kind === 'valid') {
    return finishPromotion(args, deps, att.attestation, holder, now);
  }

  // `shipped` with NO attestation is NOT proof (legacy/upgraded/corrupted):
  // live-probe BEFORE any tracker mutation (plan v3 Δ13).
  let record: ShipRecord | null;
  try {
    record = readShipRecord(forgeDir, taskId);
  } catch {
    record = null;
  }
  if (record === null || record.pr === null || record.base === null) {
    return operatorReport(deps, taskId, 'shipped_unproven_reported', {
      failureKey: `${taskId}:shipped_unproven`,
      detail: 'state is shipped but no PR identity exists to prove it',
      reason: `task ${taskId}: local state says shipped with no PR identity`,
      hint: 'Verify the merge manually; forge will not sync the tracker without proof.',
    });
  }
  let proof: MergeResult;
  try {
    proof = await deps.repoHost.mergeResult(record.pr);
  } catch (err) {
    return report(taskId, 'probe_unavailable', `cannot verify legacy shipped state: ${err instanceof Error ? err.message : String(err)}`, {
      pr: record.pr,
    });
  }
  if (!proof.merged || !exactProof(proof, record)) {
    return operatorReport(deps, taskId, 'shipped_unproven_reported', {
      failureKey: `${taskId}:shipped_unproven`,
      detail: 'local state says shipped but live proof disagrees',
      reason: `task ${taskId}: local state says shipped but the PR is not proven merged`,
      hint: 'Reconcile manually; forge refuses to sync the tracker for an unproven shipped state.',
      pr: record.pr,
    });
  }
  return promote(args, deps, record, proof, holder, now);
}
