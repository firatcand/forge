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

const MAX_ID_LENGTH = 64;
const ALLOWED_PATTERN = /^[A-Za-z0-9._-]+$/;

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
    throw new WorkspaceError('INVALID_CHAR', 'issue id contains characters outside [A-Za-z0-9._-]', {
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

function planCopyRecursive(srcRoot: string, destRoot: string, relativeBase: string): CopyPlanItem[] {
  const items: CopyPlanItem[] = [];
  if (!existsSync(srcRoot)) return items;
  // guard the directory root itself — a hostile symlinked dir (e.g. plans -> /etc) must not be traversed
  const rootStat = lstatSync(srcRoot);
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

function planSingleFile(srcRoot: string, destRoot: string, name: string): CopyPlanItem[] {
  const src = path.join(srcRoot, name);
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
  return [{ source: src, destination: path.join(destRoot, name), relative: name }];
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

    const plan: CopyPlanItem[] = [
      ...planSpecMarkdownCopy(mainWorktree, target),
      ...planCopyRecursive(path.join(mainWorktree, 'plans'), path.join(target, 'plans'), 'plans'),
      ...planCopyRecursive(
        path.join(mainWorktree, 'docs', 'learnings'),
        path.join(target, 'docs', 'learnings'),
        path.join('docs', 'learnings'),
      ),
      ...planSingleFile(mainWorktree, target, 'CLAUDE.md'),
      ...planSingleFile(mainWorktree, target, 'CRITICAL.md'),
      ...planForgeSettings(mainWorktree, target),
    ];
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
  deleteBranch?: boolean;
  branch?: string;
}

export interface CleanupResult {
  removed: boolean;
  gitignoredFilesLost: number;
  branchDeleted: boolean;
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
  if (opts.deleteBranch) {
    const branch = opts.branch ?? `feat/${sanitized}`;
    try {
      await execa('git', ['branch', '-D', branch], { cwd: absRoot, reject: true });
      branchDeleted = true;
    } catch (err) {
      throw wrapExecaError('git branch -D', err, { branch });
    }
  }

  return { removed: true, gitignoredFilesLost: count, branchDeleted };
}
