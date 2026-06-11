import { execa, ExecaError } from 'execa';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';

import { WorkspaceError } from './errors.ts';
import { TASK_ID_RE, TASK_ID_MAX_LEN } from '../schemas/task-id.ts';

function wrapExecaError(
  op: string,
  err: unknown,
  details: Record<string, unknown>,
): WorkspaceError {
  const cause = err as ExecaError;
  return new WorkspaceError(
    'GIT_FAILURE',
    `${op} failed: ${cause.shortMessage ?? cause.message}`,
    {
      ...details,
      stderr: typeof cause.stderr === 'string' ? cause.stderr : undefined,
      exitCode: cause.exitCode,
    },
    { cause: err },
  );
}

// Length + charset come from the unified task-id primitive (FORGE-130,
// src/schemas/task-id.ts). sanitizeIssueId WRAPS that primitive: it preserves
// its granular WorkspaceError codes (EMPTY / TOO_LONG / CONTROL_CHAR /
// PATH_TRAVERSAL / LEADING_DASH / INVALID_CHAR) by running the structural
// checks individually before the final charset test, rather than collapsing to
// a single boolean. NARROWING vs the prior ALLOWED_PATTERN `/^[A-Za-z0-9._-]+$/`:
// the unified shape requires a leading alphanumeric, so a leading `.` (e.g.
// `.foo`) now fails the INVALID_CHAR charset check. No worktree dir name or
// fixture relied on a leading dot (all task ids start alnum). See
// test/unit/workspace.test.ts for the documented-narrowing regression.
const MAX_ID_LENGTH = TASK_ID_MAX_LEN;
const ALLOWED_PATTERN = TASK_ID_RE;

export function sanitizeIssueId(id: unknown): string {
  if (typeof id !== 'string') {
    throw new WorkspaceError('EMPTY', 'issue id must be a string', { input: id });
  }
  if (id.length === 0) {
    throw new WorkspaceError('EMPTY', 'issue id is empty', { input: id });
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new WorkspaceError('TOO_LONG', `issue id exceeds ${MAX_ID_LENGTH} chars`, {
      input: id,
      length: id.length,
      max: MAX_ID_LENGTH,
    });
  }
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new WorkspaceError('CONTROL_CHAR', 'issue id contains a control character', {
        input: id,
        index: i,
        codepoint: code,
      });
    }
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new WorkspaceError('PATH_TRAVERSAL', 'issue id contains path separators or traversal sequence', {
      input: id,
    });
  }
  if (id.startsWith('-')) {
    throw new WorkspaceError('LEADING_DASH', 'issue id must not start with a dash', { input: id });
  }
  if (!ALLOWED_PATTERN.test(id)) {
    throw new WorkspaceError('INVALID_CHAR', 'issue id must start with [A-Za-z0-9] and contain only [A-Za-z0-9._-]', {
      input: id,
    });
  }
  return id;
}

function resolveLongestExistingPrefix(target: string): { resolvedRoot: string; tail: string } {
  let current = target;
  const tailParts: string[] = [];
  while (true) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      const reversedTail = [...tailParts].reverse();
      return { resolvedRoot: real, tail: reversedTail.length ? path.join(...reversedTail) : '' };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceError('NOT_FOUND', 'no existing ancestor found for target', { target });
    }
    tailParts.push(path.basename(current));
    current = parent;
  }
}

export function validateUnderRoot(target: string, root: string): string {
  const absRoot = path.resolve(root);
  if (!existsSync(absRoot)) {
    throw new WorkspaceError('NOT_FOUND', 'root does not exist', { root, resolved: absRoot });
  }
  const resolvedRoot = realpathSync(absRoot);

  const absTarget = path.resolve(target);
  let resolvedTarget: string;
  if (existsSync(absTarget)) {
    resolvedTarget = realpathSync(absTarget);
  } else {
    const { resolvedRoot: existingPrefix, tail } = resolveLongestExistingPrefix(absTarget);
    resolvedTarget = tail ? path.join(existingPrefix, tail) : existingPrefix;
  }

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new WorkspaceError('PATH_ESCAPE', 'target resolves outside of root', {
      root: resolvedRoot,
      target: resolvedTarget,
    });
  }
  return resolvedTarget;
}

