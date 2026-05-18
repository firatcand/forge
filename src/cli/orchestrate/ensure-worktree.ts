// `forge orchestrate ensure-worktree` — idempotent worktree create + hydrate.
//
// Owns `.forge/worktrees/<task_id>/` per ORCHESTRATOR.md §80-98: only the CLI
// may create/remove worktrees. Both /pickup-task and /forge orchestrate call
// this verb instead of running `git worktree add` from skill markdown
// (Codex 2nd-pass #5 — architectural authority lives in CLI).
//
// Idempotence: if `.forge/worktrees/<task_id>/.forge/worktree-task.json`
// exists with matching task_id, no-op exit 0. With a conflicting task_id
// (someone else's worktree at the same path), exit 1 WORKTREE_CONFLICT.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

import {
  EnsureWorktreeArgsSchema,
  type EnsureWorktreeArgs,
} from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { create, sanitizeIssueId, TASK_MARKER_RELPATH } from '../../core/workspace.ts';
import { WorkspaceError } from '../../core/errors.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface EnsureWorktreeResult {
  readonly exitCode: number;
}

export async function runOrchestrateEnsureWorktree(
  args: EnsureWorktreeArgs,
): Promise<EnsureWorktreeResult> {
  const parsed = EnsureWorktreeArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // Resolve repo root. If not provided, use `git rev-parse --git-common-dir`
  // from the cwd implied by forgeDir's parent — mirrors /pickup-task's anchor
  // on the main checkout (not the current worktree, which would nest).
  let repoRoot: string;
  if (opts.repoRoot) {
    repoRoot = path.resolve(opts.repoRoot);
  } else {
    try {
      const { stdout } = await execa('git', ['rev-parse', '--git-common-dir'], {
        cwd: path.dirname(opts.forgeDir),
        reject: true,
      });
      repoRoot = path.resolve(path.dirname(stdout.trim()));
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            'NOT_A_REPO',
            `failed to resolve repo root: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
          { json: opts.json },
        ),
      };
    }
  }

  // Sanitize the task id and compute the canonical worktree path early so
  // we can run the idempotence check before any state mutation.
  let sanitized: string;
  try {
    sanitized = sanitizeIssueId(opts.taskId);
  } catch (err) {
    const code = err instanceof WorkspaceError ? err.code : 'INVALID_ARGS';
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: emit(fail(code, message, false), { json: opts.json }) };
  }

  const worktreeRoot = path.join(repoRoot, '.forge', 'worktrees');
  const worktreePath = path.join(worktreeRoot, sanitized);
  const markerPath = path.join(worktreePath, TASK_MARKER_RELPATH);

  // Idempotence check — same task_id marker means we already created this
  // worktree (probably a previous round of /forge orchestrate). No-op.
  if (existsSync(markerPath)) {
    try {
      const raw = readFileSync(markerPath, 'utf8');
      const parsedMarker = JSON.parse(raw) as { taskId?: unknown };
      if (parsedMarker.taskId === sanitized) {
        return {
          exitCode: emit(
            ok({
              worktree_path: worktreePath,
              created: false,
              hydrated: [],
            }),
            { json: opts.json },
          ),
        };
      }
      return {
        exitCode: emit(
          fail(
            'WORKTREE_CONFLICT',
            `worktree at ${worktreePath} has marker for task '${String(parsedMarker.taskId)}', not '${sanitized}'`,
            false,
            {
              worktreePath,
              existingTaskId: String(parsedMarker.taskId),
              requestedTaskId: sanitized,
            },
          ),
          { json: opts.json },
        ),
      };
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            'MARKER_UNREADABLE',
            `existing marker at ${markerPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
          { json: opts.json },
        ),
      };
    }
  }

  // Path-exists-but-no-marker → a stale or manually-created worktree dir.
  // Refuse rather than risk overwriting; user must `git worktree remove` or
  // `rm -rf` first.
  if (existsSync(worktreePath)) {
    return {
      exitCode: emit(
        fail(
          'WORKTREE_CONFLICT',
          `${worktreePath} exists but has no forge marker — refusing to overwrite`,
          false,
          { worktreePath, requestedTaskId: sanitized },
        ),
        { json: opts.json },
      ),
    };
  }

  // Create the .forge/worktrees/ container if missing. workspace.create()
  // requires its `root` to already exist (it operates relative to it but
  // doesn't bootstrap it). This is the responsibility of the verb so that
  // fresh adopters don't see a confusing NOT_FOUND error on first dispatch.
  try {
    mkdirSync(worktreeRoot, { recursive: true });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to create worktree root ${worktreeRoot}: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }

  // Create via the shared workspace primitive. Defaults: branch=feat/<id>,
  // base=origin/main, copyMeta=true (hydrates spec/, plans/, learnings/, etc.).
  let createResult;
  try {
    createResult = await create(sanitized, {
      root: worktreeRoot,
      ...(opts.branch ? { branch: opts.branch } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      copyMeta: true,
      mainWorktree: repoRoot,
    });
  } catch (err) {
    const code = err instanceof WorkspaceError ? err.code : 'IO_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: emit(fail(code, message, /* retriable */ false), { json: opts.json }),
    };
  }

  return {
    exitCode: emit(
      ok({
        worktree_path: createResult.path,
        branch: createResult.branch,
        created: true,
        hydrated: createResult.copiedFiles,
        marker_path: createResult.taskMarkerPath,
      }),
      { json: opts.json },
    ),
  };
}

export const ensureWorktreeHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Idempotently create + hydrate a worktree at .forge/worktrees/<task_id>/.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const branch = parseFlag(rest, 'branch');
    const base = parseFlag(rest, 'base');
    const repoRoot = parseFlag(rest, 'repo-root');
    const json = hasFlag(rest, 'json');
    return runOrchestrateEnsureWorktree({
      taskId,
      forgeDir,
      json,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      ...(repoRoot ? { repoRoot } : {}),
    });
  },
};
