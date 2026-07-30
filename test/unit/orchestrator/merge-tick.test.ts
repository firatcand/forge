// FORGE-235: the merge-tick matrix (plan v5 Δ23). Hermetic — FakeRepoHost +
// injected tracker; no live processes.
//
// The load-bearing assertion throughout: EVERY non-terminal disposition leaves
// state.json BYTE-IDENTICAL. FORGE-235's only task-state write is the terminal
// promotion; FORGE-237 owns every other exit from merge_pending.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OPERATOR_DISPOSITIONS,
  WAITING_DISPOSITIONS,
  isOperatorAction,
  runMergeTick,
  type Disposition,
  type MergeTickDeps,
  type TickResult,
} from '../../../src/orchestrator/merge-tick.ts';
import {
  readMergeAttestation,
  readReconciliationRecord,
} from '../../../src/orchestrator/reconciliation-record.ts';
import { FakeRepoHost, type FakeRepoHostScript } from '../../../src/repo-hosts/fake.ts';
import type { MergeAttemptOutcome, MergeResult, ProbeReport, PullRequestRef } from '../../../src/repo-hosts/types.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
const TASK = 'FORGE-M1';
const REPO = 'octo/base';
const PR: PullRequestRef = { repo: REPO, number: 12, url: `https://github.com/${REPO}/pull/12` };
const STATE_VERSION = 7;

const OPEN: MergeResult = { merged: false, state: 'open' };
const MERGED_EXACT: MergeResult = {
  merged: true,
  base_ref: 'main',
  merge_commit_sha: MERGE_COMMIT,
  merged_head_sha: SHA,
};
const BAR_PASSING: ProbeReport = {
  ok: true,
  blocking_check_count: 2,
  squash_allowed: true,
  write_permission: true,
  bypass_rules_present: false,
  merge_queue_enabled: false,
};

interface Fx {
  forgeDir: string;
  taskDir: string;
  statePath: string;
  stateBefore: string;
}

function fixture(opts: { state?: string; pr?: unknown; cycle?: number } = {}): Fx {
  const forgeDir = mkdtempSync(join(tmpdir(), 'forge-235-'));
  const taskDir = join(forgeDir, 'orchestrator', 'tasks', TASK);
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: 1, task_id: TASK, state: opts.state ?? 'merge_pending', state_version: STATE_VERSION,
        attempt_count: 1, failure_count: 0, last_failure_key: null, review_attempt_count: 1,
        ship_attempt_count: 1, current_attempt_id: 'att-ship', updated_at: new Date().toISOString(),
        updated_by: { run_id: 'run-1', claim_id: 'claim-1', generation: 0 },
      },
      null,
      2,
    ),
  );
  // A released tombstone is the normal merge_pending shape (FORGE-231 gc row 15
  // releases the worker lease on entry).
  writeFileSync(
    join(taskDir, 'lease.json'),
    JSON.stringify({
      version: 1, status: 'released', task_id: TASK, lease_version: 2, last_generation: 0,
      released_at: new Date().toISOString(),
      released_by: { run_id: 'run-1', claim_id: 'claim-1', generation: 0 },
    }),
  );
  writeFileSync(
    join(taskDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: TASK, revision: 3, reviewed_head_sha: SHA, review_attempt_id: 'att-rev',
      cycle: opts.cycle ?? 1,
      base: { repo: REPO, branch: 'main', push_remote: 'origin' },
      pr: opts.pr === undefined ? PR : opts.pr,
      merge_attempt: 'submitted', updated_at: new Date().toISOString(),
    }),
  );
  return { forgeDir, taskDir, statePath, stateBefore: readFileSync(statePath, 'utf8') };
}

interface Harness {
  deps: MergeTickDeps;
  fatals: { key: string; reason: string }[];
  shipped: { pr: PullRequestRef; version: number }[];
  trackerCalls: () => number;
  mergeCalls: () => number;
}

/** Default script: an OPEN PR at the reviewed head, green checks, bar passing. */
function harness(
  over: {
    script?: FakeRepoHostScript;
    repoHost?: MergeTickDeps['repoHost'];
    tracker?: MergeTickDeps['tracker'];
    trackerSyncMaxAttempts?: number;
    mergeFailureBudget?: number;
    /** Production mints a unique id per invocation; concurrency tests need that. */
    runId?: string;
  } = {},
): Harness {
  const fatals: { key: string; reason: string }[] = [];
  const shipped: { pr: PullRequestRef; version: number }[] = [];
  let trackerCalls = 0;
  const fake = new FakeRepoHost({
    mergeResult: OPEN,
    headSha: { ok: true, sha: SHA },
    probe: BAR_PASSING,
    checks: { status: 'green' },
    ...over.script,
  });
  const host = over.repoHost ?? (fake as unknown as MergeTickDeps['repoHost']);
  const deps: MergeTickDeps = {
    repoHost: host,
    runId: over.runId ?? 'run-tick',
    tracker: over.tracker ?? {
      markDone: async () => {
        trackerCalls += 1;
        return { ok: true as const };
      },
    },
    trackerSyncMaxAttempts: over.trackerSyncMaxAttempts,
    mergeFailureBudget: over.mergeFailureBudget,
    emitFatal: (key, reason) => fatals.push({ key, reason }),
    emitShipped: (pr, version) => shipped.push({ pr, version }),
  };
  return {
    deps,
    fatals,
    shipped,
    trackerCalls: () => trackerCalls,
    mergeCalls: () => fake.calls.filter((c) => c.op === 'mergeAtomic').length,
  };
}

const run = (fx: Fx, deps: MergeTickDeps, policy: 'approval' | 'auto' = 'approval'): Promise<TickResult> =>
  runMergeTick({ forgeDir: fx.forgeDir, taskId: TASK, mergePolicy: policy }, deps);

/** The invariant: a non-terminal disposition mutates NOTHING in task state. */
function assertStateUntouched(fx: Fx, label: string): void {
  assert.equal(readFileSync(fx.statePath, 'utf8'), fx.stateBefore, `${label}: task state must be byte-identical`);
}

