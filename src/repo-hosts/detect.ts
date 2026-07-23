// FORGE-232: GitHubRepoHost factory (plan v3 §factory + R2 #5).
// Activation is independent of tracker.type (ORCHESTRATOR §RepoHost): a
// persisted ship-record base is AUTHORITATIVE during recovery — a repo whose
// remote was swapped away after PR creation must still reconcile its recorded
// GitHub PR. Remote sniffing happens ONLY when no base is persisted. OD2:
// github.com only; anything else → null (consumer parks; ship unavailable).

import { OrchestratorError } from '../core/errors.ts';
import { readShipRecord } from '../orchestrator/ship-record.ts';
import { RepoHostError } from './errors.ts';
import {
  GitHubRepoHost,
  parseGitHubUrl,
  resolveEffectivePushTopology,
  type Exec,
  type GitHubRepoHostOptions,
} from './github.ts';

export type CreateGitHubRepoHostOptions = Omit<GitHubRepoHostOptions, 'gh' | 'git'> & {
  gh: Exec;
  git: Exec;
};

async function ghAuthOk(gh: Exec): Promise<boolean> {
  // impl-R2 MAJ #3: a rejected executor is "not authenticated", not an
  // unhandled rejection escaping the factory.
  try {
    const res = await gh(['auth', 'status', '--hostname', 'github.com']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

export async function createGitHubRepoHost(
  opts: CreateGitHubRepoHostOptions,
): Promise<GitHubRepoHost | null> {
  // Record FIRST (impl-R3 MIN): broken durable state must surface even when
  // authentication is down — auth-null must never mask a corrupt record.
  let record;
  try {
    record = readShipRecord(opts.forgeDir, opts.taskId);
  } catch (err) {
    const schema = (err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID') || err instanceof SyntaxError;
    throw new RepoHostError(
      schema ? 'schema' : 'transport',
      `ship record unreadable for task ${opts.taskId}`,
      { taskId: opts.taskId },
      { cause: err },
    );
  }

  if (!(await ghAuthOk(opts.gh))) return null;

  if (record?.base) {
    // Durable identity established under OD2 — construct without re-sniffing.
    return new GitHubRepoHost(opts);
  }

  // First resolution path (impl-R1 MAJ #4): activation uses the SAME
  // effective head-branch push precedence as resolveBase() — a GitLab origin
  // with branch.<head>.pushRemote → github.com must still activate, and every
  // effective push URL must be github.com. (Owner/repo fork comparison needs
  // gh metadata and stays in resolveBase().)
  const topology = await resolveEffectivePushTopology(opts.git, opts.headBranch);
  if (topology === null || topology.urls.length === 0) return null;
  for (const url of topology.urls) {
    const parsed = parseGitHubUrl(url);
    if (parsed === null || parsed.host !== 'github.com') return null;
  }

  return new GitHubRepoHost(opts);
}
