import { execa, ExecaError } from 'execa';
import { existsSync, mkdirSync, realpathSync, statSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { WorkspaceError } from './errors.ts';

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
      return { resolvedRoot: real, tail: tailParts.length ? path.join(...tailParts.reverse()) : '' };
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
        const st = statSync(dotGit);
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

interface CopyPlanItem {
  source: string;
  destination: string;
  relative: string;
}

function planCopyRecursive(srcRoot: string, destRoot: string, relativeBase: string): CopyPlanItem[] {
  const items: CopyPlanItem[] = [];
  if (!existsSync(srcRoot)) return items;
  const entries = readdirSync(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.gitkeep') continue;
    const srcPath = path.join(srcRoot, entry.name);
    const destPath = path.join(destRoot, entry.name);
    const rel = path.join(relativeBase, entry.name);
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
  const entries = readdirSync(specSrc, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === '.gitkeep') continue;
    if (!entry.name.endsWith('.md')) continue;
    items.push({
      source: path.join(specSrc, entry.name),
      destination: path.join(destRoot, 'spec', entry.name),
      relative: path.join('spec', entry.name),
    });
  }
  return items;
}

function planSingleFile(srcRoot: string, destRoot: string, name: string): CopyPlanItem[] {
  const src = path.join(srcRoot, name);
  if (!existsSync(src)) return [];
  try {
    const st = statSync(src);
    if (!st.isFile()) return [];
  } catch {
    return [];
  }
  return [{ source: src, destination: path.join(destRoot, name), relative: name }];
}

function planForgeSettings(srcRoot: string, destRoot: string): CopyPlanItem[] {
  const rel = path.join('.forge', 'settings.yaml');
  const src = path.join(srcRoot, rel);
  if (!existsSync(src)) return [];
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
}

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
    const cause = err as ExecaError;
    throw new WorkspaceError(
      'GIT_FAILURE',
      `git worktree add failed: ${cause.shortMessage ?? cause.message}`,
      {
        branch,
        target,
        base,
        stderr: typeof cause.stderr === 'string' ? cause.stderr : undefined,
        exitCode: cause.exitCode,
      },
      { cause: err },
    );
  }

  const copyMeta = opts.copyMeta !== false;
  let copiedFiles: string[] = [];
  let manifestPath: string | null = null;

  if (copyMeta) {
    const mainWorktree =
      opts.mainWorktree !== undefined ? path.resolve(opts.mainWorktree) : findMainWorktree(absRoot);
    if (mainWorktree && existsSync(mainWorktree)) {
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
  }

  return { path: target, branch, copiedFiles, manifestPath };
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
    const cause = err as ExecaError;
    throw new WorkspaceError(
      'GIT_FAILURE',
      `git ls-files failed: ${cause.shortMessage ?? cause.message}`,
      {
        target,
        stderr: typeof cause.stderr === 'string' ? cause.stderr : undefined,
        exitCode: cause.exitCode,
      },
      { cause: err },
    );
  }

  const count = ignoredFiles.length;
  if (count > 0 && opts.force !== true) {
    throw new WorkspaceError('GITIGNORED_LOSS', `${count} gitignored file(s) would be lost`, {
      count,
      files: ignoredFiles.slice(0, 10),
    });
  }

  const removeArgs = ['worktree', 'remove', target];
  if (opts.force === true) removeArgs.splice(2, 0, '--force');

  try {
    await execa('git', removeArgs, { cwd: absRoot, reject: true });
  } catch (err) {
    const cause = err as ExecaError;
    throw new WorkspaceError(
      'GIT_FAILURE',
      `git worktree remove failed: ${cause.shortMessage ?? cause.message}`,
      {
        target,
        stderr: typeof cause.stderr === 'string' ? cause.stderr : undefined,
        exitCode: cause.exitCode,
      },
      { cause: err },
    );
  }

  let branchDeleted = false;
  if (opts.deleteBranch) {
    const branch = opts.branch ?? `feat/${sanitized}`;
    try {
      await execa('git', ['branch', '-D', branch], { cwd: absRoot, reject: true });
      branchDeleted = true;
    } catch (err) {
      const cause = err as ExecaError;
      throw new WorkspaceError(
        'GIT_FAILURE',
        `git branch -D failed: ${cause.shortMessage ?? cause.message}`,
        {
          branch,
          stderr: typeof cause.stderr === 'string' ? cause.stderr : undefined,
          exitCode: cause.exitCode,
        },
        { cause: err },
      );
    }
  }

  return { removed: true, gitignoredFilesLost: count, branchDeleted };
}