const attestationPath = (fx: Fx): string => join(fx.taskDir, 'merge-attestation.json');

// ─── Promotion — the ONE task-state write ────────────────────────────────────

test('exact live proof → promoted: attestation written, shipped, tracker synced, notified', async () => {
  const fx = fixture();
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'promoted');
  const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
  assert.equal(state.state, 'shipped');
  assert.equal(state.state_version, STATE_VERSION + 1);
  assert.equal(state.updated_by.run_id, 'run-tick');

  const att = readMergeAttestation(fx.forgeDir, TASK);
  assert.equal(att.kind, 'valid');
  if (att.kind === 'valid') {
    assert.equal(att.attestation.merged_head_sha, SHA);
    assert.equal(att.attestation.merge_commit_sha, MERGE_COMMIT);
    assert.equal(att.attestation.ship_record_revision, 3);
    assert.equal(att.attestation.base_branch, 'main');
  }
  assert.equal(h.trackerCalls(), 1);
  assert.deepEqual(h.shipped, [{ pr: PR, version: STATE_VERSION + 1 }]);
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'done');
});

test('merged at an UNREVIEWED head → tainted_reported + keyed fatal; never shipped, never attested', async () => {
  const fx = fixture();
  const h = harness({
    script: { mergeResult: { merged: true, base_ref: 'main', merge_commit_sha: MERGE_COMMIT, merged_head_sha: OTHER } },
  });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'tainted_reported');
  assert.equal(res.failure_key, `${TASK}:tainted:${OTHER}`);
  assert.equal(res.expected?.reviewed_head_sha, SHA);
  assert.equal(res.observed?.merged_head_sha, OTHER);
  assertStateUntouched(fx, 'tainted');
  assert.equal(existsSync(attestationPath(fx)), false, 'a tainted merge must never produce an attestation');
  assert.equal(h.fatals.length, 1);
  assert.equal(h.fatals[0]!.key, `${TASK}:tainted:${OTHER}`);
});

test('merged into the WRONG base → tainted_reported', async () => {
  const fx = fixture();
  const h = harness({
    script: { mergeResult: { merged: true, base_ref: 'release', merge_commit_sha: MERGE_COMMIT, merged_head_sha: SHA } },
  });
  const res = await run(fx, h.deps);
  assert.equal(res.disposition, 'tainted_reported');
  assert.equal(res.observed?.base_ref, 'release');
  assertStateUntouched(fx, 'wrong base');
  assert.equal(existsSync(attestationPath(fx)), false);
});

// ─── Non-terminal reports — ZERO mutation ────────────────────────────────────

test('PR closed unmerged → pr_closed_reported + keyed fatal + truthful hint', async () => {
  const fx = fixture();
  const h = harness({ script: { mergeResult: { merged: false, state: 'closed_unmerged' } } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'pr_closed_reported');
  assert.equal(res.failure_key, `${TASK}:pr_closed:1:12`);
  assert.match(res.action_hint ?? '', /FORGE-237/, 'the hint must not promise a transition forge cannot perform');
  assert.doesNotMatch(res.action_hint ?? '', /re-?claim|forge orchestrate cancel/i);
  assertStateUntouched(fx, 'pr_closed');
});

test('head drift → drift_reported carrying expected vs observed', async () => {
  const fx = fixture();
  const h = harness({ script: { headSha: { ok: true, sha: OTHER } } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'drift_reported');
  assert.equal(res.failure_key, `${TASK}:drift:${OTHER}`);
  assert.equal(res.expected?.reviewed_head_sha, SHA);
  assert.equal(res.observed?.head_sha, OTHER);
  assertStateUntouched(fx, 'drift');
});

test('red CI (auto) → ci_red_reported carrying the REAL failing payload', async () => {
  const fx = fixture();
  const failing = [
    { name: 'test (22.x)', bucket: 'fail' },
    { name: 'lint', bucket: 'fail' },
  ];
  const h = harness({ script: { checks: { status: 'red', failing_count: 2, failing } } });
  const res = await run(fx, h.deps, 'auto');

  assert.equal(res.disposition, 'ci_red_reported');
  assert.equal(res.failure_key, `${TASK}:ci_red:${SHA}`);
  assert.deepEqual(res.observed?.failing, failing);
  assertStateUntouched(fx, 'red ci');
});

test('probe bar lost (auto) → policy_loss_reported and NO merge attempted', async () => {
  const fx = fixture();
  const h = harness({ script: { probe: { ...BAR_PASSING, merge_queue_enabled: true } } });
  const res = await run(fx, h.deps, 'auto');

  assert.equal(res.disposition, 'policy_loss_reported');
  assert.match(res.detail, /merge queue/);
  assert.equal(h.mergeCalls(), 0, 'the bar is evaluated BEFORE any merge call');
  assertStateUntouched(fx, 'policy loss');
});

test('malformed ship record → ship_record_invalid_reported', async () => {
  const fx = fixture({ pr: null });
  const h = harness();
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'ship_record_invalid_reported');
  // A corrupt record is NOT a deferred lifecycle transition — the honest hint
  // is "repair the durable files", not "FORGE-237 will do it".
  assert.match(res.action_hint ?? '', /unreadable or declares another task_id/);
  assert.equal(h.fatals.length, 1, 'operator action always emits a keyed fatal');
  assertStateUntouched(fx, 'record invalid');
});

test('a task that is not merge_pending is left completely alone', async () => {
  const fx = fixture({ state: 'running' });
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'not_merge_pending');
  assert.equal(isOperatorAction(res.disposition), false);
  assertStateUntouched(fx, 'not merge_pending');
  assert.equal(existsSync(attestationPath(fx)), false);
});

// ─── Waiting class — journal only, never a fatal ─────────────────────────────

