// FORGE-233: the SHIP dependency-merge gate matrix (plan v2-v4). Hermetic —
// observers are injected fakes; the ONLY positive vector is live merge proof.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildAliasIndex,
  evaluateShipDependencyGate,
  gateRetriable,
  type DependencyObserver,
} from '../../../src/orchestrator/dependency-gate.ts';
import type { Task } from '../../../src/schemas/phases.ts';
import type { MergeResult } from '../../../src/repo-hosts/types.ts';

const SHA_R = 'a'.repeat(40);
const SHA_M = 'b'.repeat(40);

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: 'T',
    description: 'D',
    type: 'foundation',
    priority: 'P0',
    estimate: 'S',
    owner_type: 'backend-dev',
    acceptance: ['ok'],
    depends_on: [],
    ...overrides,
  } as Task;
}

function forgeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-233-gate-'));
  mkdirSync(join(dir, 'orchestrator', 'tasks'), { recursive: true });
  return dir;
}

function writeState(fd: string, id: string, state: string, payloadTaskId?: string): void {
  const dir = join(fd, 'orchestrator', 'tasks', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: payloadTaskId ?? id,
      state,
      state_version: 3,
      attempt_count: 1,
      failure_count: 0,
      last_failure_key: null,
      review_attempt_count: 1,
      ship_attempt_count: 1,
      current_attempt_id: 'att-1',
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'r', claim_id: 'c', generation: 1 },
    }),
    'utf8',
  );
}

function writeRecord(fd: string, id: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(fd, 'orchestrator', 'tasks', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'ship-record.json'),
    JSON.stringify({
      version: 1,
      task_id: id,
      revision: 3,
      reviewed_head_sha: SHA_R,
      review_attempt_id: 'att-rev',
      base: { repo: 'octo/base', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'octo/base', number: 7, url: 'https://github.com/octo/base/pull/7' },
      merge_attempt: 'submitted',
      updated_at: new Date().toISOString(),
      ...overrides,
    }),
    'utf8',
  );
}

const mergedOk: MergeResult = { merged: true, base_ref: 'main', merge_commit_sha: SHA_M, merged_head_sha: SHA_R };
const observerOf = (result: MergeResult | Error): ((id: string) => Promise<DependencyObserver | null>) =>
  async () => ({
    mergeResult: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });

async function gate(opts: {
  fd: string;
  taskId?: string;
  tasks: Task[];
  observer?: (id: string) => Promise<DependencyObserver | null>;
}) {
  return evaluateShipDependencyGate({
    forgeDir: opts.fd,
    taskId: opts.taskId ?? 'SUBJ-1',
    tasks: opts.tasks,
    observerFor: opts.observer ?? (async () => null),
  });
}

const subj = (deps: string[]): Task => mkTask({ id: 'SUBJ-1', depends_on: deps });

// ─── Positive vector ─────────────────────────────────────────────────────────

test('merge_pending dep + live proof at recorded base+head → satisfied via live_merge_proof', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })], observer: observerOf(mergedOk) });
  assert.equal(report.satisfied, true);
  assert.equal(report.deps[0]!.satisfied, true);
  if (report.deps[0]!.satisfied) assert.equal(report.deps[0]!.vector, 'live_merge_proof');
  assert.equal(gateRetriable(report), true);
});

test('shipped dep is NEVER trusted on state alone — live probe required and satisfies', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'shipped');
  writeRecord(fd, 'DEP-1');
  const probed: string[] = [];
  const report = await gate({
    fd,
    tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })],
    observer: async (id) => {
      probed.push(id);
      return { mergeResult: async () => mergedOk };
    },
  });
  assert.deepEqual(probed, ['DEP-1'], 'shipped state must still probe');
  assert.equal(report.satisfied, true);
});

// ─── Unsatisfied taxonomy ────────────────────────────────────────────────────

test('open PR → not_merged (waiting, retriable); closed → pr_closed_unmerged (operator)', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const tasks = [subj(['DEP-1']), mkTask({ id: 'DEP-1' })];

  const open = await gate({ fd, tasks, observer: observerOf({ merged: false, state: 'open' }) });
  assert.equal(open.satisfied, false);
  if (!open.deps[0]!.satisfied) {
    assert.equal(open.deps[0]!.reason, 'not_merged');
    assert.equal(open.deps[0]!.disposition, 'waiting');
  }
  assert.equal(gateRetriable(open), true);

  const closed = await gate({ fd, tasks, observer: observerOf({ merged: false, state: 'closed_unmerged' }) });
  if (!closed.deps[0]!.satisfied) {
    assert.equal(closed.deps[0]!.reason, 'pr_closed_unmerged');
    assert.equal(closed.deps[0]!.disposition, 'operator_action');
  }
  assert.equal(gateRetriable(closed), false);
});

