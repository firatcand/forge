// FORGE-232: honesty-probe matrix (plan v3 §probe; Codex R1 #1 / R2 / R3).
// Hermetic: every gh/git call goes through scriptedExec — an unmatched command
// throws, so nothing can escape to a live process.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPO,
  REVIEW,
  classicRoute,
  existenceRoutes,
  gitTopologyRoutes,
  makeHost,
  repoViewRoute,
  rulesRoute,
  scriptedExec,
} from './helpers.ts';
import { evaluateProbeBar } from '../../../src/repo-hosts/github.ts';

async function probed(routes: Parameters<typeof scriptedExec>[0]) {
  const gh = scriptedExec(routes);
  const { host } = makeHost({ gh, git: gitTopologyRoutes() });
  await host.resolveBase(); // persists base so probe() has a recorded repo
  return { report: await host.probe(), gh };
}

test('classic-only repo: required contexts counted, enforce_admins on, probe passes bar', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([[]]),
    classicRoute({
      required_status_checks: { contexts: ['ci', 'lint'] },
      enforce_admins: { enabled: true },
    }),
    ...existenceRoutes(),
  ]);
  assert.equal(report.ok, true);
  if (report.ok) {
    assert.equal(report.blocking_check_count, 2);
    assert.equal(report.bypass_rules_present, false);
    assert.equal(report.merge_queue_enabled, false);
    assert.equal(evaluateProbeBar(report), null);
  }
});

test('rulesets-only: paginated pages flattened; merge_queue on page 2 detected', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([
      [{ type: 'required_status_checks', ruleset_id: 7, parameters: { required_status_checks: [{ context: 'ci' }] } }],
      [{ type: 'merge_queue', ruleset_id: 7 }],
    ]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/7'), result: { stdout: JSON.stringify({ id: 7, bypass_actors: [] }) } },
    classicRoute('absent'),
    ...existenceRoutes(),
  ]);
  assert.equal(report.ok, true);
  if (report.ok) {
    assert.equal(report.merge_queue_enabled, true, 'merge_queue on page 2 must be seen');
    assert.equal(report.blocking_check_count, 1);
    assert.match(evaluateProbeBar(report) ?? '', /merge queue/);
  }
});

test('ruleset bypass_actors NON-EMPTY → bypass_rules_present', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([[{ type: 'required_status_checks', ruleset_id: 9, parameters: { required_status_checks: [{ context: 'ci' }] } }]]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/9'), result: { stdout: JSON.stringify({ id: 9, bypass_actors: [{ actor_id: 1 }] }) } },
    classicRoute('absent'),
    ...existenceRoutes(),
  ]);
  assert.equal(report.ok, true);
  if (report.ok) {
    assert.equal(report.bypass_rules_present, true);
    assert.match(evaluateProbeBar(report) ?? '', /bypass/);
  }
});

test('ruleset detail OMITS bypass_actors → probe fails closed (auth)', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([[{ type: 'required_status_checks', ruleset_id: 5, parameters: { required_status_checks: [{ context: 'ci' }] } }]]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/5'), result: { stdout: JSON.stringify({ id: 5 }) } },
  ]);
  assert.equal(report.ok, false);
  if (!report.ok) {
    assert.equal(report.reason, 'auth');
    assert.match(report.detail, /bypass_actors/);
  }
});

test('ruleset detail unreadable (org/enterprise scope) → probe fails closed', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([[{ type: 'required_status_checks', ruleset_id: 11, parameters: { required_status_checks: [{ context: 'ci' }] } }]]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/11'), result: { exitCode: 1, stderr: 'HTTP 404' } },
  ]);
  assert.equal(report.ok, false);
  if (!report.ok) assert.equal(report.reason, 'auth');
});

test('ruleset detail malformed JSON → transport failure, never a pass', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute([[{ type: 'required_status_checks', ruleset_id: 3, parameters: { required_status_checks: [{ context: 'ci' }] } }]]),
    { match: (a) => a[0] === 'api' && String(a[1]).endsWith('/rulesets/3'), result: { stdout: 'not-json{' } },
  ]);
  assert.equal(report.ok, false);
  if (!report.ok) assert.equal(report.reason, 'transport');
});