test('probe transport failure → probe_unavailable (no fatal), uncertainty streak recorded', async () => {
  const fx = fixture();
  // An unscripted FakeRepoHost throws on mergeResult — a transport-shaped fault.
  const h = harness({ repoHost: new FakeRepoHost({}) as unknown as MergeTickDeps['repoHost'] });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'probe_unavailable');
  assert.equal(isOperatorAction(res.disposition), false);
  assert.equal(h.fatals.length, 0, 'waiting dispositions never emit fatals');
  assertStateUntouched(fx, 'probe unavailable');
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.probe_failure_streak, 1);
});

test('unknown merge state → probe_unavailable, streak advances across ticks', async () => {
  const fx = fixture();
  for (let i = 0; i < 2; i += 1) {
    const h = harness({ script: { mergeResult: { merged: false, state: 'unknown', reason: 'gh rate limited' } } });
    const res = await run(fx, h.deps);
    assert.equal(res.disposition, 'probe_unavailable');
  }
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.probe_failure_streak, 2);
  assertStateUntouched(fx, 'unknown state');
});

test('pending checks are EXPECTED waiting: pending_since set, uncertainty streak stays 0', async () => {
  const fx = fixture();
  const h = harness({ script: { checks: { status: 'pending', pending_count: 3 } } });
  const res = await run(fx, h.deps, 'auto');

  assert.equal(res.disposition, 'checks_pending');
  const journal = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(journal?.probe_failure_streak, 0, 'a long CI run is not uncertainty');
  assert.ok(journal?.pending_since, 'pending_since anchors how long the wait has run');
  assertStateUntouched(fx, 'checks pending');
});

test('a journal subject change RESETS stale observation status', async () => {
  const fx = fixture();
  const h1 = harness({ repoHost: new FakeRepoHost({}) as unknown as MergeTickDeps['repoHost'] });
  await run(fx, h1.deps);
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.probe_failure_streak, 1);

  // A refreshed PR (new subject) must not inherit the previous streak.
  const record = JSON.parse(readFileSync(join(fx.taskDir, 'ship-record.json'), 'utf8'));
  writeFileSync(
    join(fx.taskDir, 'ship-record.json'),
    JSON.stringify({ ...record, revision: 4, pr: { ...PR, number: 13, url: `https://github.com/${REPO}/pull/13` } }),
  );
  const h2 = harness({ script: { checks: { status: 'pending', pending_count: 1 } } });
  await run(fx, h2.deps, 'auto');

  const journal = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(journal?.probe_failure_streak, 0);
  assert.equal(journal?.subject.pr.number, 13);
  assert.equal(journal?.subject.ship_record_revision, 4);
});

// ─── Policy separation ───────────────────────────────────────────────────────

test('approval policy NEVER merges: open + green + exact head → waits', async () => {
  const fx = fixture();
  const h = harness({ script: { mergeAttempt: { ok: true, merge_commit_sha: MERGE_COMMIT } } });
  const res = await run(fx, h.deps, 'approval');

  assert.equal(res.disposition, 'checks_pending');
  assert.equal(h.mergeCalls(), 0, 'approval policy must never call mergeAtomic');
  assertStateUntouched(fx, 'approval');
});

test('an OBSERVER (gc) has no merge capability → reservation_contended, never a merge', async () => {
  const fx = fixture();
  const base = new FakeRepoHost({ mergeResult: OPEN, headSha: { ok: true, sha: SHA }, probe: BAR_PASSING, checks: { status: 'green' } });
  const observer: MergeTickDeps['repoHost'] = {
    mergeResult: (pr) => base.mergeResult(pr),
    headSha: (pr) => base.headSha(pr),
    probe: () => base.probe(),
    requiredChecksGreen: (pr) => base.requiredChecksGreen(pr),
  };
  const res = await run(fx, harness({ repoHost: observer }).deps, 'auto');

  assert.equal(res.disposition, 'reservation_contended');
  assert.match(res.detail, /observer cannot merge/);
  assert.equal(base.calls.filter((c) => c.op === 'mergeAtomic').length, 0);
  assertStateUntouched(fx, 'observer');
});

test('an observer still PROMOTES on exact proof — reconciliation needs no merge capability', async () => {
  const fx = fixture();
  const observerOnly: MergeTickDeps['repoHost'] = {
    mergeResult: async () => MERGED_EXACT,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
  };
  const res = await run(fx, harness({ repoHost: observerOnly }).deps, 'approval');

  assert.equal(res.disposition, 'promoted');
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).state, 'shipped');
});

// ─── Auto merge + reservation ────────────────────────────────────────────────

test('auto: green + exact head → exactly ONE mergeAtomic, promotion only on re-probed proof', async () => {
  const fx = fixture();
  let merges = 0;
  let probes = 0;
  const host: MergeTickDeps['repoHost'] = {
    mergeResult: async () => {
      probes += 1;
      return probes === 1 ? OPEN : MERGED_EXACT;
    },
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => {
      merges += 1;
      return { ok: true, merge_commit_sha: MERGE_COMMIT };
    },
  };
  const res = await run(fx, harness({ repoHost: host }).deps, 'auto');

  assert.equal(res.disposition, 'promoted');
  assert.equal(merges, 1, 'exactly one merge call');
  assert.equal(probes, 2, 'the merge call is never its own proof — the tick re-probes');
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).state, 'shipped');
});

test('merge call OK but proof not yet observable → waits; NEVER shipped on the call say-so', async () => {
  const fx = fixture();
  const host: MergeTickDeps['repoHost'] = {
    mergeResult: async () => OPEN, // proof never becomes visible
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => ({ ok: true, merge_commit_sha: MERGE_COMMIT }),
  };
  const res = await run(fx, harness({ repoHost: host }).deps, 'auto');

  assert.equal(res.disposition, 'probe_unavailable');
  assertStateUntouched(fx, 'unproven merge call');
  assert.equal(existsSync(attestationPath(fx)), false);
});

