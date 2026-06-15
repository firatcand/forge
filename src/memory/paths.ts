// FORGE-200 (Loom I1): canonical loom.db path resolver.
//
// The DB lives at <main-checkout-root>/.forge/loom.db so that a WORKTREE resolves
// to the SAME db as the main checkout (never its own) — a worktree carries no
// loom.db. We resolve the main-checkout root via `git rev-parse --git-common-dir`
// with a SANITIZED env (Codex / FORGE path-trust): Git honors GIT_DIR /
// GIT_WORK_TREE / GIT_COMMON_DIR / GIT_CEILING_DIRECTORIES, so an attacker who
// can set those could redirect resolution outside the user's project. We strip
// them before invoking git, anchoring resolution on cwd. Mirrors
// src/cli/second-opinion-suggest.ts:resolveGitCommonRoot.
//
// Not in a git repo (e.g. a bare test fixture) → fall back to <cwd>/.forge/loom.db.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const LOOM_DB_REL = path.join('.forge', 'loom.db');

// Resolve the main-checkout root from cwd via git-common-dir. Returns null when
// cwd is not inside a git repo. Uses execFileSync (no shell → no injection).
function resolveGitCommonRoot(cwd: string): string | null {
  const sanitizedEnv = { ...process.env };
  delete sanitizedEnv.GIT_DIR;
  delete sanitizedEnv.GIT_WORK_TREE;
  delete sanitizedEnv.GIT_COMMON_DIR;
  delete sanitizedEnv.GIT_CEILING_DIRECTORIES;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!out) return null;
    const commonDir = path.isAbsolute(out) ? out : path.resolve(cwd, out);
    // <root>/.git → root; for a worktree the common-dir is the MAIN checkout's
    // .git, so its parent is the main-checkout root.
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

// Resolve the absolute loom.db path for the given cwd. Worktrees resolve to the
// main-checkout db; non-git dirs fall back to <cwd>/.forge/loom.db.
export function resolveLoomDbPath(cwd: string): string {
  const root = resolveGitCommonRoot(cwd);
  if (root) return path.join(root, LOOM_DB_REL);
  return path.resolve(cwd, LOOM_DB_REL);
}

// Resolve the repo root (main checkout) for ingest source-walking. Falls back to
// cwd when not in a git repo.
export function resolveRepoRoot(cwd: string): string {
  return resolveGitCommonRoot(cwd) ?? path.resolve(cwd);
}