function findMainWorktree(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    const dotGit = path.join(current, '.git');
    if (existsSync(dotGit)) {
      try {
        const st = lstatSync(dotGit);
        if (st.isDirectory()) return current;
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function rejectIfSymlink(source: string): void {
  const st = lstatSync(source);
  if (st.isSymbolicLink()) {
    // reject symlinks defensively — main worktree could contain a hostile symlink (e.g. CLAUDE.md -> /etc/passwd)
    let target: string | undefined;
    try {
      target = readlinkSync(source);
    } catch {
      target = undefined;
    }
    throw new WorkspaceError('SYMLINK_REJECTED', 'refusing to follow symlink in main worktree', {
      path: source,
      target,
    });
  }
}

interface CopyPlanItem {
  source: string;
  destination: string;
  relative: string;
}

// FORGE-142 — a git submodule is a directory whose `.git` is a FILE (a
// `gitdir:` pointer), not a directory (only the superproject's top-level `.git`
// is a dir, or a `.git` worktree pointer file at the worktree root). Hydration
// must NOT recurse into a submodule: its working tree belongs to a separate git
// object store, and copying its `.git` pointer + files into the new worktree
// produces a broken, mis-located submodule checkout. The presence of a
// `.gitmodules` registration is the superproject-side signal, but the robust
// per-directory test at walk time is: does this directory contain a `.git`
// entry at all? A nested `.git` (file OR dir) marks a git boundary we must not
// cross during a plain file-copy hydration.
function isGitBoundaryDir(dir: string): boolean {
  const dotGit = path.join(dir, '.git');
  try {
    // lstat so a symlinked `.git` is detected too (and not followed).
    lstatSync(dotGit);
    return true;
  } catch {
    return false;
  }
}

function planCopyRecursive(srcRoot: string, destRoot: string, relativeBase: string): CopyPlanItem[] {
  const items: CopyPlanItem[] = [];
  if (!existsSync(srcRoot)) return items;
  // guard the directory root itself — a hostile symlinked dir (e.g. plans -> /etc) must not be traversed
  const rootStat = lstatSync(srcRoot);
  // A submodule mounted directly AT a hydration root must not be hydrated —
  // the child-dir boundary check below never sees the root itself (Codex
  // batch-1 review).
  if (rootStat.isDirectory() && isGitBoundaryDir(srcRoot)) return items;
  if (rootStat.isSymbolicLink()) {
    rejectIfSymlink(srcRoot);
  }
  if (!rootStat.isDirectory()) return items;
  const entries = readdirSync(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue;
    const srcPath = path.join(srcRoot, entry.name);
    const destPath = path.join(destRoot, entry.name);
    const rel = path.join(relativeBase, entry.name);
    if (entry.isSymbolicLink()) {
      rejectIfSymlink(srcPath);
    }
    if (entry.isDirectory()) {
      // FORGE-142 — never recurse into a git submodule (or any nested git
      // boundary). Skip the whole directory rather than copying a broken
      // `.git` pointer + the submodule's working tree.
      if (isGitBoundaryDir(srcPath)) continue;
      items.push(...planCopyRecursive(srcPath, destPath, rel));
    } else if (entry.isFile()) {
      items.push({ source: srcPath, destination: destPath, relative: rel });
    }
  }
  return items;
}

function planSpecMarkdownCopy(srcRoot: string, destRoot: string): CopyPlanItem[] {
  const items: CopyPlanItem[] = [];
  const specSrc = path.join(srcRoot, 'spec');
  if (!existsSync(specSrc)) return items;
  const specStat = lstatSync(specSrc);
  if (specStat.isSymbolicLink()) {
    rejectIfSymlink(specSrc);
  }
  if (!specStat.isDirectory()) return items;
  const entries = readdirSync(specSrc, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue;
    if (!entry.name.endsWith('.md')) continue;
    const srcPath = path.join(specSrc, entry.name);
    if (entry.isSymbolicLink()) {
      rejectIfSymlink(srcPath);
    }
    if (!entry.isFile()) continue;
    items.push({
      source: srcPath,
      destination: path.join(destRoot, 'spec', entry.name),
      relative: path.join('spec', entry.name),
    });
  }
  return items;
}

function planForgeSettings(srcRoot: string, destRoot: string): CopyPlanItem[] {
  const rel = path.join('.forge', 'settings.yaml');
  const src = path.join(srcRoot, rel);
  if (!existsSync(src)) return [];
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return [];
  }
  if (st.isSymbolicLink()) {
    rejectIfSymlink(src);
  }
  if (!st.isFile()) return [];
  return [{ source: src, destination: path.join(destRoot, rel), relative: rel }];
}

function executeCopyPlan(items: CopyPlanItem[]): string[] {
  const copied: string[] = [];
  for (const item of items) {
    mkdirSync(path.dirname(item.destination), { recursive: true });
    copyFileSync(item.source, item.destination);
    copied.push(item.relative);
  }
  return copied;
}

// Returns the set of paths tracked by git in `mainWorktree`, expressed as
// POSIX-style paths relative to the worktree root (the same form `path.join()`
// produces on Linux/macOS — the verb is not yet Windows-portable, see SPEC).
// Used to filter out tracked files from the hydration plan: `git worktree add`
// already places tracked files from `base`, so re-copying them from main's
// working tree creates a HEAD/working-tree divergence whenever `base` and
// local main resolve to different revisions for those files (FORGE-136).
async function getTrackedPaths(mainWorktree: string): Promise<Set<string>> {
  try {
    const { stdout } = await execa('git', ['ls-files'], {
      cwd: mainWorktree,
      reject: true,
    });
    return new Set(stdout.split('\n').filter((line) => line.length > 0));
  } catch (err) {
    throw wrapExecaError('git ls-files', err, { mainWorktree });
  }
}

export interface CreateOptions {
  root: string;
  branch?: string;
  base?: string;
  copyMeta?: boolean;
  mainWorktree?: string;
}

export interface CreateResult {
  path: string;
  branch: string;
  copiedFiles: string[];
  manifestPath: string | null;
  taskMarkerPath: string;
}

export const TASK_MARKER_RELPATH = path.join('.forge', 'worktree-task.json');

export async function create(taskId: string, opts: CreateOptions): Promise<CreateResult> {
  const sanitized = sanitizeIssueId(taskId);
  const absRoot = path.resolve(opts.root);
  if (!existsSync(absRoot)) {
    throw new WorkspaceError('NOT_FOUND', 'root does not exist', { root: opts.root });
  }
  const target = path.join(absRoot, sanitized);
  validateUnderRoot(target, absRoot);

  const branch = opts.branch ?? `feat/${sanitized}`;
  const base = opts.base ?? 'origin/main';

  try {
    await execa('git', ['worktree', 'add', '-b', branch, target, base], {
      cwd: absRoot,
      reject: true,
    });
  } catch (err) {
    throw wrapExecaError('git worktree add', err, { branch, target, base });
  }

  // Task marker — binds this worktree to its task ID for the worktree-guard
  // preflight in /implement, /ship, /qa, etc. Always written, regardless of
  // copyMeta, because the marker IS the binding: skills check for its presence
  // to refuse running task-scoped mutations from the main checkout, which
  // otherwise corrupts parallel sessions sharing the same HEAD.
  const markerDir = path.join(target, '.forge');
  mkdirSync(markerDir, { recursive: true });
  const taskMarkerPath = path.join(target, TASK_MARKER_RELPATH);
  const taskMarker = {
    version: 1,
    taskId: sanitized,
    branch,
    createdAt: new Date().toISOString(),
    createdBy: 'forge/workspace.create',
  };
  writeFileSync(taskMarkerPath, JSON.stringify(taskMarker, null, 2) + '\n', 'utf8');

  const copyMeta = opts.copyMeta ?? true;
  let copiedFiles: string[] = [];
  let manifestPath: string | null = null;

  if (copyMeta) {
    const mainWorktree =
      opts.mainWorktree !== undefined ? path.resolve(opts.mainWorktree) : findMainWorktree(absRoot);
    if (!mainWorktree || !existsSync(mainWorktree)) {
      throw new WorkspaceError('NOT_FOUND', 'main worktree not found for copyMeta', {
        context: 'main worktree not found for copyMeta',
        cwd: absRoot,
      });
    }

    // Hydration covers gitignored project meta only. Tracked files (CLAUDE.md,
    // CRITICAL.md, spec/SPEC.md, plans/phases.yaml, etc.) are placed by
    // `git worktree add` from `base`; copying them again from main's working
    // tree creates a HEAD/working-tree divergence when local main and `base`
    // resolve to different revisions for those files (FORGE-136). The plan
    // walks all hydration roots (so the symlink-rejection defense fires on
    // every candidate), then a `git ls-files` filter drops tracked entries.
    const rawPlan: CopyPlanItem[] = [
      ...planSpecMarkdownCopy(mainWorktree, target),
      ...planCopyRecursive(path.join(mainWorktree, 'plans'), path.join(target, 'plans'), 'plans'),
      ...planCopyRecursive(
        path.join(mainWorktree, 'docs', 'learnings'),
        path.join(target, 'docs', 'learnings'),
        path.join('docs', 'learnings'),
      ),
      ...planForgeSettings(mainWorktree, target),
    ];
    const tracked = await getTrackedPaths(mainWorktree);
    const plan = rawPlan.filter((item) => !tracked.has(item.relative));
    copiedFiles = executeCopyPlan(plan);

    const manifestDir = path.join(target, '.forge');
    mkdirSync(manifestDir, { recursive: true });
    manifestPath = path.join(manifestDir, 'copied-from-main.json');
    const manifest = {
      version: 1,
      sourceMainWorktree: mainWorktree,
      copiedAt: new Date().toISOString(),
      files: copiedFiles,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  return { path: target, branch, copiedFiles, manifestPath, taskMarkerPath };
}

export interface CleanupOptions {
  root: string;
  force?: boolean;
  // Unconditional branch delete via `git branch -D` (force, ignores merge
  // status). Caller-opt-in only — the gc verb never sets this (FORGE-116 delta 6).
  deleteBranch?: boolean;
  // FORGE-139 — safe merged-only branch delete via `git branch -d`. When set
  // (and `deleteBranch` is not), the branch is deleted ONLY if git considers it
  // fully merged; an unmerged branch is RETAINED (reported via
  // branchRetainedReason), never force-deleted. This is the orphan-branch
  // reclaim path for `gc --remove-worktrees --prune-merged-branches`.
  deleteMergedBranch?: boolean;
  branch?: string;
}

export interface CleanupResult {
  removed: boolean;
  gitignoredFilesLost: number;
  branchDeleted: boolean;
  // FORGE-139 — set when deleteMergedBranch was requested but git refused
  // because the branch was not fully merged (branch left in place). Absent when
  // no branch deletion was attempted or the delete succeeded.
  branchRetainedReason?: string;
}

export async function cleanup(taskId: string, opts: CleanupOptions): Promise<CleanupResult> {
  const sanitized = sanitizeIssueId(taskId);
  const absRoot = path.resolve(opts.root);
  if (!existsSync(absRoot)) {
    throw new WorkspaceError('NOT_FOUND', 'root does not exist', { root: opts.root });
  }
  const target = path.join(absRoot, sanitized);
  validateUnderRoot(target, absRoot);

  if (!existsSync(target)) {
    throw new WorkspaceError('NOT_FOUND', 'worktree does not exist', { target });
  }

  let ignoredFiles: string[] = [];
  try {
    const { stdout } = await execa(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard'],
      { cwd: target, reject: true },
    );
    ignoredFiles = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    throw wrapExecaError('git ls-files', err, { target });
  }

  const manifestRel = path.join('.forge', 'copied-from-main.json');
  const manifestAbs = path.join(target, manifestRel);
  const baseline = new Set<string>();
  // Forge-managed binding marker — always written by create(), always allowed to be removed.
  baseline.add(TASK_MARKER_RELPATH);
  if (existsSync(manifestAbs)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestAbs, 'utf8')) as { files?: unknown };
      if (Array.isArray(parsed.files)) {
        for (const f of parsed.files) {
          if (typeof f === 'string') baseline.add(f);
        }
      }
      baseline.add(manifestRel);
    } catch (err) {
      throw new WorkspaceError(
        'GIT_FAILURE',
        'failed to parse copied-from-main.json manifest',
        { manifest: manifestAbs },
        { cause: err },
      );
    }
  }

  const remaining = ignoredFiles.filter((f) => !baseline.has(f));

  const count = remaining.length;
  if (count > 0 && opts.force !== true) {
    throw new WorkspaceError('GITIGNORED_LOSS', `${count} gitignored file(s) would be lost`, {
      count,
      files: remaining.slice(0, 10),
    });
  }

  // Forge-managed baseline files (marker + manifest + copied meta) are safe to delete.
  // Physically remove them so `git worktree remove` sees a clean tree and doesn't
  // refuse with "contains modified or untracked files" — the baseline filter only
  // suppresses the GITIGNORED_LOSS check, not git's own untracked-file check.
  for (const rel of baseline) {
    const abs = path.join(target, rel);
    try {
      rmSync(abs, { force: true });
    } catch {
      // best-effort — if rm fails the subsequent git command will surface the real error
    }
  }

  const removeArgs = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), target];

  try {
    await execa('git', removeArgs, { cwd: absRoot, reject: true });
  } catch (err) {
    throw wrapExecaError('git worktree remove', err, { target });
  }

  let branchDeleted = false;
  let branchRetainedReason: string | undefined;
  const branch = opts.branch ?? `feat/${sanitized}`;
  if (opts.deleteBranch) {
    // Force delete — caller explicitly accepts data loss (`-D`).
    try {
      await execa('git', ['branch', '-D', branch], { cwd: absRoot, reject: true });
      branchDeleted = true;
    } catch (err) {
      throw wrapExecaError('git branch -D', err, { branch });
    }
  } else if (opts.deleteMergedBranch) {
    // FORGE-139 — safe merged-only delete (`-d`). git refuses an unmerged
    // branch; we treat that refusal as RETAIN (not an error), so reclaiming
    // orphaned merged branches never risks losing unmerged work.
    // `--` terminates option parsing — a marker-sourced branch name starting
    // with '-' must be an operand, never an option. Completeness vs git's ref
    // grammar comes from git itself: check-ref-format --branch is the
    // authoritative predicate (covers @{, lone @, trailing dot, .lock, slash
    // edges — Codex batch-1 round 2). Leading '-' is screened first since
    // check-ref-format would read it as an option even with the validator.
    let refSafe = !branch.startsWith('-');
    if (refSafe) {
      try {
        await execa('git', ['check-ref-format', '--branch', branch], { cwd: absRoot, reject: true });
      } catch {
        refSafe = false;
      }
    }
    if (!refSafe) {
      branchRetainedReason = `branch name '${branch}' is not a safe ref; retained`;
    } else try {
      await execa('git', ['branch', '-d', '--', branch], { cwd: absRoot, reject: true });
      branchDeleted = true;
    } catch (err) {
      const cause = err as ExecaError;
      const stderr = typeof cause.stderr === 'string' ? cause.stderr : '';
      if (/not fully merged/i.test(stderr)) {
        branchRetainedReason = `branch '${branch}' is not fully merged; retained (use deleteBranch to force)`;
      } else if (/not found|Cannot delete branch/i.test(stderr)) {
        // Branch already gone (e.g. never created, or deleted elsewhere) — noop.
        branchRetainedReason = `branch '${branch}' not found; nothing to delete`;
      } else {
        throw wrapExecaError('git branch -d', err, { branch });
      }
    }
  }

  return {
    removed: true,
    gitignoredFilesLost: count,
    branchDeleted,
    ...(branchRetainedReason ? { branchRetainedReason } : {}),
  };
}