test('a live reservation blocks a concurrent tick — no second merge call', async () => {
  const fx = fixture();
  let merges = 0;
  const mkHost = (): MergeTickDeps['repoHost'] => ({
    mergeResult: async () => OPEN,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => {
      merges += 1;
      return { ok: false, reason: 'transport', detail: 'timeout' };
    },
  });
  await run(fx, harness({ repoHost: mkHost() }).deps, 'auto');
  assert.equal(merges, 1);

  // Re-open the reservation as if tick A were still in flight.
  const journalPath = join(fx.taskDir, 'reconciliation.json');
  const j = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(
    journalPath,
    JSON.stringify({
      ...j,
      merge_reservation: { ...j.merge_reservation, status: 'reserved', reserved_at: new Date().toISOString() },
    }),
  );

  const res = await run(fx, harness({ repoHost: mkHost() }).deps, 'auto');
  assert.equal(res.disposition, 'reservation_contended');
  assert.equal(merges, 1, 'the contending tick must NOT call mergeAtomic');
  assertStateUntouched(fx, 'reservation contended');
});

test('every mergeAtomic failure reason maps to exactly one disposition (table-driven, exhaustive)', async () => {
  const REASONS: Record<Extract<MergeAttemptOutcome, { ok: false }>['reason'], Disposition> = {
    tainted_merge: 'tainted_reported',
    pr_closed: 'pr_closed_reported',
    head_drift: 'drift_reported',
    checks_not_green: 'checks_pending',
    protection_rejected: 'policy_loss_reported',
    unsupported: 'merge_unsupported_reported',
    transport: 'merge_call_failed_reported',
  };
  for (const [reason, disposition] of Object.entries(REASONS)) {
    const fx = fixture();
    const host: MergeTickDeps['repoHost'] = {
      mergeResult: async () => OPEN,
      headSha: async () => ({ ok: true, sha: SHA }),
      probe: async () => BAR_PASSING,
      requiredChecksGreen: async () => ({ status: 'green' }),
      mergeAtomic: async () => ({ ok: false, reason: reason as 'transport', detail: `${reason} detail` }),
    };
    const res = await run(fx, harness({ repoHost: host }).deps, 'auto');
    assert.equal(res.disposition, disposition, `${reason} → ${disposition}`);
    assertStateUntouched(fx, reason);
    assert.equal(existsSync(attestationPath(fx)), false, `${reason} must not attest`);
    // The reservation always settles — a failed merge never strands the seat.
    assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.merge_reservation?.status, 'settled');
  }
});

test('repeated unexplained merge failures REPORT exhaustion — journal streak only, no budget charge', async () => {
  const fx = fixture();
  const mkHost = (): MergeTickDeps['repoHost'] => ({
    mergeResult: async () => OPEN,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => ({ ok: false, reason: 'transport', detail: 'i/o timeout' }),
  });
  let last: TickResult | null = null;
  for (let i = 0; i < 3; i += 1) {
    last = await run(fx, harness({ repoHost: mkHost(), mergeFailureBudget: 3 }).deps, 'auto');
  }

  assert.equal(last?.disposition, 'merge_budget_exhausted_reported');
  assert.equal(last?.failure_key, `${TASK}:merge_exhausted:1`);
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.merge_failure_streak, 3);
  const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
  assert.equal(state.failure_count, 0, 'FORGE-235 never charges the task budget (FORGE-237 does)');
  assertStateUntouched(fx, 'merge budget');
});

// ─── Resume ladder ───────────────────────────────────────────────────────────

test('shipped WITHOUT attestation is live-probed BEFORE any tracker mutation', async () => {
  const fx = fixture({ state: 'shipped' });
  const h = harness({ script: { mergeResult: OPEN } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'shipped_unproven_reported');
  assert.equal(res.failure_key, `${TASK}:shipped_unproven`);
  assert.equal(h.trackerCalls(), 0, 'never sync the tracker for an unproven shipped state');
});

test('shipped without attestation but WITH exact proof → attestation backfilled, tracker synced', async () => {
  const fx = fixture({ state: 'shipped' });
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'promoted');
  assert.equal(readMergeAttestation(fx.forgeDir, TASK).kind, 'valid');
  assert.equal(h.trackerCalls(), 1);
  assertStateUntouched(fx, 'shipped resume');
});

test('a corrupt attestation is operator action — never treated as absent', async () => {
  const fx = fixture({ state: 'shipped' });
  writeFileSync(attestationPath(fx), '{ not json');
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'attestation_invalid_reported');
  assert.equal(h.trackerCalls(), 0);
  assert.equal(readFileSync(attestationPath(fx), 'utf8'), '{ not json', 'never overwritten');
});

test('a DIFFERENT existing attestation is corruption — promotion refuses to overwrite it', async () => {
  const fx = fixture();
  const foreign = {
    version: 1, task_id: TASK, cycle: 1, pr: PR, base_repo: REPO, base_branch: 'main',
    reviewed_head_sha: OTHER, merged_head_sha: OTHER, merge_commit_sha: 'd'.repeat(40),
    ship_record_revision: 3, attested_at: new Date().toISOString(),
  };
  writeFileSync(attestationPath(fx), JSON.stringify(foreign));
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'attestation_invalid_reported');
  assert.deepEqual(JSON.parse(readFileSync(attestationPath(fx), 'utf8')), foreign);
  assertStateUntouched(fx, 'foreign attestation');
});

test('re-ticking after promotion is idempotent — no second transition, attestation replayed', async () => {
  const fx = fixture();
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT } }).deps);
  const afterFirst = readFileSync(fx.statePath, 'utf8');
  const attFirst = readFileSync(attestationPath(fx), 'utf8');

  const res = await run(fx, harness({ script: { mergeResult: MERGED_EXACT } }).deps);
  assert.equal(res.disposition, 'promoted');
  assert.equal(readFileSync(fx.statePath, 'utf8'), afterFirst, 'no second state transition');
  assert.equal(readFileSync(attestationPath(fx), 'utf8'), attFirst, 'attestation is create-only');
});

