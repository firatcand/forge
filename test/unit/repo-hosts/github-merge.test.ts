// FORGE-232: mergeAtomic / mergeResult / headSha / requiredChecksGreen matrix
// (plan v3 §mergeAtomic + v4 Δ1/Δ2/Δ4 + ΔA/ΔC; OD1 compensating cleanup).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequestRef } from '../../../src/repo-hosts/types.ts';
import {
  REPO,
  SHA_A,
  SHA_B,
  SHA_C,
  classicRoute,
  existenceRoutes,
  gitTopologyRoutes,
  graphqlObservation,
  graphqlRoute,
  makeHost,
  repoViewRoute,
  rulesRoute,
  scriptedExec,
  type Route,
} from './helpers.ts';

const PR: PullRequestRef = { repo: REPO, number: 12, url: `https://github.com/${REPO}/pull/12` };

const passingProbe: Route[] = [
  repoViewRoute(),
  rulesRoute(),
  classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: true } }),
  ...existenceRoutes(),
];

const mergeCmd = (result: Partial<{ stdout: string; stderr: string; exitCode: number }>): Route => ({
  match: (a) => a[0] === 'pr' && a[1] === 'merge' && !a.includes('--disable-auto'),
  result,
});

const checksCmd = (buckets: string[]): Route => ({
  match: (a) => a[0] === 'pr' && a[1] === 'checks',
  result: { stdout: JSON.stringify(buckets.map((b, i) => ({ name: `c${i}`, bucket: b }))) },
});

async function hostWithBase(extra: Route[]) {
  const gh = scriptedExec([...passingProbe, ...extra]);
  const { host } = makeHost({ gh, git: gitTopologyRoutes() });
  await host.resolveBase();
  return { host, gh };
}

const MERGED_OK = { state: 'MERGED' as const, mergedAt: '2026-07-23T00:00:00Z', headRefOid: SHA_A, mergeCommit: { oid: SHA_B } };

// ─── mergeAtomic happy + proof paths ─────────────────────────────────────────

test('merge succeeds: platform proof with expected head → ok + merge SHA', async () => {
  const { host, gh } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    graphqlRoute(() => graphqlObservation(MERGED_OK)),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.deepEqual(out, { ok: true, merge_commit_sha: SHA_B });
  const mergeCall = gh.calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
  assert.ok(mergeCall.includes('--squash') && mergeCall.includes('--match-head-commit'));
  assert.ok(!mergeCall.includes('--admin') && !mergeCall.includes('--auto'), 'no bypass by construction');
});

test('CLI exit nonzero but platform says merged (expected head) → ok', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'connection reset' }),
    graphqlRoute(() => graphqlObservation(MERGED_OK)),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.deepEqual(out, { ok: true, merge_commit_sha: SHA_B });
});

test('merged with the WRONG head → tainted_merge carrying both SHAs, never ok', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    graphqlRoute(() => graphqlObservation({ ...MERGED_OK, headRefOid: SHA_C })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'tainted_merge');
    assert.ok(out.detail.includes(SHA_C) && out.detail.includes(SHA_A));
  }
});

test('merged state with MISSING proof fields → transport, never merged:false and never ok', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    graphqlRoute(() => graphqlObservation({ state: 'MERGED', mergedAt: null, headRefOid: SHA_A, mergeCommit: null })),
  ]);
  const result = await host.mergeResult(PR);
  assert.equal(result.merged, false);
  if (!result.merged) assert.equal(result.state, 'unknown');
});

// ─── Phase A enrollment windows (v4 Δ1 + ΔA) ─────────────────────────────────

test('Phase A: absent on read 1, enrollment visible on read 3 → revoked, not missed', async () => {
  let dequeued = false;
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    {
      match: (a) => a[0] === 'api' && a[1] === 'graphql' && String(a[3]).includes('dequeuePullRequest'),
      result: () => {
        dequeued = true;
        return { stdout: '{"data":{"dequeuePullRequest":{"clientMutationId":null}}}' };
      },
    },
    graphqlRoute((nth) =>
      nth === 2
        ? graphqlObservation({ isInMergeQueue: true, mergeQueueEntry: { id: 'q1', state: 'QUEUED' } })
        : nth < 5
          ? graphqlObservation({})
          : graphqlObservation({}),
    ),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(dequeued, true, 'delayed queue enrollment must be revoked via dequeuePullRequest');
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /standing enrollment|revoked/i);
});

test('Phase A exhaustion unknown/absent/unknown → standing_enrollment_unconfirmed, NEVER classification', async () => {
  const { host, gh } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'timeout' }),
    graphqlRoute((nth) => (nth === 1 ? graphqlObservation({}) : 'not-json{')),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'transport');
    assert.match(out.detail, /standing_enrollment_unconfirmed/);
  }
  assert.ok(!gh.calls.some((c) => c[0] === 'pr' && c[1] === 'checks'), 'must not fall through to checks');
});

