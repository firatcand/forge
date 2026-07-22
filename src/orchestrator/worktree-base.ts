// FORGE-231: the per-task FROZEN base branch (owner decision SB) lives in the
// worktree marker (.forge/worktree-task.json, written by workspace.create /
// backfilled by ensure-worktree). Reading it is shared by dispatch (to resolve
// the pinned review_base_sha at dispatch time) and the worker-prompt renderer.

import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { OrchestratorError } from '../core/errors.ts';
import { TASK_MARKER_RELPATH } from '../core/workspace.ts';

const MARKER_MAX_BYTES = 64 * 1024;
const GIT_ENV = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } as const;

// Returns the frozen base branch name, or null when the marker is absent or
// predates FORGE-231 (no base_branch field — ensure-worktree backfills it).
export function readFrozenBaseBranch(worktreePath: string): string | null {
  const markerPath = path.join(worktreePath, TASK_MARKER_RELPATH);
  let raw: string;
  try {
    const st = lstatSync(markerPath);
    if (!st.isFile() || st.size > MARKER_MAX_BYTES) return null;
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { base_branch?: unknown };
    if (typeof parsed.base_branch === 'string' && parsed.base_branch.length > 0 && parsed.base_branch.length <= 200) {
      return parsed.base_branch;
    }
  } catch {
    // unreadable marker — same as absent for this read
  }
  return null;
}

// Resolve a ref to a full 40-hex SHA inside a worktree. Typed failure — the
// pinned-review chain must never proceed with an unresolvable endpoint.
export async function resolveShaChecked(worktreePath: string, ref: string): Promise<string> {
  const result = await execa('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: worktreePath,
    env: GIT_ENV,
    timeout: 15_000,
    reject: false,
  });
  const sha = String(result.stdout ?? '').trim();
  if (result.exitCode !== 0 || result.failed || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new OrchestratorError('IO_ERROR', `cannot resolve '${ref}' to a commit in ${worktreePath}`, {
      ref,
      exitCode: result.exitCode ?? null,
      stderr: String(result.stderr ?? '').slice(0, 500),
    });
  }
  return sha;
}

// Pick the concrete ref for a frozen base branch NAME: prefer the
// remote-tracking ref (origin/<name>); fall back to the local branch when no
// remote-tracking ref exists (remoteless repos, hermetic fixtures). Typed
// failure when neither resolves — callers must never guess.
export async function resolveBaseRef(cwd: string, name: string): Promise<string> {
  for (const candidate of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
    const probe = await execa('git', ['rev-parse', '--verify', '--quiet', candidate], {
      cwd,
      env: GIT_ENV,
      timeout: 15_000,
      reject: false,
    });
    if (probe.exitCode === 0 && !probe.failed) {
      return candidate.startsWith('refs/remotes/') ? `origin/${name}` : name;
    }
  }
  throw new OrchestratorError('IO_ERROR', `base branch '${name}' resolves to neither origin/${name} nor a local branch in ${cwd}`, {
    name,
  });
}