test('a LIVE worker lease defers promotion to gc row 15 instead of reconciling under it', async () => {
  const fx = fixture();
  writeFileSync(
    join(fx.taskDir, 'lease.json'),
    JSON.stringify({
      version: 1, claim_id: 'c-live', task_id: TASK, attempt_id: null, owner_run_id: 'run-other',
      acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
      last_heartbeat_at: new Date().toISOString(), generation: 0, spec_revision: 'digest:empty',
    }),
  );
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'lease_leftover_deferred');
  assert.equal(isOperatorAction(res.disposition), false);
  assert.equal(h.trackerCalls(), 0);
  assertStateUntouched(fx, 'live lease');
});

test('post-merge tracker exhaustion NEVER falsifies shipped', async () => {
  const fx = fixture();
  let last: TickResult | null = null;
  for (let i = 0; i < 3; i += 1) {
    last = await run(
      fx,
      harness({
        script: { mergeResult: MERGED_EXACT },
        trackerSyncMaxAttempts: 2,
        tracker: { markDone: async () => ({ ok: false, retriable: true, detail: 'tracker down' }) },
      }).deps,
    );
  }

  assert.equal(last?.disposition, 'tracker_sync_exhausted_reported');
  assert.equal(last?.failure_key, `${TASK}:tracker_sync:${MERGE_COMMIT}`);
  assert.match(last?.action_hint ?? '', /task IS shipped/i);
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).state, 'shipped', 'the repository really did merge');
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'failed');
});

// ─── Disposition contract ────────────────────────────────────────────────────

test('the waiting and operator-action classes partition the Disposition union', () => {
  const waiting = new Set<string>(WAITING_DISPOSITIONS);
  const operator = new Set<string>(OPERATOR_DISPOSITIONS);
  assert.equal(waiting.size, WAITING_DISPOSITIONS.length, 'no duplicate waiting dispositions');
  assert.equal(operator.size, OPERATOR_DISPOSITIONS.length, 'no duplicate operator dispositions');
  for (const d of operator) assert.equal(waiting.has(d), false, `${d} cannot be both classes`);
  for (const d of OPERATOR_DISPOSITIONS) assert.equal(isOperatorAction(d), true);
  for (const d of WAITING_DISPOSITIONS) assert.equal(isOperatorAction(d), false);
});

test('every operator-action report carries a failure_key and an action hint', async () => {
  // Guards the routing contract: FORGE-237 and the operator surface dedup on
  // failure_key, so an operator-action report without one is unroutable.
  const cases: { fx: Fx; script: FakeRepoHostScript; policy: 'approval' | 'auto' }[] = [
    { fx: fixture(), script: { mergeResult: { merged: true, base_ref: 'main', merge_commit_sha: MERGE_COMMIT, merged_head_sha: OTHER } }, policy: 'approval' },
    { fx: fixture(), script: { mergeResult: { merged: false, state: 'closed_unmerged' } }, policy: 'approval' },
    { fx: fixture(), script: { headSha: { ok: true, sha: OTHER } }, policy: 'approval' },
    { fx: fixture(), script: { checks: { status: 'red', failing_count: 1 } }, policy: 'auto' },
    { fx: fixture(), script: { probe: { ...BAR_PASSING, squash_allowed: false } }, policy: 'auto' },
    { fx: fixture({ pr: null }), script: {}, policy: 'approval' },
    { fx: fixture({ state: 'shipped' }), script: { mergeResult: OPEN }, policy: 'approval' },
  ];
  for (const c of cases) {
    const res = await run(c.fx, harness({ script: c.script }).deps, c.policy);
    assert.equal(isOperatorAction(res.disposition), true, `${res.disposition} should be operator action`);
    assert.ok(res.failure_key, `${res.disposition} must carry a failure_key`);
    assert.ok(res.action_hint, `${res.disposition} must carry an action hint`);
  }
});

// ─── Regressions from the FORGE-235 implementation review ────────────────────

test('a ship record belonging to ANOTHER task can never ship this one', async () => {
  // A copied/restored .forge tree puts task B's record under task A. Without a
  // path↔payload binding the tick would probe B's PR and ship A on B's merge.
  const fx = fixture();
  const foreign = JSON.parse(readFileSync(join(fx.taskDir, 'ship-record.json'), 'utf8'));
  writeFileSync(join(fx.taskDir, 'ship-record.json'), JSON.stringify({ ...foreign, task_id: 'FORGE-OTHER' }));
  const h = harness({ script: { mergeResult: MERGED_EXACT } });

  const res = await run(fx, h.deps);
  assert.equal(res.disposition, 'ship_record_invalid_reported');
  assertStateUntouched(fx, 'foreign ship record');
  assert.equal(existsSync(attestationPath(fx)), false);
});

test('a state file belonging to ANOTHER task is refused before any network call', async () => {
  const fx = fixture();
  const foreign = JSON.parse(readFileSync(fx.statePath, 'utf8'));
  writeFileSync(fx.statePath, JSON.stringify({ ...foreign, task_id: 'FORGE-OTHER' }));
  const host = new FakeRepoHost({});
  const h = harness({ repoHost: host as unknown as MergeTickDeps['repoHost'] });

  const res = await run(fx, h.deps);
  assert.equal(res.disposition, 'ship_record_invalid_reported');
  assert.deepEqual(host.calls, [], 'a misbound task is never probed');
});

test('promotion refuses when the durable attestation was deleted between mint and commit', async () => {
  // Simulates the write-ahead artifact vanishing: the in-memory proof must not
  // be sufficient on its own.
  const fx = fixture();
  const { commitMergePromotion } = await import('../../../src/orchestrator/state-machine.ts');
  const fabricated = {
    version: 1 as const, task_id: TASK, cycle: 1, pr: PR, base_repo: REPO, base_branch: 'main',
    reviewed_head_sha: SHA, merged_head_sha: SHA, merge_commit_sha: MERGE_COMMIT,
    ship_record_revision: 3, attested_at: new Date().toISOString(),
  };
  assert.throws(
    () => commitMergePromotion(fx.forgeDir, TASK, fabricated, { run_id: 'r', claim_id: 'c', generation: 0 }),
    (err: unknown) => (err as { code?: string }).code === 'MERGE_PROOF_MISSING',
  );
  assertStateUntouched(fx, 'fabricated attestation');
});

