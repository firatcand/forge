// FORGE-232: createOrGetPullRequest reconciliation (plan v4 Δ3 + ΔB),
// resolveBase push topology (R2 #4), factory recovery (R2 #5),
// upsertBaseResolution fencing (R2 #3), structural billing invariant.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OrchestratorError } from '../../../src/core/errors.ts';
import {
  readShipRecord,
  upsertBaseResolution,
  upsertReviewedBinding,
} from '../../../src/orchestrator/ship-record.ts';
import { createGitHubRepoHost } from '../../../src/repo-hosts/detect.ts';
import { RepoHostError } from '../../../src/repo-hosts/errors.ts';
import { parseGitHubUrl } from '../../../src/repo-hosts/github.ts';
import {
  HOLDER,
  REPO,
  REVIEW,
  SHA_B,
  TASK,
  classicRoute,
  existenceRoutes,
  forgeDirWithRecord,
  gitTopologyRoutes,
  makeHost,
  repoViewRoute,
  rulesRoute,
  scriptedExec,
  type Route,
} from './helpers.ts';

const MARKER = `<!-- forge:task:${TASK} -->`;
const HEAD = `feat/${TASK}`;

function pull(number: number, state: 'open' | 'closed', marked: boolean, headRef = HEAD): unknown {
  return {
    number,
    state,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    body: marked ? `body\n${MARKER}\n` : 'body',
    head: { ref: headRef },
    base: { ref: 'main' },
  };
}

function pullsRoute(pages: unknown[][] | ((nth: number) => unknown[][])): Route {
  return {
    match: (a) => a[0] === 'api' && a.includes(`repos/${REPO}/pulls`),
    result: (_a, nth) => ({ stdout: JSON.stringify(typeof pages === 'function' ? pages(nth) : pages) }),
  };
}

async function resolvedHost(extra: Route[]) {
  const gh = scriptedExec([repoViewRoute(), ...extra]);
  const { host, forgeDir } = makeHost({ gh, git: gitTopologyRoutes() });
  await host.resolveBase();
  return { host, gh, forgeDir };
}

// ─── createOrGetPullRequest ──────────────────────────────────────────────────

test('single marked open exact match → returned; encoded head filter asserted', async () => {
  const { host, gh } = await resolvedHost([pullsRoute([[pull(7, 'open', true)]])]);
  const ref = await host.createOrGetPullRequest(HEAD, 'main');
  assert.deepEqual(ref, { repo: REPO, number: 7, url: `https://github.com/${REPO}/pull/7` });
  const list = gh.calls.find((c) => c.includes(`repos/${REPO}/pulls`))!;
  assert.ok(list.includes('-f') && list.includes(`head=octo:${HEAD}`), 'head filter via -f (encoded), not string interpolation');
  assert.ok(list.includes('--paginate') && list.includes('--slurp'));
});

test('match on page 2 of --slurp array-of-pages is found', async () => {
  const { host } = await resolvedHost([pullsRoute([[], [pull(9, 'open', true)]])]);
  const ref = await host.createOrGetPullRequest(HEAD, 'main');
  assert.equal(ref.number, 9);
});

test('marked CLOSED match → pr_conflict (never silently recreated)', async () => {
  const { host } = await resolvedHost([pullsRoute([[pull(3, 'closed', true)]])]);
  await assert.rejects(
    () => host.createOrGetPullRequest(HEAD, 'main'),
    (err) => err instanceof RepoHostError && err.code === 'pr_conflict',
  );
});

test('unmarked exact open match (another actor owns the pair) → pr_conflict', async () => {
  const { host } = await resolvedHost([pullsRoute([[pull(4, 'open', false)]])]);
  await assert.rejects(
    () => host.createOrGetPullRequest(HEAD, 'main'),
    (err) => err instanceof RepoHostError && err.code === 'pr_conflict',
  );
});

test('marked-closed + unmarked-open both present → pr_conflict listing the set', async () => {
  const { host } = await resolvedHost([pullsRoute([[pull(3, 'closed', true), pull(4, 'open', false)]])]);
  await assert.rejects(
    () => host.createOrGetPullRequest(HEAD, 'main'),
    (err) => err instanceof RepoHostError && err.code === 'pr_conflict' && /#3.*#4|#4.*#3/.test(String(err.details.detail)),
  );
});