test('merged at WRONG head → tainted_merge with structured expected/actual', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const wrong: MergeResult = { merged: true, base_ref: 'main', merge_commit_sha: SHA_M, merged_head_sha: 'c'.repeat(40) };
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })], observer: observerOf(wrong) });
  const dep = report.deps[0]!;
  assert.equal(dep.satisfied, false);
  if (!dep.satisfied) {
    assert.equal(dep.reason, 'tainted_merge');
    assert.equal(dep.expected?.reviewed_head_sha, SHA_R);
    assert.equal(dep.observed?.merged_head_sha, 'c'.repeat(40));
  }
});

test('merged at WRONG base → tainted_merge', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const wrong: MergeResult = { merged: true, base_ref: 'release', merge_commit_sha: SHA_M, merged_head_sha: SHA_R };
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })], observer: observerOf(wrong) });
  if (!report.deps[0]!.satisfied) assert.equal(report.deps[0]!.reason, 'tainted_merge');
});

test('probe failures are fail-closed waiting: unknown result, thrown observer, null observer', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const tasks = [subj(['DEP-1']), mkTask({ id: 'DEP-1' })];
  for (const observer of [
    observerOf({ merged: false, state: 'unknown', reason: 'transport' }),
    observerOf(new Error('gh transport down')),
    async () => null,
  ] as const) {
    const report = await gate({ fd, tasks, observer });
    const dep = report.deps[0]!;
    assert.equal(dep.satisfied, false);
    if (!dep.satisfied) {
      assert.equal(dep.reason, 'probe_unavailable');
      assert.equal(dep.disposition, 'waiting');
    }
  }
});

test('durable record damage is operator_action, never retriable-forever: truncated record + merge_pending without pr', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  const dir = join(fd, 'orchestrator', 'tasks', 'DEP-1');
  writeFileSync(join(dir, 'ship-record.json'), '{"version":1,"task_id":"DEP-1"', 'utf8'); // truncated
  const tasks = [subj(['DEP-1']), mkTask({ id: 'DEP-1' })];
  const r1 = await gate({ fd, tasks, observer: observerOf(mergedOk) });
  if (!r1.deps[0]!.satisfied) {
    assert.equal(r1.deps[0]!.reason, 'ship_record_invalid');
    assert.equal(r1.deps[0]!.disposition, 'operator_action');
  }
  assert.equal(gateRetriable(r1), false);

  writeRecord(fd, 'DEP-1', { pr: null, merge_attempt: 'not_started' });
  const r2 = await gate({ fd, tasks, observer: observerOf(mergedOk) });
  if (!r2.deps[0]!.satisfied) assert.equal(r2.deps[0]!.reason, 'ship_record_incomplete');
});

test('ship record belonging to ANOTHER task (copied/restored) → ship_record_invalid', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'shipped');
  writeRecord(fd, 'DEP-1', { task_id: 'OTHER-9' });
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })], observer: observerOf(mergedOk) });
  if (!report.deps[0]!.satisfied) {
    assert.equal(report.deps[0]!.reason, 'ship_record_invalid');
    assert.match(report.deps[0]!.detail ?? '', /OTHER-9/);
  }
});

test('shipped WITHOUT any record → shipped_unproven (operator_action)', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'shipped');
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })], observer: observerOf(mergedOk) });
  if (!report.deps[0]!.satisfied) {
    assert.equal(report.deps[0]!.reason, 'shipped_unproven');
    assert.equal(report.deps[0]!.disposition, 'operator_action');
  }
});

test('NO state directory → legacy_dependency_unproven; phases.yaml status is NEVER a positive vector', async () => {
  const fd = forgeDir();
  const doneDep = mkTask({ id: 'DEP-1', status: 'done' } as Partial<Task> & { id: string });
  const report = await gate({ fd, tasks: [subj(['DEP-1']), doneDep], observer: observerOf(mergedOk) });
  const dep = report.deps[0]!;
  assert.equal(dep.satisfied, false);
  if (!dep.satisfied) assert.equal(dep.reason, 'legacy_dependency_unproven');
});