test('promotion refuses when the ship-record binding moved after the proof', async () => {
  const fx = fixture();
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT } }).deps); // mints a real attestation + ships
  // Roll the task back to merge_pending with an ADVANCED record revision, as a
  // concurrent re-ship would.
  const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
  writeFileSync(fx.statePath, JSON.stringify({ ...state, state: 'merge_pending', state_version: 20 }, null, 2));
  const record = JSON.parse(readFileSync(join(fx.taskDir, 'ship-record.json'), 'utf8'));
  writeFileSync(join(fx.taskDir, 'ship-record.json'), JSON.stringify({ ...record, revision: 9 }));
  const before = readFileSync(fx.statePath, 'utf8');

  const att = readMergeAttestation(fx.forgeDir, TASK);
  assert.equal(att.kind, 'valid');
  const { commitMergePromotion } = await import('../../../src/orchestrator/state-machine.ts');
  if (att.kind === 'valid') {
    assert.throws(
      () => commitMergePromotion(fx.forgeDir, TASK, att.attestation, { run_id: 'r', claim_id: 'c', generation: 0 }),
      (err: unknown) => (err as { code?: string }).code === 'STATE_VERSION_CONFLICT',
    );
  }
  assert.equal(readFileSync(fx.statePath, 'utf8'), before);
});

test('a concurrent tick cannot slip a second mergeAtomic past the reservation', async () => {
  // Both ticks observe "no reservation" before either writes one. The CAS-internal
  // acquisition must let exactly one through.
  const fx = fixture();
  let merges = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const mkHost = (blocking: boolean): MergeTickDeps['repoHost'] => ({
    mergeResult: async () => OPEN,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => {
      merges += 1;
      if (blocking) await gate; // hold the first tick inside its merge call
      return { ok: false, reason: 'transport', detail: 'held' };
    },
  });
  const first = run(fx, harness({ repoHost: mkHost(true) }).deps, 'auto');
  await new Promise((r) => setImmediate(r));
  const second = await run(fx, harness({ repoHost: mkHost(false) }).deps, 'auto');
  release!();
  await first;

  assert.equal(second.disposition, 'reservation_contended');
  assert.equal(merges, 1, 'exactly one merge call survived the race');
});

test('a settled reservation belongs to its owner — a stale tick cannot settle a takeover', async () => {
  const fx = fixture();
  const mkHost = (): MergeTickDeps['repoHost'] => ({
    mergeResult: async () => OPEN,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => ({ ok: false, reason: 'transport', detail: 'x' }),
  });
  await run(fx, harness({ repoHost: mkHost() }).deps, 'auto');
  // Someone else took the seat over after ours settled.
  const journalPath = join(fx.taskDir, 'reconciliation.json');
  const j = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(
    journalPath,
    JSON.stringify({
      ...j,
      merge_reservation: { cycle: 1, seq: 99, status: 'reserved', owner_run_id: 'someone-else', reserved_at: new Date().toISOString(), outcome: null },
    }),
  );
  const res = await run(fx, harness({ repoHost: mkHost() }).deps, 'auto');

  assert.equal(res.disposition, 'reservation_contended');
  const after = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(after?.merge_reservation?.owner_run_id, 'someone-else');
  assert.equal(after?.merge_reservation?.status, 'reserved', "another owner's reservation is never settled for them");
});

test('tracker sync never re-calls once done, and never exceeds its budget', async () => {
  const fx = fixture();
  let calls = 0;
  const tracker = {
    markDone: async () => {
      calls += 1;
      return { ok: true as const };
    },
  };
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker }).deps);
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker }).deps);
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker }).deps);
  assert.equal(calls, 1, 'a synced tracker is never touched again');

  const fx2 = fixture();
  let failCalls = 0;
  const failing = {
    markDone: async () => {
      failCalls += 1;
      return { ok: false as const, retriable: true, detail: 'down' };
    },
  };
  for (let i = 0; i < 5; i += 1) {
    await run(fx2, harness({ script: { mergeResult: MERGED_EXACT }, tracker: failing, trackerSyncMaxAttempts: 2 }).deps);
  }
  assert.equal(failCalls, 2, 'the attempt budget is a real bound across ticks');
});

test('a NON-retriable tracker failure exhausts immediately instead of burning the budget', async () => {
  const fx = fixture();
  let calls = 0;
  const res = await run(
    fx,
    harness({
      script: { mergeResult: MERGED_EXACT },
      trackerSyncMaxAttempts: 5,
      tracker: {
        markDone: async () => {
          calls += 1;
          return { ok: false as const, retriable: false, detail: 'issue was deleted' };
        },
      },
    }).deps,
  );
  assert.equal(res.disposition, 'tracker_sync_exhausted_reported');
  assert.equal(calls, 1);
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'failed');
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).state, 'shipped');
});

test('EVERY operator disposition emits a keyed fatal, whichever path observed it', async () => {
  // Before centralization, the same condition seen via mergeAtomic produced a
  // report with no durable fatal — so operator visibility depended on timing.
  const viaMergeCall: Record<string, string> = {
    tainted_merge: 'tainted_reported',
    pr_closed: 'pr_closed_reported',
    head_drift: 'drift_reported',
    protection_rejected: 'policy_loss_reported',
    unsupported: 'merge_unsupported_reported',
  };
  for (const [reason, disposition] of Object.entries(viaMergeCall)) {
    const fx = fixture();
    const host: MergeTickDeps['repoHost'] = {
      mergeResult: async () => OPEN,
      headSha: async () => ({ ok: true, sha: SHA }),
      probe: async () => BAR_PASSING,
      requiredChecksGreen: async () => ({ status: 'green' }),
      mergeAtomic: async () => ({ ok: false, reason: reason as 'transport', detail: `${reason} detail` }),
    };
    const h = harness({ repoHost: host });
    const res = await run(fx, h.deps, 'auto');
    assert.equal(res.disposition, disposition);
    assert.equal(h.fatals.length, 1, `${reason} must emit exactly one keyed fatal`);
    assert.equal(h.fatals[0]!.key, res.failure_key);
    assert.ok(res.action_hint, `${reason} must carry an action hint`);
  }
});

