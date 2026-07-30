// FORGE-235: merge-tick VERB surface — fair scan ordering (plan v5 Δ22),
// never-silent truncation, containment of a failing tick, single envelope.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runOrchestrateMergeTick } from '../../../../src/cli/orchestrate/merge-tick.ts';
import type { MergeTickDeps } from '../../../../src/orchestrator/merge-tick.ts';
import { FakeRepoHost } from '../../../../src/repo-hosts/fake.ts';

const SHA = 'a'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
const REPO = 'octo/base';

// Collects the verb's JSON envelopes while FORWARDING everything else to the
// real stream. Dropping non-JSON writes silently swallows the test runner's own
// reporter output for as long as the capture is installed, which truncates the
// file's results without failing anything.
function captureStdout(t: TestContext): string[] {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = String(chunk);
    if (s.trimStart().startsWith('{')) {
      lines.push(s.trim());
      return true;
    }
    return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return lines;
}

interface TaskSpec {
  id: string;
  state?: string;
  /** Journal last_probed_at — the fair-scan sort key. */
  probedAt?: string;
  /** Write an unparseable journal so the task sorts LAST. */
  brokenJournal?: boolean;
}

function fixture(tasks: TaskSpec[]): string {
  const forgeDir = mkdtempSync(join(tmpdir(), 'forge-235v-'));
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    ['version: 1', 'project:', '  name: fx', 'tracker:', '  type: github', '  config:', '    repo: octo/base', 'secrets:', '  manager: env_file', ''].join('\n'),
  );
  for (const spec of tasks) {
    const taskDir = join(forgeDir, 'orchestrator', 'tasks', spec.id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'state.json'),
      JSON.stringify({
        version: 1, task_id: spec.id, state: spec.state ?? 'merge_pending', state_version: 3,
        attempt_count: 1, failure_count: 0, last_failure_key: null, review_attempt_count: 1,
        ship_attempt_count: 1, current_attempt_id: 'att-1', updated_at: new Date().toISOString(),
        updated_by: { run_id: 'run-1', claim_id: 'claim-1', generation: 0 },
      }),
    );
    writeFileSync(
      join(taskDir, 'ship-record.json'),
      JSON.stringify({
        version: 1, task_id: spec.id, revision: 2, reviewed_head_sha: SHA, review_attempt_id: 'att-rev',
        cycle: 1, base: { repo: REPO, branch: 'main', push_remote: 'origin' },
        pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` },
        merge_attempt: 'submitted', updated_at: new Date().toISOString(),
      }),
    );
    if (spec.brokenJournal) {
      writeFileSync(join(taskDir, 'reconciliation.json'), '{"version":1,"garbage":true}');
    } else if (spec.probedAt) {
      writeFileSync(
        join(taskDir, 'reconciliation.json'),
        JSON.stringify({
          version: 1, task_id: spec.id, revision: 1,
          subject: { cycle: 1, pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` }, reviewed_head_sha: SHA, ship_record_revision: 2 },
          last_probed_at: spec.probedAt, last_probe_outcome: 'open', probe_failure_streak: 0,
          pending_since: null, merge_failure_streak: 0, last_merge_failure_at: null,
          merge_reservation: null, tracker_sync: { status: 'pending', attempts: 0, last_error: null },
          updated_at: spec.probedAt,
        }),
      );
    }
  }
  return forgeDir;
}

/** Records the order tasks were ticked; scripts each tick's observation. */
function recorder(script: (taskId: string) => MergeTickDeps['repoHost']): {
  depsFor: (taskId: string) => Promise<MergeTickDeps | null>;
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    depsFor: async (taskId) => {
      order.push(taskId);
      return {
        repoHost: script(taskId),
        runId: 'run-verb',
        tracker: { markDone: async () => ({ ok: true as const }) },
      };
    },
  };
}

const openHost = (): MergeTickDeps['repoHost'] =>
  new FakeRepoHost({
    mergeResult: { merged: false, state: 'open' },
    headSha: { ok: true, sha: SHA },
    probe: { ok: true, blocking_check_count: 1, squash_allowed: true, write_permission: true, bypass_rules_present: false, merge_queue_enabled: false },
    checks: { status: 'green' },
  }) as unknown as MergeTickDeps['repoHost'];