test('two marked open matches → pr_conflict (ambiguity fails closed)', async () => {
  const { host } = await resolvedHost([pullsRoute([[pull(5, 'open', true), pull(6, 'open', true)]])]);
  await assert.rejects(
    () => host.createOrGetPullRequest(HEAD, 'main'),
    (err) => err instanceof RepoHostError && err.code === 'pr_conflict',
  );
});

test('empty set → create; verified read returns the created PR', async () => {
  const { host, gh } = await resolvedHost([
    pullsRoute((nth) => (nth === 0 ? [[]] : [[pull(21, 'open', true)]])),
    { match: ['pr', 'create'], result: { stdout: `https://github.com/${REPO}/pull/21\n` } },
  ]);
  const ref = await host.createOrGetPullRequest(HEAD, 'main');
  assert.equal(ref.number, 21);
  const create = gh.calls.find((c) => c[0] === 'pr' && c[1] === 'create')!;
  assert.ok(create.includes('--repo') && create[create.indexOf('--repo') + 1] === REPO);
  const body = create[create.indexOf('--body') + 1]!;
  assert.ok(body.includes(MARKER), 'created body carries the forge marker');
});

test('create success + ALL verification reads stale → parsed create-URL ref returned (ΔB)', async () => {
  const { host } = await resolvedHost([
    pullsRoute([[]]),
    { match: ['pr', 'create'], result: { stdout: `https://github.com/${REPO}/pull/33\n` } },
  ]);
  const ref = await host.createOrGetPullRequest(HEAD, 'main');
  assert.deepEqual(ref, { repo: REPO, number: 33, url: `https://github.com/${REPO}/pull/33` });
});

test('create fails (duplicate race) + re-list recovers the winner', async () => {
  const { host } = await resolvedHost([
    pullsRoute((nth) => (nth === 0 ? [[]] : [[pull(40, 'open', true)]])),
    { match: ['pr', 'create'], result: { exitCode: 1, stderr: 'a pull request already exists' } },
  ]);
  const ref = await host.createOrGetPullRequest(HEAD, 'main');
  assert.equal(ref.number, 40);
});

test('create fails + re-list finds nothing → ORIGINAL create error propagated', async () => {
  const { host } = await resolvedHost([
    pullsRoute([[]]),
    { match: ['pr', 'create'], result: { exitCode: 1, stderr: 'boom-original' } },
  ]);
  await assert.rejects(
    () => host.createOrGetPullRequest(HEAD, 'main'),
    (err) => err instanceof RepoHostError && err.code === 'transport' && /boom-original/.test(String(err.details.stderr)),
  );
});

// ─── resolveBase push topology ───────────────────────────────────────────────

test('parseGitHubUrl: HTTPS / SSH / scp forms + non-github rejected', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r.git'), { host: 'github.com', repo: 'o/r' });
  assert.deepEqual(parseGitHubUrl('ssh://git@github.com/o/r'), { host: 'github.com', repo: 'o/r' });
  assert.deepEqual(parseGitHubUrl('git@github.com:o/r.git'), { host: 'github.com', repo: 'o/r' });
  assert.deepEqual(parseGitHubUrl('git@ghe.corp.example:o/r'), { host: 'ghe.corp.example', repo: 'o/r' });
  assert.equal(parseGitHubUrl('not a url'), null);
});

test('head-branch pushRemote takes precedence over pushDefault; all URLs must match base', async () => {
  const git = scriptedExec([
    { match: (a) => a[0] === 'config' && a[2] === `branch.${HEAD}.pushRemote`, result: { stdout: 'fork\n' } },
    { match: (a) => a[0] === 'config', result: { exitCode: 1 } },
    {
      match: (a) => a[0] === 'remote' && a.includes('fork'),
      result: { stdout: 'https://github.com/me/fork.git\n' },
    },
  ]);
  const gh = scriptedExec([repoViewRoute()]);
  const { host } = makeHost({ gh, git });
  await assert.rejects(
    () => host.resolveBase(),
    (err) => err instanceof RepoHostError && err.code === 'fork_topology',
  );
});