test('Phase A absent/unknown/absent (no 2 consecutive) → unconfirmed, fail loudly', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'timeout' }),
    graphqlRoute((nth) => (nth === 1 ? 'not-json{' : graphqlObservation({}))),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /standing_enrollment_unconfirmed/);
});

test('auto-merge enrollment → --disable-auto (not dequeue); still-enrolled after revoke → unconfirmed', async () => {
  let disabled = 0;
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    {
      match: (a) => a[0] === 'pr' && a[1] === 'merge' && a.includes('--disable-auto'),
      result: () => {
        disabled += 1;
        return { exitCode: 0 };
      },
    },
    graphqlRoute(() => graphqlObservation({ autoMergeRequest: { enabledAt: '2026-07-23T00:00:00Z' } })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(disabled, 1);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /standing_enrollment_unconfirmed/);
});

test('revoke failure → typed standing_enrollment failure', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    {
      match: (a) => a[0] === 'api' && a[1] === 'graphql' && String(a[3]).includes('dequeuePullRequest'),
      result: { exitCode: 1, stderr: 'forbidden' },
    },
    graphqlRoute(() => graphqlObservation({ isInMergeQueue: true, mergeQueueEntry: { id: 'q1', state: 'QUEUED' } })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /standing_enrollment.*dequeuePullRequest failed/);
});

// ─── Unmerged classification table (v4 Δ4 + ΔC) ──────────────────────────────

test('head drifted → head_drift', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'head mismatch' }),
    graphqlRoute(() => graphqlObservation({ headRefOid: SHA_C })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'head_drift');
});

test('right head + red checks → checks_not_green', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'checks failing' }),
    graphqlRoute(() => graphqlObservation({})),
    checksCmd(['pass', 'fail']),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'checks_not_green');
});

test('right head + checks unknown → transport (never treated as red/green)', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'x' }),
    graphqlRoute(() => graphqlObservation({})),
    { match: (a) => a[0] === 'pr' && a[1] === 'checks', result: { stdout: '[]' } },
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'transport');
    assert.match(out.detail, /no_required_checks/);
  }
});

test('green checks + right head + DEFINITE policy stderr → protection_rejected', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'Base branch policy: review required before merging' }),
    graphqlRoute(() => graphqlObservation({})),
    checksCmd(['pass']),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'protection_rejected');
});

test('green checks + right head + ambiguous/no-ack failure → transport (ΔC conservative)', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'dial tcp: i/o timeout' }),
    graphqlRoute(() => graphqlObservation({})),
    checksCmd(['pass']),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'transport');
});

test('PR closed unmerged → pr_closed after final reconciliation, NEVER head_drift', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'pr closed' }),
    graphqlRoute(() => graphqlObservation({ state: 'CLOSED' })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'pr_closed');
    assert.equal(out.detail, 'pr_closed_unmerged');
  }
});

test('probe regression at merge time → refused BEFORE any merge mutation', async () => {
  const gh = scriptedExec([
    repoViewRoute(),
    rulesRoute([[{ type: 'merge_queue', ruleset_id: 2 }]]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/2'), result: { stdout: JSON.stringify({ id: 2, bypass_actors: [] }) } },
    classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: true } }),
    ...existenceRoutes(),
  ]);
  const { host } = makeHost({ gh, git: gitTopologyRoutes() });
  await host.resolveBase();
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'protection_rejected');
  assert.ok(!gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), 'no merge command after probe regression');
});

// ─── requiredChecksGreen bucket matrix (v3; R2 #6) ───────────────────────────

test('checks buckets: all pass/skipping → green; pending → pending; fail/cancel → red', async () => {
  for (const [buckets, expected] of [
    [['pass', 'skipping'], 'green'],
    [['pass', 'pending'], 'pending'],
    [['pass', 'fail'], 'red'],
    [['cancel'], 'red'],
  ] as const) {
    const { host } = await hostWithBase([checksCmd([...buckets])]);
    const res = await host.requiredChecksGreen(PR);
    assert.equal(res.status, expected, buckets.join(','));
  }
});

test('checks: zero required → unknown(no_required_checks); unknown bucket → unknown; exit 8 with valid JSON is diagnostic only', async () => {
  const { host: h1 } = await hostWithBase([{ match: (a) => a[0] === 'pr' && a[1] === 'checks', result: { stdout: '[]', exitCode: 0 } }]);
  const r1 = await h1.requiredChecksGreen(PR);
  assert.equal(r1.status, 'unknown');

  const { host: h2 } = await hostWithBase([{ match: (a) => a[0] === 'pr' && a[1] === 'checks', result: { stdout: JSON.stringify([{ name: 'c', bucket: 'mystery' }]) } }]);
  const r2 = await h2.requiredChecksGreen(PR);
  assert.equal(r2.status, 'unknown');

  const { host: h3 } = await hostWithBase([{ match: (a) => a[0] === 'pr' && a[1] === 'checks', result: { stdout: JSON.stringify([{ name: 'c', bucket: 'pending' }]), exitCode: 8 } }]);
  const r3 = await h3.requiredChecksGreen(PR);
  assert.equal(r3.status, 'pending', 'exit 8 with parseable JSON classifies from JSON');

  const { host: h4 } = await hostWithBase([{ match: (a) => a[0] === 'pr' && a[1] === 'checks', result: { stdout: 'garbage', exitCode: 1 } }]);
  const r4 = await h4.requiredChecksGreen(PR);
  assert.equal(r4.status, 'unknown');
});