test('an operator-action observation still advances the fairness key', async () => {
  // last_probed_at is the scan's ordering key; if only waiting paths stamped it,
  // a permanently-broken task would be re-picked ahead of everyone forever.
  const fx = fixture();
  const h = harness({ script: { mergeResult: { merged: false, state: 'closed_unmerged' } } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'pr_closed_reported');
  const journal = readReconciliationRecord(fx.forgeDir, TASK);
  assert.ok(journal?.last_probed_at, 'the completed observation is journalled');
  assert.match(journal?.last_probe_outcome ?? '', /closed/);
});

test('a merge that races into an unreviewed head after an ok call is reported, never shipped', async () => {
  const fx = fixture();
  const host: MergeTickDeps['repoHost'] = {
    mergeResult: async () => ({ merged: true, base_ref: 'main', merge_commit_sha: MERGE_COMMIT, merged_head_sha: OTHER }),
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => ({ ok: true, merge_commit_sha: MERGE_COMMIT }),
  };
  // The first probe already sees the foreign merge, so the tick reports taint
  // before merging; drive the post-call branch by starting from an open PR.
  let probes = 0;
  const racing: MergeTickDeps['repoHost'] = {
    ...host,
    mergeResult: async () => {
      probes += 1;
      return probes === 1 ? OPEN : { merged: true, base_ref: 'main', merge_commit_sha: MERGE_COMMIT, merged_head_sha: OTHER };
    },
  };
  const h = harness({ repoHost: racing });
  const res = await run(fx, h.deps, 'auto');

  assert.equal(res.disposition, 'tainted_reported');
  assert.equal(existsSync(attestationPath(fx)), false);
  assertStateUntouched(fx, 'post-call taint');
});

// ─── Regressions from review round 2 ─────────────────────────────────────────

test('a THROWN mergeAtomic is contained: reservation settled, fairness stamped, streak charged', async () => {
  const fx = fixture();
  const host: MergeTickDeps['repoHost'] = {
    mergeResult: async () => OPEN,
    headSha: async () => ({ ok: true, sha: SHA }),
    probe: async () => BAR_PASSING,
    requiredChecksGreen: async () => ({ status: 'green' }),
    mergeAtomic: async () => {
      throw new Error('gh: could not spawn');
    },
  };
  const res = await run(fx, harness({ repoHost: host }).deps, 'auto');

  assert.equal(res.disposition, 'merge_call_failed_reported');
  assert.match(res.detail, /could not spawn/);
  const journal = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(journal?.merge_reservation?.status, 'settled', 'a thrown call never strands the seat');
  assert.equal(journal?.merge_failure_streak, 1);
  assert.ok(journal?.last_probed_at, 'the observation still advances the fairness key');
  assertStateUntouched(fx, 'thrown merge');
});

test('the shipped resume refuses to sync the tracker when the attestation disappeared', async () => {
  const fx = fixture();
  const h1 = harness({ script: { mergeResult: MERGED_EXACT } });
  await run(fx, h1.deps); // ships + attests + syncs
  // Wipe the durable witness, then re-tick: the no-op path must NOT authorize
  // anything on a missing artifact.
  writeFileSync(attestationPath(fx), '{ corrupt');
  const h2 = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h2.deps);

  assert.equal(res.disposition, 'attestation_invalid_reported');
  assert.equal(h2.trackerCalls(), 0);
  assert.equal(h2.fatals.length, 1, 'operator action emits a keyed fatal here too');
});

test('the shipped resume refuses when the ship-record binding advanced past the attestation', async () => {
  const fx = fixture();
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT } }).deps);
  const record = JSON.parse(readFileSync(join(fx.taskDir, 'ship-record.json'), 'utf8'));
  writeFileSync(join(fx.taskDir, 'ship-record.json'), JSON.stringify({ ...record, revision: 9 }));

  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);
  // The witness no longer matches the live binding, so the resume path stops
  // before touching the tracker.
  assert.notEqual(res.disposition, 'promoted');
  assert.equal(h.trackerCalls(), 0);
});

test('EVERY operator disposition reachable from the resume ladder emits a keyed fatal', async () => {
  // Both shapes land on shipped_unproven: a `shipped` state that cannot be
  // backed by proof is the same class of problem whether the PR disagrees or
  // the record cannot even name a PR.
  const cases: { fx: Fx; script: FakeRepoHostScript; expect: string }[] = [
    { fx: fixture({ state: 'shipped' }), script: { mergeResult: OPEN }, expect: 'shipped_unproven_reported' },
    { fx: fixture({ state: 'shipped', pr: null }), script: {}, expect: 'shipped_unproven_reported' },
  ];
  for (const c of cases) {
    const h = harness({ script: c.script });
    const res = await run(c.fx, h.deps);
    assert.equal(res.disposition, c.expect);
    assert.equal(h.fatals.length, 1, `${c.expect} must emit exactly one fatal`);
    assert.equal(h.fatals[0]!.key, res.failure_key);
  }
});

test('a corrupt attestation on a merge_pending task is operator action with a fatal', async () => {
  const fx = fixture({ state: 'shipped' });
  writeFileSync(attestationPath(fx), 'not json');
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'attestation_invalid_reported');
  assert.equal(h.fatals.length, 1);
  assert.equal(h.trackerCalls(), 0);
});

test('two concurrent resume ticks cannot both consume the same tracker attempt', async () => {
  const fx = fixture();
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const tracker = {
    markDone: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls += 1;
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { ok: false as const, retriable: true, detail: 'down' };
    },
  };
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker, trackerSyncMaxAttempts: 3 }).deps);
  const a = run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker, trackerSyncMaxAttempts: 3 }).deps);
  const b = run(fx, harness({ script: { mergeResult: MERGED_EXACT }, tracker, trackerSyncMaxAttempts: 3 }).deps);
  await Promise.all([a, b]);

  const journal = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(journal?.tracker_sync.attempts, 3, 'each call consumed its own reserved attempt');
  assert.equal(calls, 3);
  assert.equal(journal?.tracker_sync.status, 'failed', 'the budget really bounds the retries');
});

