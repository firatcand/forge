// FORGE-232 test helpers: scripted Exec fakes (NO live gh/git — the billing +
// no-live-CI invariant) and ship-record fixtures.

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CasHolderIdentity } from '../../../src/core/fs-atomic.ts';
import { upsertReviewedBinding } from '../../../src/orchestrator/ship-record.ts';
import type { Exec, ExecResult, GitHubRepoHostOptions } from '../../../src/repo-hosts/github.ts';
import { GitHubRepoHost } from '../../../src/repo-hosts/github.ts';

export const HOLDER: CasHolderIdentity = { run_id: 'run-1', claim_id: 'claim-1', generation: 1 };
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);

export interface Route {
  /** Matches when every element of `prefix` appears in order at the start of args, OR predicate returns true. */
  match: string[] | ((args: readonly string[]) => boolean);
  /** Static result or per-call function; called each time the route matches. */
  result: Partial<ExecResult> | ((args: readonly string[], nthMatch: number) => Partial<ExecResult>);
}

export interface ScriptedExec extends Exec {
  calls: string[][];
}

export function scriptedExec(routes: Route[]): ScriptedExec {
  const calls: string[][] = [];
  const matchCounts = new Map<Route, number>();
  const fn = (async (args: readonly string[]) => {
    calls.push([...args]);
    for (const route of routes) {
      const hit = Array.isArray(route.match)
        ? route.match.every((m, i) => args[i] === m)
        : route.match(args);
      if (hit) {
        const nth = matchCounts.get(route) ?? 0;
        matchCounts.set(route, nth + 1);
        const partial = typeof route.result === 'function' ? route.result(args, nth) : route.result;
        return { stdout: '', stderr: '', exitCode: 0, ...partial };
      }
    }
    throw new Error(`scriptedExec: unmatched command: ${args.join(' ')}`);
  }) as ScriptedExec;
  fn.calls = calls;
  return fn;
}

export function tempForgeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-232-'));
  mkdirSync(join(dir, 'orchestrator', 'tasks'), { recursive: true });
  return dir;
}

export const TASK = 'FORGE-T1';
export const REVIEW = { attemptId: 'attempt-r1', headSha: SHA_A };

/** forgeDir with a minted reviewed binding (the precondition for base writes). */
export function forgeDirWithRecord(): string {
  const forgeDir = tempForgeDir();
  upsertReviewedBinding(forgeDir, TASK, {
    reviewedHeadSha: REVIEW.headSha,
    reviewAttemptId: REVIEW.attemptId,
    holder: HOLDER,
  });
  return forgeDir;
}

export function makeHost(
  overrides: Partial<GitHubRepoHostOptions> & { gh: Exec; git?: Exec },
  forgeDir?: string,
): { host: GitHubRepoHost; forgeDir: string } {
  const fd = forgeDir ?? forgeDirWithRecord();
  const host = new GitHubRepoHost({
    git: scriptedExec([]),
    worktreePath: '/nonexistent-worktree',
    taskId: TASK,
    forgeDir: fd,
    baseBranch: 'main',
    headBranch: `feat/${TASK}`,
    reviewBinding: REVIEW,
    holder: HOLDER,
    pollDelayMs: 0,
    ...overrides,
  });
  return { host, forgeDir: fd };
}

// ─── Common gh routes ────────────────────────────────────────────────────────

export const REPO = 'octo/base';

export function repoViewRoute(json: Record<string, unknown> = {}): Route {
  return {
    match: (a) => a[0] === 'repo' && a[1] === 'view',
    result: {
      stdout: JSON.stringify({
        nameWithOwner: REPO,
        isFork: false,
        parent: null,
        squashMergeAllowed: true,
        viewerPermission: 'ADMIN',
        viewerCanAdminister: true,
        ...json,
      }),
    },
  };
}

export function rulesRoute(rules: unknown[][] = [[]]): Route {
  return {
    match: (a) => a[0] === 'api' && String(a[3] ?? a[1]).includes('/rules/branches/'),
    result: { stdout: JSON.stringify(rules) },
  };
}

export function classicRoute(body: Record<string, unknown> | 'absent' | '403' | 'ambiguous404'): Route {
  return {
    match: (a) => a[0] === 'api' && String(a[1]).includes('/protection'),
    result:
      body === '403'
        ? { exitCode: 1, stderr: 'HTTP 403: Resource not accessible' }
        : body === 'absent'
          ? { exitCode: 1, stderr: 'HTTP 404: Branch not protected' }
          : body === 'ambiguous404'
            ? { exitCode: 1, stderr: 'HTTP 404: Not Found' }
            : { stdout: JSON.stringify(body) },
  };
}

export function existenceRoutes(ok = true): Route[] {
  return [
    { match: (a) => a[0] === 'api' && a[1] === `repos/${REPO}`, result: { exitCode: ok ? 0 : 1, stdout: '{}' } },
    {
      match: (a) => a[0] === 'api' && String(a[1]).includes('/branches/') && !String(a[1]).includes('protection') && !String(a[1]).includes('rules'),
      result: { exitCode: ok ? 0 : 1, stdout: '{}' },
    },
  ];
}

export function baseRecordedGh(extra: Route[] = []): ScriptedExec {
  return scriptedExec([repoViewRoute(), rulesRoute(), classicRoute({ enforce_admins: { enabled: true }, required_status_checks: { contexts: ['ci'] } }), ...existenceRoutes(), ...extra]);
}

export interface GraphqlPr {
  id?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt?: string | null;
  headRefOid?: string;
  baseRefName?: string;
  mergeCommit?: { oid: string } | null;
  autoMergeRequest?: { enabledAt: string | null } | null;
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { id: string; state: string } | null;
}

export function graphqlObservation(pr: GraphqlPr | null): string {
  const full =
    pr === null
      ? null
      : {
          id: 'PR_node1',
          state: 'OPEN',
          mergedAt: null,
          headRefOid: SHA_A,
          baseRefName: 'main',
          mergeCommit: null,
          autoMergeRequest: null,
          isInMergeQueue: false,
          mergeQueueEntry: null,
          ...pr,
        };
  return JSON.stringify({ data: { repository: { pullRequest: full } } });
}

export function graphqlRoute(fn: (nth: number) => string): Route {
  return {
    match: (a) => a[0] === 'api' && a[1] === 'graphql' && String(a[3]).startsWith('query=query('),
    result: (_a, nth) => ({ stdout: fn(nth) }),
  };
}

/** ship record base pre-persisted so recordedRepo() resolves. */
export async function withPersistedBase(host: GitHubRepoHost, gitRoutes?: Route[]): Promise<void> {
  // resolveBase persists octo/base via the injected execs.
  await host.resolveBase();
}

export function gitTopologyRoutes(pushUrl = `https://github.com/${REPO}.git`, extra: Route[] = []): ScriptedExec {
  return scriptedExec([
    { match: (a) => a[0] === 'config', result: { exitCode: 1 } },
    {
      match: (a) => a[0] === 'remote' && a[1] === 'get-url',
      result: { stdout: `${pushUrl}\n` },
    },
    ...extra,
  ]);
}