test('scan visits the least-recently-probed task first and broken journals LAST', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-B1', probedAt: '2026-07-29T10:00:00.000Z' },
    { id: 'FORGE-B2', brokenJournal: true },
    { id: 'FORGE-B3', probedAt: '2026-07-29T08:00:00.000Z' },
    { id: 'FORGE-B4' }, // never probed → sorts first
  ]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  const res = await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  assert.equal(res.exitCode, 0);
  assert.deepEqual(rec.order, ['FORGE-B4', 'FORGE-B3', 'FORGE-B1', 'FORGE-B2']);
  assert.equal(out.length, 1, 'exactly one envelope');
  assert.equal(JSON.parse(out[0]!).data.scanned, 4);
});

test('--limit caps the scan and REPORTS the truncation (never silent)', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-C1', probedAt: '2026-07-29T10:00:00.000Z' },
    { id: 'FORGE-C2', probedAt: '2026-07-29T09:00:00.000Z' },
    { id: 'FORGE-C3', probedAt: '2026-07-29T08:00:00.000Z' },
  ]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, limit: 2, json: true }, { depsFor: rec.depsFor });

  const env = JSON.parse(out[0]!);
  assert.equal(env.data.scanned, 2);
  assert.equal(env.data.capped, true);
  assert.equal(env.data.total_candidates, 3);
  assert.deepEqual(rec.order, ['FORGE-C3', 'FORGE-C2'], 'the cap takes the OLDEST-probed tasks');
});

test('--task targets exactly one task and skips the scan', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-D1' }, { id: 'FORGE-D2' }]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, taskId: 'FORGE-D2', json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order, ['FORGE-D2']);
  assert.equal(JSON.parse(out[0]!).data.scanned, 1);
});

test('the envelope counts promotions and operator actions separately', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-E1' }, { id: 'FORGE-E2' }, { id: 'FORGE-E3' }]);
  const out = captureStdout(t);
  const rec = recorder((taskId) => {
    if (taskId === 'FORGE-E1') {
      return new FakeRepoHost({
        mergeResult: { merged: true, base_ref: 'main', merge_commit_sha: MERGE_COMMIT, merged_head_sha: SHA },
      }) as unknown as MergeTickDeps['repoHost'];
    }
    if (taskId === 'FORGE-E2') {
      return new FakeRepoHost({ mergeResult: { merged: false, state: 'closed_unmerged' } }) as unknown as MergeTickDeps['repoHost'];
    }
    return openHost();
  });

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  const { data } = JSON.parse(out[0]!);
  assert.equal(data.scanned, 3);
  assert.equal(data.promoted, 1);
  assert.equal(data.operator_action, 1, 'only the closed PR is operator action');
  assert.equal(data.results.length, 3);
  const closed = data.results.find((r: { task_id: string }) => r.task_id === 'FORGE-E2');
  assert.equal(closed.disposition, 'pr_closed_reported');
  assert.ok(closed.failure_key);
});

test('a task whose tick throws is contained — the scan continues', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-F1' }, { id: 'FORGE-F2' }]);
  const out = captureStdout(t);
  const order: string[] = [];

  await runOrchestrateMergeTick(
    { forgeDir, json: true },
    {
      depsFor: async (taskId) => {
        order.push(taskId);
        if (taskId === 'FORGE-F1') throw new Error('dep construction exploded');
        return { repoHost: openHost(), runId: 'r', tracker: { markDone: async () => ({ ok: true as const }) } };
      },
    },
  ).catch((err: unknown) => {
    assert.fail(`the verb must contain per-task faults, but threw: ${String(err)}`);
  });

  assert.deepEqual(order, ['FORGE-F1', 'FORGE-F2']);
  const { data } = JSON.parse(out[0]!);
  assert.equal(data.scanned, 2);
  assert.equal(data.results[0].disposition, 'probe_unavailable');
  assert.match(data.results[0].detail, /exploded/);
});

test('a task with no constructible RepoHost is reported, not crashed on', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-G1' }]);
  const out = captureStdout(t);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: async () => null });

  const { data } = JSON.parse(out[0]!);
  assert.equal(data.results[0].disposition, 'probe_unavailable');
  assert.match(data.results[0].detail, /RepoHost/);
});