test('multiple push URLs: a single divergent second URL → fork_topology', async () => {
  const git = scriptedExec([
    { match: (a) => a[0] === 'config', result: { exitCode: 1 } },
    {
      match: (a) => a[0] === 'remote',
      result: { stdout: `https://github.com/${REPO}.git\nhttps://github.com/me/mirror.git\n` },
    },
  ]);
  const gh = scriptedExec([repoViewRoute()]);
  const { host } = makeHost({ gh, git });
  await assert.rejects(
    () => host.resolveBase(),
    (err) => err instanceof RepoHostError && err.code === 'fork_topology',
  );
});

test('GHES push URL → unsupported_host (OD2); standalone fork (push==base) is legal', async () => {
  const gitGhes = scriptedExec([
    { match: (a) => a[0] === 'config', result: { exitCode: 1 } },
    { match: (a) => a[0] === 'remote', result: { stdout: 'git@ghe.corp.example:o/r.git\n' } },
  ]);
  const { host: h1 } = makeHost({ gh: scriptedExec([repoViewRoute()]), git: gitGhes });
  await assert.rejects(
    () => h1.resolveBase(),
    (err) => err instanceof RepoHostError && err.code === 'unsupported_host',
  );

  const { host: h2 } = makeHost({
    gh: scriptedExec([repoViewRoute({ isFork: true, parent: { nameWithOwner: 'upstream/base' } })]),
    git: gitTopologyRoutes(),
  });
  const base = await h2.resolveBase();
  assert.equal(base.repo, REPO, 'isFork alone must not park when push==base');
});

test('resolveBase persists write-ahead; second call replays through the fence', async () => {
  const { host, forgeDir } = await resolvedHost([]);
  const record = readShipRecord(forgeDir, TASK)!;
  assert.deepEqual(record.base, { repo: REPO, branch: 'main', push_remote: 'origin' });
  const again = await host.resolveBase();
  assert.equal(again.repo, REPO);
});

test('persisted-base path REJECTS a superseded reviewed binding (fence, R2 #3)', async () => {
  const gh = scriptedExec([repoViewRoute()]);
  const { host, forgeDir } = makeHost({ gh, git: gitTopologyRoutes() });
  await host.resolveBase();
  // A NEW review binding lands (drift → re-review) — the stale host's binding
  // is superseded; its persisted-base fast path must now conflict.
  upsertReviewedBinding(forgeDir, TASK, {
    reviewedHeadSha: SHA_B,
    reviewAttemptId: 'attempt-r2',
    holder: HOLDER,
  });
  await assert.rejects(
    () => host.resolveBase(),
    (err) => err instanceof OrchestratorError && err.code === 'STALE_ATTEMPT',
  );
});

// ─── upsertBaseResolution semantics ──────────────────────────────────────────

const BASE = { repo: REPO, branch: 'main', push_remote: 'origin' };

test('upsertBaseResolution: never creates; null→base; same-base replay runs fence; different base conflicts', () => {
  const fd = forgeDirWithRecord();
  assert.throws(
    () => upsertBaseResolution(fd, 'NO-RECORD', { base: BASE, expectedReviewAttemptId: 'x', expectedReviewedHeadSha: SHA_B, holder: HOLDER }),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'STATE_NOT_FOUND',
  );

  const opts = { base: BASE, expectedReviewAttemptId: REVIEW.attemptId, expectedReviewedHeadSha: REVIEW.headSha, holder: HOLDER };
  const written = upsertBaseResolution(fd, TASK, opts);
  assert.deepEqual(written.base, BASE);
  assert.equal(written.merge_attempt, 'not_started', 'merge_attempt preserved');

  let fenceRan = false;
  const replayed = upsertBaseResolution(fd, TASK, { ...opts, fence: () => { fenceRan = true; } });
  assert.equal(replayed.revision, written.revision, 'same-base replay is a no-op write');
  assert.equal(fenceRan, true, 'fence still runs on replay');

  assert.throws(
    () => upsertBaseResolution(fd, TASK, { ...opts, base: { ...BASE, repo: 'other/repo' } }),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'STATE_VERSION_CONFLICT',
  );
});