test('dep in active state → dep_state_blocking waiting; failed/cancelled → operator_action', async () => {
  const fd = forgeDir();
  const tasks = [subj(['DEP-1']), mkTask({ id: 'DEP-1' })];
  for (const [state, disposition] of [
    ['running', 'waiting'],
    ['reviewed', 'waiting'],
    ['failed', 'operator_action'],
    ['cancelled', 'operator_action'],
  ] as const) {
    writeState(fd, 'DEP-1', state);
    const report = await gate({ fd, tasks });
    const dep = report.deps[0]!;
    if (!dep.satisfied) {
      assert.equal(dep.reason, 'dep_state_blocking', state);
      assert.equal(dep.disposition, disposition, state);
      assert.equal(dep.observed_state, state);
    }
  }
});

test('state payload/directory mismatch and symlinked state → state_invalid, never absent', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'shipped', 'IMPOSTOR');
  const tasks = [subj(['DEP-1']), mkTask({ id: 'DEP-1' })];
  const r1 = await gate({ fd, tasks });
  if (!r1.deps[0]!.satisfied) assert.equal(r1.deps[0]!.reason, 'state_invalid');

  const fd2 = forgeDir();
  const dir = join(fd2, 'orchestrator', 'tasks', 'DEP-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'real.json'), '{}', 'utf8');
  symlinkSync(join(dir, 'real.json'), join(dir, 'state.json'));
  const r2 = await gate({ fd: fd2, tasks });
  if (!r2.deps[0]!.satisfied) assert.equal(r2.deps[0]!.reason, 'state_invalid');
});

// ─── Identity resolution (plan v4 ΔA/ΔB) ─────────────────────────────────────

test('unknown dependency → unknown_dependency', async () => {
  const fd = forgeDir();
  const report = await gate({ fd, tasks: [subj(['GHOST'])] });
  if (!report.deps[0]!.satisfied) assert.equal(report.deps[0]!.reason, 'unknown_dependency');
});

test('cross-namespace alias collision (A.tracker_issue_id == B.id) → ambiguous_identity', async () => {
  const fd = forgeDir();
  const a = mkTask({ id: 'P1-T01', tracker_issue_id: 'P1-T02' });
  const b = mkTask({ id: 'P1-T02', tracker_issue_id: 'FORGE-2' });
  writeState(fd, 'P1-T02', 'shipped');
  writeRecord(fd, 'P1-T02');
  const report = await gate({ fd, tasks: [subj(['P1-T01']), a, b], observer: observerOf(mergedOk) });
  const dep = report.deps[0]!;
  assert.equal(dep.satisfied, false, "B's legit state must never satisfy A");
  if (!dep.satisfied) assert.equal(dep.reason, 'ambiguous_identity');
});

test('duplicate tracker_issue_id across two tasks → ambiguous_identity', async () => {
  const fd = forgeDir();
  const a = mkTask({ id: 'T-A', tracker_issue_id: 'FORGE-9' });
  const b = mkTask({ id: 'T-B', tracker_issue_id: 'FORGE-9' });
  const report = await gate({ fd, tasks: [subj(['FORGE-9']), a, b] });
  if (!report.deps[0]!.satisfied) assert.equal(report.deps[0]!.reason, 'ambiguous_identity');
});

test('BOTH phase-id and tracker-id state dirs exist → ambiguous_identity (no alias shopping)', async () => {
  const fd = forgeDir();
  const dep = mkTask({ id: 'P1-T05', tracker_issue_id: 'FORGE-5' });
  writeState(fd, 'P1-T05', 'shipped');
  writeState(fd, 'FORGE-5', 'merge_pending');
  writeRecord(fd, 'FORGE-5');
  const report = await gate({ fd, tasks: [subj(['P1-T05']), dep], observer: observerOf(mergedOk) });
  if (!report.deps[0]!.satisfied) assert.equal(report.deps[0]!.reason, 'ambiguous_identity');
});

test('path-contract-violating canonical id (gh#42) → invalid_identity in-report, no throw', async () => {
  const fd = forgeDir();
  const dep = mkTask({ id: 'T-GH', tracker_issue_id: 'gh#42' });
  const report = await gate({ fd, tasks: [subj(['T-GH']), dep] });
  const d = report.deps[0]!;
  assert.equal(d.satisfied, false);
  if (!d.satisfied) {
    assert.equal(d.reason, 'invalid_identity');
    assert.equal(d.disposition, 'operator_action');
  }
});

test('SUBJECT missing from phases.yaml → subject_unresolved, satisfied:false, retriable:false — never dependsOn:[]', async () => {
  const fd = forgeDir();
  const report = await gate({ fd, taskId: 'NOT-THERE', tasks: [mkTask({ id: 'OTHER' })] });
  assert.equal(report.satisfied, false);
  assert.equal(report.subject.resolved, false);
  if (!report.subject.resolved) assert.equal(report.subject.reason, 'subject_unresolved');
  assert.equal(gateRetriable(report), false);
});