test('shipped tasks are in scope (the resume ladder), other states are not', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-H1', state: 'shipped' },
    { id: 'FORGE-H2', state: 'running' },
    { id: 'FORGE-H3', state: 'merge_pending' },
  ]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order.sort(), ['FORGE-H1', 'FORGE-H3']);
  assert.equal(JSON.parse(out[0]!).data.scanned, 2);
});

test('invalid args emit a single failure envelope', async (t) => {
  const out = captureStdout(t);
  const res = await runOrchestrateMergeTick({ forgeDir: fixture([]), limit: 0, json: true });

  assert.notEqual(res.exitCode, 0);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).error.code, 'INVALID_ARGS');
});

// ─── Regressions from the FORGE-235 implementation review ────────────────────

test('a corrupt ship record is operator action, not a transient probe failure', async (t) => {
  // Production wiring builds the host FROM the record, so a corrupt record
  // yields a null host — which must not masquerade as `probe_unavailable`.
  const forgeDir = fixture([{ id: 'FORGE-I1' }]);
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-I1', 'ship-record.json'), '{ truncated', 'utf8');
  const out = captureStdout(t);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: async () => null });

  const { data } = JSON.parse(out[0]!);
  assert.equal(data.results[0].disposition, 'ship_record_invalid_reported');
  assert.equal(data.operator_action, 1);
  assert.ok(data.results[0].failure_key);
  assert.ok(data.results[0].action_hint);
});

test('a fully reconciled shipped task leaves the scan — it can never eat the --limit budget', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-J1', state: 'shipped' },
    { id: 'FORGE-J2' },
  ]);
  // Mark J1 as merged + tracker-synced, the terminal steady state.
  writeFileSync(
    join(forgeDir, 'orchestrator', 'tasks', 'FORGE-J1', 'merge-attestation.json'),
    JSON.stringify({
      version: 1, task_id: 'FORGE-J1', cycle: 1,
      pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` },
      base_repo: REPO, base_branch: 'main', reviewed_head_sha: SHA, merged_head_sha: SHA,
      merge_commit_sha: MERGE_COMMIT, ship_record_revision: 2, attested_at: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(forgeDir, 'orchestrator', 'tasks', 'FORGE-J1', 'reconciliation.json'),
    JSON.stringify({
      version: 1, task_id: 'FORGE-J1', revision: 1,
      subject: { cycle: 1, pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` }, reviewed_head_sha: SHA, ship_record_revision: 2 },
      last_probed_at: null, last_probe_outcome: null, probe_failure_streak: 0, pending_since: null,
      merge_failure_streak: 0, last_merge_failure_at: null, merge_reservation: null,
      tracker_sync: { status: 'done', attempts: 1, last_error: null }, updated_at: new Date().toISOString(),
    }),
  );
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order, ['FORGE-J2']);
  assert.equal(JSON.parse(out[0]!).data.scanned, 1);
});

test('a shipped task with an UNFINISHED tracker sync stays in the scan', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-K1', state: 'shipped' }]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order, ['FORGE-K1'], 'unfinished bookkeeping is still work');
  assert.equal(JSON.parse(out[0]!).data.scanned, 1);
});

test('a task whose state file is misbound is SCANNED and reported, never silently dropped', async (t) => {
  // The path↔payload binding is only useful if the corruption it detects
  // surfaces; filtering those tasks out of the scan would hide it.
  const forgeDir = fixture([{ id: 'FORGE-L1' }, { id: 'FORGE-L2' }]);
  const statePath = join(forgeDir, 'orchestrator', 'tasks', 'FORGE-L1', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...state, task_id: 'SOMEONE-ELSE' }));
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: rec.depsFor });

  const { data } = JSON.parse(out[0]!);
  assert.equal(data.scanned, 2);
  assert.deepEqual(rec.order, ['FORGE-L2', 'FORGE-L1'], 'the broken task sorts LAST but is still visited');
  const broken = data.results.find((r: { task_id: string }) => r.task_id === 'FORGE-L1');
  assert.equal(broken.disposition, 'ship_record_invalid_reported');
});