test('upsertBaseResolution: reviewed-binding mismatch → STALE_ATTEMPT before any write', () => {
  const fd = forgeDirWithRecord();
  assert.throws(
    () =>
      upsertBaseResolution(fd, TASK, {
        base: BASE,
        expectedReviewAttemptId: 'attempt-superseded',
        expectedReviewedHeadSha: SHA_B,
        holder: HOLDER,
      }),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'STALE_ATTEMPT',
  );
  assert.equal(readShipRecord(fd, TASK)!.base, null, 'no base written');
});

// ─── Factory (R2 #5) ─────────────────────────────────────────────────────────

const factoryBase = (gh: ReturnType<typeof scriptedExec>, git: ReturnType<typeof scriptedExec>, forgeDir: string) => ({
  gh,
  git,
  worktreePath: '/nowhere',
  taskId: TASK,
  forgeDir,
  baseBranch: 'main',
  headBranch: HEAD,
  reviewBinding: REVIEW,
  holder: HOLDER,
  pollDelayMs: 0,
});

test('factory: persisted base is authoritative — remote swapped to GitLab still constructs', async () => {
  const fd = forgeDirWithRecord();
  upsertBaseResolution(fd, TASK, { base: BASE, expectedReviewAttemptId: REVIEW.attemptId, expectedReviewedHeadSha: REVIEW.headSha, holder: HOLDER });
  const gh = scriptedExec([{ match: ['auth', 'status'], result: { exitCode: 0 } }]);
  const git = scriptedExec([{ match: (a) => a[0] === 'remote', result: { stdout: 'https://gitlab.com/o/r.git\n' } }]);
  const host = await createGitHubRepoHost(factoryBase(gh, git, fd));
  assert.ok(host !== null, 'recovery must construct from the durable identity');
  assert.ok(!git.calls.length, 'no remote sniffing when the base is persisted');
});

test('factory: no record + non-github push → null; github push → adapter; auth is --hostname scoped', async () => {
  const fd1 = forgeDirWithRecord();
  const gh1 = scriptedExec([{ match: ['auth', 'status'], result: { exitCode: 0 } }]);
  const git1 = scriptedExec([{ match: (a) => a[0] === 'remote', result: { stdout: 'https://gitlab.com/o/r.git\n' } }]);
  assert.equal(await createGitHubRepoHost(factoryBase(gh1, git1, fd1)), null);

  const fd2 = forgeDirWithRecord();
  const gh2 = scriptedExec([{ match: ['auth', 'status'], result: { exitCode: 0 } }]);
  const git2 = scriptedExec([{ match: (a) => a[0] === 'remote', result: { stdout: `https://github.com/${REPO}.git\n` } }]);
  const host = await createGitHubRepoHost(factoryBase(gh2, git2, fd2));
  assert.ok(host !== null);
  const auth = gh2.calls.find((c) => c[0] === 'auth')!;
  assert.ok(auth.includes('--hostname') && auth.includes('github.com'));

  const fd3 = forgeDirWithRecord();
  const gh3 = scriptedExec([{ match: ['auth', 'status'], result: { exitCode: 1, stderr: 'not logged in' } }]);
  assert.equal(await createGitHubRepoHost(factoryBase(gh3, scriptedExec([]), fd3)), null, 'unauthenticated → null');
});

// ─── Structural billing invariant ────────────────────────────────────────────

test('src/repo-hosts/** imports no harness/model-runner modules (billing invariant)', () => {
  const dir = join(process.cwd(), 'src', 'repo-hosts');
  const banned = /from '(\.\.\/)+(harnesses|cli\/codex|sync-status)\//;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    assert.ok(!banned.test(src), `${file} must not import harness/model modules`);
    assert.ok(!/execa/.test(src), `${file} must not spawn processes directly — executors are injected`);
  }
});