test('SUBJECT via ambiguous alias → subject_ambiguous', async () => {
  const fd = forgeDir();
  const a = mkTask({ id: 'X-1', tracker_issue_id: 'SUBJ-9' });
  const b = mkTask({ id: 'SUBJ-9' });
  const report = await gate({ fd, taskId: 'SUBJ-9', tasks: [a, b] });
  assert.equal(report.subject.resolved, false);
  if (!report.subject.resolved) assert.equal(report.subject.reason, 'subject_ambiguous');
});

test('resolved subject with EMPTY declared deps → satisfied (the only legal empty)', async () => {
  const fd = forgeDir();
  const report = await gate({ fd, tasks: [subj([])] });
  assert.equal(report.satisfied, true);
  assert.equal(report.deps.length, 0);
});

test('duplicate declared deps dedup deterministically + surface in duplicate_declared_ids', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  const report = await gate({
    fd,
    tasks: [subj(['DEP-1', 'DEP-1', 'DEP-1']), mkTask({ id: 'DEP-1' })],
    observer: observerOf(mergedOk),
  });
  assert.equal(report.deps.length, 1);
  assert.deepEqual(report.duplicate_declared_ids, ['DEP-1']);
});

test('mixed deps: one proven + one open → unsatisfied with per-dep report', async () => {
  const fd = forgeDir();
  writeState(fd, 'DEP-1', 'merge_pending');
  writeRecord(fd, 'DEP-1');
  writeState(fd, 'DEP-2', 'merge_pending');
  writeRecord(fd, 'DEP-2', { task_id: 'DEP-2' });
  const report = await evaluateShipDependencyGate({
    forgeDir: fd,
    taskId: 'SUBJ-1',
    tasks: [subj(['DEP-1', 'DEP-2']), mkTask({ id: 'DEP-1' }), mkTask({ id: 'DEP-2' })],
    observerFor: async (id) => ({
      mergeResult: async () => (id === 'DEP-1' ? mergedOk : { merged: false, state: 'open' }),
    }),
  });
  assert.equal(report.satisfied, false);
  assert.equal(report.deps.find((d) => d.declared_id === 'DEP-1')!.satisfied, true);
  assert.equal(report.deps.find((d) => d.declared_id === 'DEP-2')!.satisfied, false);
});

test('buildAliasIndex marks cross-claimed identifiers ambiguous', () => {
  const a = mkTask({ id: 'A', tracker_issue_id: 'B' });
  const b = mkTask({ id: 'B' });
  const index = buildAliasIndex([a, b]);
  assert.equal(index.get('B')!.ambiguous, true);
  assert.equal(index.get('A')!.ambiguous, false);
});

// ─── impl-R1 fix-round additions ─────────────────────────────────────────────

test('subject with path-contract-violating canonical id → subject_invalid_identity, never vacuous satisfy (impl-R1 MAJ #1)', async () => {
  const fd = forgeDir();
  const s = mkTask({ id: 'SUBJ-1', tracker_issue_id: 'gh#42' });
  const report = await gate({ fd, tasks: [s] });
  assert.equal(report.satisfied, false);
  assert.equal(report.subject.resolved, false);
  if (!report.subject.resolved) assert.equal(report.subject.reason, 'subject_invalid_identity');
  assert.equal(gateRetriable(report), false);
});

test('oversized state.json → state_invalid (impl-R1 MAJ #3)', async () => {
  const fd = forgeDir();
  const dir = join(fd, 'orchestrator', 'tasks', 'DEP-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{"pad":"' + 'x'.repeat(300 * 1024) + '"}', 'utf8');
  const report = await gate({ fd, tasks: [subj(['DEP-1']), mkTask({ id: 'DEP-1' })] });
  if (!report.deps[0]!.satisfied) assert.equal(report.deps[0]!.reason, 'state_invalid');
});

test('satisfied entries REQUIRE observed proof fields — schema rejects observed:{} (impl-R1 MAJ #2)', async () => {
  const { DependencyGateReportSchema } = await import('../../../src/schemas/dependency-gate.ts');
  const bad = {
    version: 1, task_id: 'T', subject: { resolved: true, task_id: 'T' }, satisfied: true,
    deps: [{
      declared_id: 'D', resolved_task_id: 'D', state_id: 'D', observed_state: 'merge_pending',
      satisfied: true, vector: 'live_merge_proof', disposition: 'satisfied', observed: {},
    }],
    duplicate_declared_ids: [],
  };
  assert.equal(DependencyGateReportSchema.safeParse(bad).success, false);
});