test('the handler parses a separated --limit instead of mistaking it for a task id', async (t) => {
  // `--limit 2` once bound "2" as the positional task id, silently targeting a
  // task named "2" and never scanning the queue.
  const forgeDir = fixture([
    { id: 'FORGE-M1', probedAt: '2026-07-29T10:00:00.000Z' },
    { id: 'FORGE-M2', probedAt: '2026-07-29T09:00:00.000Z' },
    { id: 'FORGE-M3', probedAt: '2026-07-29T08:00:00.000Z' },
  ]);
  const out = captureStdout(t);
  const { VERBS } = await import('../../../../src/cli/orchestrate/index.ts');
  const handler = VERBS.get('merge-tick');
  assert.ok(handler && !(handler instanceof Map), 'the verb is registered');

  await (handler as { run: (rest: string[], opts: { cwd: string }) => Promise<unknown> }).run(
    ['--limit', '2', '--forge-dir', forgeDir, '--json'],
    { cwd: forgeDir },
  );

  const { data } = JSON.parse(out[out.length - 1]!);
  assert.equal(data.scanned, 2, '--limit is a limit, not a task id');
  assert.equal(data.capped, true);
  assert.equal(data.total_candidates, 3);
});

test('--limit bounds LIVE PROBES; locally-broken tasks are reported in full alongside', async (t) => {
  // Corruption reporting is pure local file reads — capping it starves the
  // report, and letting it displace a healthy task starves reconciliation.
  // They are different budgets, so neither has to lose.
  const forgeDir = fixture([
    { id: 'FORGE-N1', probedAt: '2026-07-29T08:00:00.000Z' },
    { id: 'FORGE-N2', probedAt: '2026-07-29T09:00:00.000Z' },
    { id: 'FORGE-N3', probedAt: '2026-07-29T10:00:00.000Z' },
    { id: 'FORGE-N4', brokenJournal: true },
    { id: 'FORGE-N5', brokenJournal: true },
  ]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, limit: 2, json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order, ['FORGE-N1', 'FORGE-N2', 'FORGE-N4', 'FORGE-N5']);
  const { data } = JSON.parse(out[0]!);
  assert.equal(data.capped, true);
  assert.equal(data.probe_limit, 2);
  const dispositions = new Map<string, string>(
    (data.results as { task_id: string; disposition: string }[]).map((r) => [r.task_id, r.disposition]),
  );
  assert.equal(dispositions.get('FORGE-N4'), 'reconciliation_invalid_reported', 'every broken task is REPORTED, not just visited');
  assert.equal(dispositions.get('FORGE-N5'), 'reconciliation_invalid_reported');
});

test('with --limit 1 the single healthy slot is never displaced by corruption', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-P1', probedAt: '2026-07-29T08:00:00.000Z' },
    { id: 'FORGE-P2', probedAt: '2026-07-29T09:00:00.000Z' },
    { id: 'FORGE-P3', brokenJournal: true },
  ]);
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, limit: 1, json: true }, { depsFor: rec.depsFor });

  assert.deepEqual(rec.order, ['FORGE-P1', 'FORGE-P3']);
  assert.equal(JSON.parse(out[0]!).data.capped, true);
});