test('a settled tracker sync is never regressed by a late failure', async () => {
  const fx = fixture();
  await run(fx, harness({ script: { mergeResult: MERGED_EXACT } }).deps); // succeeds → done
  const before = readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync;
  assert.equal(before?.status, 'done');

  const res = await run(
    fx,
    harness({
      script: { mergeResult: MERGED_EXACT },
      tracker: { markDone: async () => ({ ok: false, retriable: true, detail: 'late failure' }) },
    }).deps,
  );
  assert.equal(res.disposition, 'promoted');
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'done');
});

// ─── Regressions from review round 3 ─────────────────────────────────────────

test('an in-flight tracker attempt is WAITED on, not counted as exhausted', async () => {
  // `pending` alone cannot distinguish "in flight" from "settled, retry later":
  // a contender that assumed the latter emitted a false exhaustion fatal while
  // the real attempt was still running (and could still succeed).
  const fx = fixture();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = harness({
    script: { mergeResult: MERGED_EXACT },
    trackerSyncMaxAttempts: 1,
    tracker: {
      markDone: async () => {
        await gate;
        return { ok: true as const };
      },
    },
  });
  const inFlight = run(fx, slow.deps);
  await new Promise((r) => setImmediate(r));

  const contender = harness({ script: { mergeResult: MERGED_EXACT }, trackerSyncMaxAttempts: 1, runId: 'other-run' });
  const res = await run(fx, contender.deps);
  assert.equal(res.disposition, 'promoted', 'the merge is proven; the sync is simply someone else’s');
  assert.equal(contender.fatals.length, 0, 'no false exhaustion fatal while an attempt is live');
  assert.equal(contender.trackerCalls(), 0);

  release!();
  await inFlight;
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'done');
});

test('a tracker attempt abandoned mid-call settles to failed instead of pending forever', async () => {
  const fx = fixture();
  await run(
    fx,
    harness({
      script: { mergeResult: MERGED_EXACT },
      trackerSyncMaxAttempts: 1,
      tracker: { markDone: async () => ({ ok: false, retriable: true, detail: 'down' }) },
    }).deps,
  );
  // Simulate a crash DURING the final attempt: reservation left behind, stale.
  const journalPath = join(fx.taskDir, 'reconciliation.json');
  const j = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(
    journalPath,
    JSON.stringify({
      ...j,
      tracker_sync: { status: 'pending', attempts: 1, last_error: 'down', owner_run_id: 'dead-run', reserved_at: new Date(Date.now() - 3_600_000).toISOString() },
    }),
  );

  const h = harness({ script: { mergeResult: MERGED_EXACT }, trackerSyncMaxAttempts: 1 });
  const res = await run(fx, h.deps);
  assert.equal(res.disposition, 'tracker_sync_exhausted_reported');
  assert.equal(h.trackerCalls(), 0, 'the exhausted budget is not re-spent');
  assert.equal(readReconciliationRecord(fx.forgeDir, TASK)?.tracker_sync.status, 'failed');
  assert.equal(JSON.parse(readFileSync(fx.statePath, 'utf8')).state, 'shipped');
});

// ─── Regressions from review round 4 ─────────────────────────────────────────

test('a corrupt reconciliation journal is REPORTED, never silently degraded', async () => {
  // Every journal write is wrapped in a diagnostic catch, so without a preflight
  // a corrupt journal produced ordinary waiting reports with no memory — and a
  // promotion whose tracker sync was skipped forever.
  const fx = fixture();
  writeFileSync(join(fx.taskDir, 'reconciliation.json'), '{"version":1,"garbage":true}');
  const h = harness({ script: { mergeResult: MERGED_EXACT } });
  const res = await run(fx, h.deps);

  assert.equal(res.disposition, 'reconciliation_invalid_reported');
  assert.equal(res.failure_key, `${TASK}:reconciliation_invalid`);
  assert.equal(h.fatals.length, 1);
  assert.match(res.action_hint ?? '', /deleting it is safe/);
  assertStateUntouched(fx, 'corrupt journal');
  assert.equal(existsSync(attestationPath(fx)), false, 'no promotion on a task we cannot bookkeep');
});

test('a stale tracker owner neither overwrites its successor nor raises a false fatal', async () => {
  const fx = fixture();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // Tick A stalls inside markDone and will answer LATE with a hard failure.
  const stale = harness({
    script: { mergeResult: MERGED_EXACT },
    runId: 'run-A',
    trackerSyncMaxAttempts: 5,
    tracker: {
      markDone: async () => {
        await gate;
        return { ok: false as const, retriable: false, detail: 'late non-retriable answer' };
      },
    },
  });
  const late = run(fx, stale.deps);
  await new Promise((r) => setImmediate(r));

  // Tick B takes the seat over (A's reservation is stale) and succeeds.
  const journalPath = join(fx.taskDir, 'reconciliation.json');
  const j = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(
    journalPath,
    JSON.stringify({
      ...j,
      tracker_sync: { ...j.tracker_sync, owner_run_id: 'run-B', attempts: j.tracker_sync.attempts + 1, reserved_at: new Date().toISOString() },
    }),
  );

  release!();
  const res = await late;
  assert.equal(res.disposition, 'promoted', 'a stale owner reports the merge, not an exhaustion it no longer owns');
  assert.match(res.detail, /owned elsewhere/);
  assert.equal(stale.fatals.length, 0, 'no false keyed fatal from a lost reservation');
  const after = readReconciliationRecord(fx.forgeDir, TASK);
  assert.equal(after?.tracker_sync.owner_run_id, 'run-B', "the successor's reservation is untouched");
  assert.notEqual(after?.tracker_sync.status, 'failed', "a stale answer never exhausts the successor's budget");
});
