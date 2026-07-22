// FORGE-231: host-independent default-branch resolution + the per-task frozen
// base (spec/ORCHESTRATOR.md §Branch topology; owner decisions 3 + SB).
//
// Resolution order for NEW tasks:
//   1. `git ls-remote --symref origin HEAD` — authoritative REMOTE truth;
//      detects a same-remote default-branch change even when the local
//      origin/HEAD ref is stale.
//   2. Fallback: local `git symbolic-ref refs/remotes/origin/HEAD` (offline).
//   3. Fallback: the persisted cache, ONLY when its remote fingerprint still
//      matches (a changed origin URL invalidates it).
// The cache lives at <mainRepoRoot>/.forge/orchestrator/global/repo.json —
// anchored to the MAIN repo root, never a worktree-local .forge. Its
// fingerprint is a sha256 of the CREDENTIAL-STRIPPED origin URL: nothing
// secret-bearing is persisted.
//
// The resolved (or explicit --base) value is FROZEN per task in the worktree
// marker as `base_branch`; a later global refresh never retargets an existing
// task.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { OrchestratorError } from './errors.ts';
import { writeAtomic } from './fs-atomic.ts';

const GIT_ENV = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } as const;
const GIT_TIMEOUT_MS = 15_000;

export const RepoInfoSchema = z.object({
  version: z.literal(1),
  default_branch: z.string().min(1).max(200),
  // sha256 of the credential-stripped origin URL.
  remote_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(['ls-remote', 'symbolic-ref', 'cache']),
  resolved_at: z.string().datetime(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

function repoInfoPath(mainRepoRoot: string): string {
  return path.join(mainRepoRoot, '.forge', 'orchestrator', 'global', 'repo.json');
}

// Strip userinfo (credentials) from an origin URL before fingerprinting.
function sanitizeOriginUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    // scp-like syntax (git@host:owner/repo.git) — no embedded credentials
    // beyond the ssh user, which is not a secret; keep as-is.
    return url;
  }
}

async function git(mainRepoRoot: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await execa('git', args, {
    cwd: mainRepoRoot,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    reject: false,
  });
  return { ok: result.exitCode === 0 && !result.failed, stdout: String(result.stdout ?? '') };
}

async function remoteFingerprint(mainRepoRoot: string): Promise<string | null> {
  const r = await git(mainRepoRoot, ['remote', 'get-url', 'origin']);
  if (!r.ok) return null;
  return createHash('sha256').update(sanitizeOriginUrl(r.stdout.trim())).digest('hex');
}

// Canonicalize a branch reference: `dev` == `origin/dev` ==
// `refs/remotes/origin/dev` → `dev`, validated with git's own ref grammar.
export async function normalizeBranchRef(mainRepoRoot: string, input: string): Promise<string> {
  let name = input.trim();
  if (name.startsWith('refs/remotes/origin/')) name = name.slice('refs/remotes/origin/'.length);
  else if (name.startsWith('origin/')) name = name.slice('origin/'.length);
  if (name.length === 0 || name.length > 200) {
    throw new OrchestratorError('INVALID_ID', `invalid base branch '${input}'`, { input });
  }
  const check = await git(mainRepoRoot, ['check-ref-format', '--branch', name]);
  if (!check.ok) {
    throw new OrchestratorError('INVALID_ID', `'${name}' is not a valid branch name (git check-ref-format)`, {
      input,
      normalized: name,
    });
  }
  return name;
}

function readCache(mainRepoRoot: string): RepoInfo | null {
  const p = repoInfoPath(mainRepoRoot);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const parsed = RepoInfoSchema.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(mainRepoRoot: string, info: RepoInfo): void {
  try {
    writeAtomic(repoInfoPath(mainRepoRoot), `${JSON.stringify(info, null, 2)}\n`);
  } catch {
    // cache refresh is best-effort — resolution already succeeded
  }
}

// Resolve the repository's default branch (canonical name). Throws typed when
// every source fails — callers must not guess.
export async function resolveDefaultBranch(mainRepoRoot: string): Promise<RepoInfo> {
  const fingerprint = await remoteFingerprint(mainRepoRoot);

  // 1. Remote truth.
  const lsRemote = await git(mainRepoRoot, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (lsRemote.ok) {
    // First line: "ref: refs/heads/<branch>\tHEAD"
    const m = lsRemote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (m?.[1] && fingerprint !== null) {
      const info: RepoInfo = {
        version: 1,
        default_branch: m[1],
        remote_fingerprint: fingerprint,
        source: 'ls-remote',
        resolved_at: new Date().toISOString(),
      };
      writeCache(mainRepoRoot, info);
      return info;
    }
  }

  // 2. Local symbolic ref (offline fallback).
  const symbolic = await git(mainRepoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim();
    const name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : null;
    if (name && fingerprint !== null) {
      const info: RepoInfo = {
        version: 1,
        default_branch: name,
        remote_fingerprint: fingerprint,
        source: 'symbolic-ref',
        resolved_at: new Date().toISOString(),
      };
      writeCache(mainRepoRoot, info);
      return info;
    }
  }

  // 3. Fingerprint-matched cache.
  const cached = readCache(mainRepoRoot);
  if (cached !== null && fingerprint !== null && cached.remote_fingerprint === fingerprint) {
    return { ...cached, source: 'cache' };
  }

  throw new OrchestratorError(
    'IO_ERROR',
    `cannot resolve the default branch for ${mainRepoRoot}: ls-remote and origin/HEAD both failed and no fingerprint-matched cache exists`,
    { mainRepoRoot },
  );
}