test('the envelope names the run its keyed fatals were written under', async (t) => {
  const forgeDir = fixture([{ id: 'FORGE-O1' }]);
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-O1', 'ship-record.json'), '{ truncated', 'utf8');
  const out = captureStdout(t);

  await runOrchestrateMergeTick({ forgeDir, json: true }, { depsFor: async () => null });

  const { data } = JSON.parse(out[0]!);
  assert.match(data.run_id, /^merge-tick-[0-9a-f-]+$/, 'path-safe: no ":" — a colon breaks the run directory on Windows');
  assert.equal(existsSync(join(forgeDir, 'orchestrator', 'runs', data.run_id, 'notifications.jsonl')), true);
  const events = readFileSync(join(forgeDir, 'orchestrator', 'runs', data.run_id, 'notifications.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'fatal');
  assert.equal(events[0].details.failure_key, 'FORGE-O1:record_invalid:unreadable');
});

test('a corrupt ship record never consumes a probe slot (it resolves locally)', async (t) => {
  // Its report cannot stamp a fairness timestamp, so if it counted as a probe
  // candidate it would hold the oldest position every round forever.
  const forgeDir = fixture([
    { id: 'FORGE-Q1', probedAt: '2026-07-29T08:00:00.000Z' },
    { id: 'FORGE-Q2', probedAt: '2026-07-29T09:00:00.000Z' },
  ]);
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-Q1', 'ship-record.json'), '{ truncated', 'utf8');
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, limit: 1, json: true }, { depsFor: async (id) => (await rec.depsFor(id)) });

  const { data } = JSON.parse(out[0]!);
  const seen = new Map<string, string>(
    (data.results as { task_id: string; disposition: string }[]).map((r) => [r.task_id, r.disposition]),
  );
  assert.equal(seen.get('FORGE-Q2'), 'checks_pending', 'the healthy task still got its probe slot');
  assert.equal(seen.get('FORGE-Q1'), 'ship_record_invalid_reported', 'and the corruption was still reported');
});

test('a corrupt journal on a SHIPPED task is reported, not silently skipped', async (t) => {
  // The resume ladder needs the journal too — that is where the tracker-sync
  // budget lives — so the preflight must run before the shipped branch.
  const forgeDir = fixture([{ id: 'FORGE-R1', state: 'shipped', brokenJournal: true }]);
  const out = captureStdout(t);
  let probes = 0;

  await runOrchestrateMergeTick(
    { forgeDir, json: true },
    {
      depsFor: async () => ({
        repoHost: {
          mergeResult: async () => {
            probes += 1;
            return { merged: false as const, state: 'open' as const };
          },
          headSha: async () => ({ ok: true as const, sha: SHA }),
          probe: async () => ({ ok: true as const, blocking_check_count: 1, squash_allowed: true, write_permission: true, bypass_rules_present: false, merge_queue_enabled: false }),
          requiredChecksGreen: async () => ({ status: 'green' as const }),
        },
        runId: 'run-verb',
        tracker: { markDone: async () => ({ ok: true as const }) },
      }),
    },
  );

  const { data } = JSON.parse(out[0]!);
  assert.equal(data.results[0].disposition, 'reconciliation_invalid_reported');
  assert.equal(probes, 0, 'the corruption is caught before any network call');
});

test('a shipped task with an exhausted tracker sync resolves locally, not as a probe', async (t) => {
  const forgeDir = fixture([
    { id: 'FORGE-S1', state: 'shipped' },
    { id: 'FORGE-S2', probedAt: '2026-07-29T09:00:00.000Z' },
  ]);
  const dir = join(forgeDir, 'orchestrator', 'tasks', 'FORGE-S1');
  writeFileSync(
    join(dir, 'merge-attestation.json'),
    JSON.stringify({
      version: 1, task_id: 'FORGE-S1', cycle: 1,
      pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` },
      base_repo: REPO, base_branch: 'main', reviewed_head_sha: SHA, merged_head_sha: SHA,
      merge_commit_sha: MERGE_COMMIT, ship_record_revision: 2, attested_at: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(dir, 'reconciliation.json'),
    JSON.stringify({
      version: 1, task_id: 'FORGE-S1', revision: 1,
      subject: { cycle: 1, pr: { repo: REPO, number: 5, url: `https://github.com/${REPO}/pull/5` }, reviewed_head_sha: SHA, ship_record_revision: 2 },
      last_probed_at: null, last_probe_outcome: null, probe_failure_streak: 0, pending_since: null,
      merge_failure_streak: 0, last_merge_failure_at: null, merge_reservation: null,
      tracker_sync: { status: 'failed', attempts: 5, last_error: 'tracker down', owner_run_id: null, reserved_at: null },
      updated_at: new Date().toISOString(),
    }),
  );
  const out = captureStdout(t);
  const rec = recorder(openHost);

  await runOrchestrateMergeTick({ forgeDir, limit: 1, json: true }, { depsFor: rec.depsFor });

  const seen = new Map<string, string>(
    (JSON.parse(out[0]!).data.results as { task_id: string; disposition: string }[]).map((r) => [r.task_id, r.disposition]),
  );
  assert.equal(seen.get('FORGE-S2'), 'checks_pending', 'the probeable task kept its slot');
  assert.equal(seen.get('FORGE-S1'), 'tracker_sync_exhausted_reported', 'and the local divergence was still reported');
});
