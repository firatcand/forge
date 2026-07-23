// FORGE-232: GitHubRepoHost factory (plan v3 §factory + R2 #5).
// Activation is independent of tracker.type (ORCHESTRATOR §RepoHost): a
// persisted ship-record base is AUTHORITATIVE during recovery — a repo whose
// remote was swapped away after PR creation must still reconcile its recorded
// GitHub PR. Remote sniffing happens ONLY when no base is persisted. OD2:
// github.com only; anything else → null (consumer parks; ship unavailable).

import { readShipRecord } from '../orchestrator/ship-record.ts';
import { GitHubRepoHost, parseGitHubUrl, type Exec, type GitHubRepoHostOptions } from './github.ts';

export type CreateGitHubRepoHostOptions = Omit<GitHubRepoHostOptions, 'gh' | 'git'> & {
  gh: Exec;
  git: Exec;
};

async function ghAuthOk(gh: Exec): Promise<boolean> {
  const res = await gh(['auth', 'status', '--hostname', 'github.com']);
  return res.exitCode === 0;
}

export async function createGitHubRepoHost(
  opts: CreateGitHubRepoHostOptions,
): Promise<GitHubRepoHost | null> {
  if (!(await ghAuthOk(opts.gh))) return null;

  const record = readShipRecord(opts.forgeDir, opts.taskId);
  if (record?.base) {
    // Durable identity established under OD2 — construct without re-sniffing.
    return new GitHubRepoHost(opts);
  }

  // First resolution path: the effective push destination must be github.com.
  // (Full topology validation — all push URLs, fork comparison — runs inside
  // resolveBase(); this is the cheap activation gate.)
  const remoteRes = await opts.git(['remote', 'get-url', '--push', 'origin']);
  if (remoteRes.exitCode !== 0) return null;
  const parsed = parseGitHubUrl(remoteRes.stdout.trim().split('\n')[0] ?? '');
  if (parsed === null || parsed.host !== 'github.com') return null;

  return new GitHubRepoHost(opts);
}