test('classic 403 (Administration:read missing) → auth failure, fail closed', async () => {
  const { report } = await probed([repoViewRoute(), rulesRoute(), classicRoute('403')]);
  assert.equal(report.ok, false);
  if (!report.ok) assert.equal(report.reason, 'auth');
});

test('ambiguous 404 (repo/branch existence NOT proven) → fail closed', async () => {
  const { report } = await probed([
    repoViewRoute(),
    rulesRoute(),
    classicRoute('absent'),
    ...existenceRoutes(false),
  ]);
  assert.equal(report.ok, false);
  if (!report.ok) assert.equal(report.reason, 'not_found');
});

test('generic non-protection 404 text → transport failure (not classic-absent)', async () => {
  const { report } = await probed([repoViewRoute(), rulesRoute(), classicRoute('ambiguous404')]);
  assert.equal(report.ok, false);
  if (!report.ok) assert.equal(report.reason, 'transport');
});

test('enforce_admins:false + ADMIN viewer → bypass present; bar fails', async () => {
  const { report } = await probed([
    repoViewRoute({ viewerCanAdminister: true }),
    rulesRoute(),
    classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: false } }),
    ...existenceRoutes(),
  ]);
  assert.equal(report.ok, true);
  if (report.ok) assert.equal(report.bypass_rules_present, true);
});

test('enforce_admins:false + NON-admin viewer → NOT flagged (no bypass in play)', async () => {
  const { report } = await probed([
    repoViewRoute({ viewerPermission: 'WRITE', viewerCanAdminister: false }),
    rulesRoute(),
    classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: false } }),
    ...existenceRoutes(),
  ]);
  assert.equal(report.ok, true);
  if (report.ok) {
    assert.equal(report.bypass_rules_present, false);
    assert.equal(evaluateProbeBar(report), null);
  }
});

test('squash disallowed / no write perm / zero blocking checks → bar fails', async () => {
  const base = [rulesRoute(), classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: true } }), ...existenceRoutes()];
  const { report: noSquash } = await probed([repoViewRoute({ squashMergeAllowed: false }), ...base]);
  assert.equal(noSquash.ok && evaluateProbeBar(noSquash) !== null, true);
  assert.match(noSquash.ok ? evaluateProbeBar(noSquash)! : '', /squash/);

  const { report: noWrite } = await probed([repoViewRoute({ viewerPermission: 'READ', viewerCanAdminister: false }), ...base]);
  assert.match(noWrite.ok ? evaluateProbeBar(noWrite)! : '', /write permission/);

  const { report: noChecks } = await probed([
    repoViewRoute(),
    rulesRoute(),
    classicRoute('absent'),
    ...existenceRoutes(),
  ]);
  assert.match(noChecks.ok ? evaluateProbeBar(noChecks)! : '', /blocking required/);
});

test('slash-containing base branch is URL-encoded in every API path', async () => {
  const gh = scriptedExec([
    repoViewRoute(),
    rulesRoute(),
    classicRoute({ required_status_checks: { contexts: ['ci'] }, enforce_admins: { enabled: true } }),
    ...existenceRoutes(),
  ]);
  const { host } = makeHost({ gh, git: gitTopologyRoutes(), baseBranch: 'release/1.0' });
  await host.resolveBase();
  await host.probe();
  const apiPaths = gh.calls.filter((c) => c[0] === 'api').map((c) => c.slice(1).find((a) => a.includes('branches')) ?? '');
  const withBranch = apiPaths.filter((p) => p.includes('release'));
  assert.ok(withBranch.length >= 1);
  for (const p of withBranch) {
    assert.ok(p.includes('release%2F1.0'), `path must URL-encode the slash: ${p}`);
    assert.ok(!/branches\/release\/1\.0/.test(p), `raw slash must not alter the path: ${p}`);
  }
});

test('probe without a persisted base → record_missing surfaces as failed probe', async () => {
  const gh = scriptedExec([]);
  const { host } = makeHost({ gh });
  const report = await host.probe();
  assert.equal(report.ok, false);
  if (!report.ok) assert.match(report.detail, /resolveBase/);
});