// ─── headSha / mergeResult unions ────────────────────────────────────────────

test('headSha: open → sha; closed → closed; missing PR → not_found; garbage → transport', async () => {
  const { host: h1 } = await hostWithBase([graphqlRoute(() => graphqlObservation({ headRefOid: SHA_B }))]);
  assert.deepEqual(await h1.headSha(PR), { ok: true, sha: SHA_B });

  const { host: h2 } = await hostWithBase([graphqlRoute(() => graphqlObservation({ state: 'CLOSED' }))]);
  assert.deepEqual(await h2.headSha(PR), { ok: false, reason: 'closed' });

  const { host: h3 } = await hostWithBase([graphqlRoute(() => graphqlObservation(null))]);
  assert.deepEqual(await h3.headSha(PR), { ok: false, reason: 'not_found' });

  const { host: h4 } = await hostWithBase([graphqlRoute(() => 'garbage')]);
  assert.deepEqual(await h4.headSha(PR), { ok: false, reason: 'transport' });
});

test('every gh call in the merge path is --repo scoped to the recorded repo', async () => {
  const { host, gh } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    graphqlRoute(() => graphqlObservation(MERGED_OK)),
  ]);
  await host.mergeAtomic(PR, SHA_A);
  for (const call of gh.calls.filter((c) => c[0] === 'pr')) {
    const i = call.indexOf('--repo');
    assert.ok(i > 0 && call[i + 1] === REPO, `pr command must be --repo scoped: ${call.join(' ')}`);
  }
});

// ─── impl-R1 fix-round additions ─────────────────────────────────────────────

test('REJECTED merge executor promise still runs Phase A; merged → ok (impl-R1 CRIT #1)', async () => {
  const { host, gh } = await hostWithBase([
    {
      match: (a) => a[0] === 'pr' && a[1] === 'merge' && !a.includes('--disable-auto'),
      result: () => {
        throw new Error('spawn timeout');
      },
    },
    graphqlRoute(() => graphqlObservation(MERGED_OK)),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.deepEqual(out, { ok: true, merge_commit_sha: SHA_B }, 'rejection must not bypass reconciliation');
  assert.ok(gh.calls.some((c) => c[1] === 'graphql'), 'Phase A observation ran');
});

test('REJECTED revoke executor → typed standing_enrollment failure (impl-R1 CRIT #1)', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    {
      match: (a) => a[0] === 'api' && a[1] === 'graphql' && String(a[3]).includes('dequeuePullRequest'),
      result: () => {
        throw new Error('socket hang up');
      },
    },
    graphqlRoute(() => graphqlObservation({ isInMergeQueue: true, mergeQueueEntry: { id: 'q1', state: 'QUEUED' } })),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.detail, /standing_enrollment.*executor rejected/);
});

test('Phase B: stale positive then 2 absents → cleanup CONFIRMED, not parked (impl-R1 MAJ #1)', async () => {
  let dequeued = false;
  // Phase A reads 0-1: enrolled on read 0. Phase B reads: stale positive, absent, absent.
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 0 }),
    {
      match: (a) => a[0] === 'api' && a[1] === 'graphql' && String(a[3]).includes('dequeuePullRequest'),
      result: () => {
        dequeued = true;
        return { stdout: '{"data":{"dequeuePullRequest":{"clientMutationId":null}}}' };
      },
    },
    graphqlRoute((nth) =>
      nth === 0 || nth === 1
        ? graphqlObservation({ isInMergeQueue: true, mergeQueueEntry: { id: 'q1', state: 'QUEUED' } })
        : graphqlObservation({}),
    ),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(dequeued, true);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, 'protection_rejected', 'confirmed cleanup → revoked outcome, NOT unconfirmed');
    assert.match(out.detail, /revoked/);
  }
});

test('green checks + right head + SSO/protected-flavored transport stderr → transport (impl-R1 MAJ #2)', async () => {
  const { host } = await hostWithBase([
    mergeCmd({ exitCode: 1, stderr: 'error: resource protected by organization SAML enforcement' }),
    graphqlRoute(() => graphqlObservation({})),
    checksCmd(['pass']),
  ]);
  const out = await host.mergeAtomic(PR, SHA_A);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'transport', 'SSO noise must never classify as policy');
});
