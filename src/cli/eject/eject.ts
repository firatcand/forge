// FORGE-158: `forge eject` — reversible clean uninstall of forge from a project.
//
// Reverses everything forge wrote (recorded in .forge/manifest.json):
//   - strip the forge-managed marker block from each agent root file
//     (CLAUDE.md / AGENTS.md / GEMINI.md), preserving user content byte-for-byte;
//     delete the file outright if forge created it.
//   - reverse the .gitignore block + the .eslintignore/.prettierignore lines.
//   - remove the host skill/agent farm entries forge materialized.
//   - remove the .forge/ directory wholesale.
//
// Safety: dry-run by default (must pass confirm); refuses if active work exists
// (a worktree or a non-terminal task state) or if a forge-managed tracked file
// is dirty in git; takes a restorable backup snapshot before any deletion.
//
// Reversal is driven by the manifest, NOT by re-enumerating the current package,
// so version-drift orphans and Windows copy-mode farm entries are handled. When
// no manifest exists (a project that predates FORGE-158), a best-effort legacy
// fallback runs with a loud warning.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execaSync } from 'execa';
import { writeAtomic } from '../../core/fs-atomic.ts';
import {
  ForgeManifestSchema,
  TaskStateSchema,
  type ForgeManifest,
} from '../../schemas/index.ts';
import {
  bodyWithoutPrefixBlock,
  removeGitignoreBlock,
} from '../upgrade/index.ts';
import {
  MANIFEST_RELPATH,
  readManifest,
  readEnabledHostsFromSettings,
} from '../manifest.ts';
import { ROOT_FILE_BY_AGENT } from '../upgrade/index.ts';

// Task states that mean "this task is still live" — eject refuses while any
// exists. Everything NOT in this set (shipped/cancelled/failed/abandoned/
// unclaimed) is inert and safe to remove.
const BLOCKING_TASK_STATES = new Set([
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
  'ready_for_review',
  'reviewed',
]);

const BACKUP_MARKER = '.forge-eject-backup.json';

export interface EjectOptions {
  readonly cwd: string;
  /** Apply the eject. Without it, eject is a dry-run plan. */
  readonly confirm?: boolean;
  /** Skip the backup snapshot (advanced — no rollback). */
  readonly noBackup?: boolean;
  /** Restore a prior eject from its backup directory instead of ejecting. */
  readonly restore?: string;
}

export interface EjectPlanItem {
  readonly action: 'delete-file' | 'strip-block' | 'remove-line' | 'remove-farm' | 'remove-dir';
  readonly path: string;
}

export interface EjectResult {
  readonly exitCode: number;
  readonly mode: 'dry-run' | 'applied' | 'restored' | 'noop' | 'refused';
  readonly planned: readonly EjectPlanItem[];
  readonly backupDir?: string;
  readonly stderr: string;
  readonly warnings: readonly string[];
}

export function eject(opts: EjectOptions): EjectResult {
  if (opts.restore !== undefined) return restore(opts.cwd, opts.restore);

  const cwd = opts.cwd;
  const forgeDir = resolve(cwd, '.forge');
  const warnings: string[] = [];

  if (!existsSync(forgeDir)) {
    return {
      exitCode: 0,
      mode: 'noop',
      planned: [],
      stderr: 'forge eject: no .forge/ directory — nothing to eject.',
      warnings,
    };
  }

  // 1. Manifest (or legacy fallback).
  let manifest = readManifest(cwd);
  if (!manifest) {
    manifest = deriveLegacyManifest(cwd);
    warnings.push(
      'No .forge/manifest.json found — running in derived (legacy) mode. ' +
        'Byte-equal reversal is not guaranteed for ignore files or copy-mode farm entries.',
    );
  }

  // 2. Active-work guard.
  const refusal = guard(cwd, forgeDir, manifest);
  if (refusal) {
    return { exitCode: 1, mode: 'refused', planned: [], stderr: refusal, warnings };
  }

  // 3. Plan.
  const plan = computePlan(cwd, manifest);

  // 4. Dry-run (default).
  if (!opts.confirm) {
    return { exitCode: 0, mode: 'dry-run', planned: plan, stderr: '', warnings };
  }

  // 5. Apply.
  let backupDir: string | undefined;
  if (!opts.noBackup) {
    backupDir = createBackup(cwd, manifest, plan);
  } else {
    warnings.push('--no-backup: no rollback snapshot was taken.');
  }

  // 5b. Re-check the guard immediately before mutating (TOCTOU): the only thing
  //     touched so far is the backup, which is non-destructive.
  const raceRefusal = guard(cwd, forgeDir, manifest);
  if (raceRefusal) {
    return {
      exitCode: 1,
      mode: 'refused',
      planned: plan,
      ...(backupDir ? { backupDir } : {}),
      stderr: `forge eject: active work appeared during eject — aborted before any deletion.\n${raceRefusal}`,
      warnings,
    };
  }

  applyPlan(cwd, manifest, plan);
  // Remove .forge/ wholesale last (covers CONTEXT.md, .version, settings.yaml,
  // orchestrator/, logs/, manifest.json — everything forge owns under .forge/).
  rmSync(forgeDir, { recursive: true, force: true });

  return {
    exitCode: 0,
    mode: 'applied',
    planned: plan,
    ...(backupDir ? { backupDir } : {}),
    stderr: '',
    warnings,
  };
}

// --- guard ------------------------------------------------------------------

function guard(cwd: string, forgeDir: string, manifest: ForgeManifest): string | null {
  // Path containment: a corrupted or hand-edited manifest must never drive a
  // delete outside the project (Codex impl #2). Refuse loudly on any escaping
  // path rather than silently skipping — escaping paths signal tampering.
  const escaping = [
    ...manifest.rootFiles.map((r) => r.path),
    ...manifest.ignoreFiles.map((i) => i.path),
    ...manifest.farmEntries.map((f) => f.path),
  ].filter((rel) => within(cwd, rel) === null);
  if (escaping.length > 0) {
    return [
      'forge eject: refusing — .forge/manifest.json references paths outside the project:',
      ...escaping.map((p) => `  - ${p}`),
      'The manifest appears corrupted or edited. Remove it and re-run (eject will fall back to derived mode).',
    ].join('\n');
  }

  // Active worktrees.
  const worktreesDir = join(forgeDir, 'worktrees');
  if (existsSync(worktreesDir)) {
    const entries = readdirSync(worktreesDir).filter((e) => !e.startsWith('.'));
    if (entries.length > 0) {
      return [
        'forge eject: refusing — active worktrees exist under .forge/worktrees/:',
        ...entries.map((e) => `  - ${e}`),
        'Finish or remove them first (e.g. `git worktree remove .forge/worktrees/<id>`).',
      ].join('\n');
    }
  }

  // Non-terminal task state. Fail SAFE (Codex impl #3): a state.json that is
  // unreadable, malformed, or a future schema version is treated as possibly
  // active — we cannot prove it's inert, so we block rather than risk deleting
  // .forge/ over live work.
  const tasksDir = join(forgeDir, 'orchestrator', 'tasks');
  const active: string[] = [];
  if (existsSync(tasksDir)) {
    for (const entry of readdirSync(tasksDir)) {
      const statePath = join(tasksDir, entry, 'state.json');
      if (!existsSync(statePath)) continue;
      let parsedState: string | null = null;
      try {
        const parsed = TaskStateSchema.safeParse(JSON.parse(readFileSync(statePath, 'utf8')));
        if (!parsed.success) {
          active.push(`${entry} (unrecognized state.json — schema mismatch?)`);
          continue;
        }
        parsedState = parsed.data.state;
      } catch {
        active.push(`${entry} (unreadable state.json)`);
        continue;
      }
      if (BLOCKING_TASK_STATES.has(parsedState)) {
        active.push(`${entry} (${parsedState})`);
      }
    }
  }
  if (active.length > 0) {
    return [
      'forge eject: refusing — tasks may still be active:',
      ...active.map((a) => `  - ${a}`),
      'Ship or cancel them first (`forge orchestrate complete` / `cancel`),',
      'or remove a stale/corrupt .forge/orchestrator/tasks/<id>/ directory.',
    ].join('\n');
  }

  // Dirty forge-managed tracked files.
  const dirty = dirtyForgeFiles(cwd, manifest);
  if (dirty.length > 0) {
    return [
      'forge eject: refusing — forge-managed files have uncommitted changes:',
      ...dirty.map((d) => `  - ${d}`),
      'Commit or discard them first so the backup is a faithful rollback point.',
    ].join('\n');
  }

  return null;
}

/** git-tracked forge-managed files (root files, ignore files, settings.yaml). */
function dirtyForgeFiles(cwd: string, manifest: ForgeManifest): string[] {
  const candidates = [
    ...manifest.rootFiles.map((r) => r.path),
    ...manifest.ignoreFiles.map((i) => i.path),
    '.forge/settings.yaml',
  ].filter((p) => existsSync(resolve(cwd, p)));
  if (candidates.length === 0) return [];

  try {
    const res = execaSync('git', ['status', '--porcelain', '--', ...candidates], {
      cwd,
      reject: false,
    });
    // Not a git repo (or git absent) → nothing to guard against.
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^\S+\s+/, ''));
  } catch {
    return [];
  }
}

// --- plan -------------------------------------------------------------------

function computePlan(cwd: string, manifest: ForgeManifest): EjectPlanItem[] {
  const plan: EjectPlanItem[] = [];

  for (const rf of manifest.rootFiles) {
    const p = within(cwd, rf.path);
    if (!p || !existsSync(p)) continue;
    plan.push({ action: rf.forgeCreated ? 'delete-file' : 'strip-block', path: rf.path });
  }
  for (const ig of manifest.ignoreFiles) {
    const p = within(cwd, ig.path);
    if (!p || !existsSync(p)) continue;
    plan.push({
      action: ig.created ? 'delete-file' : ig.kind === 'block' ? 'strip-block' : 'remove-line',
      path: ig.path,
    });
  }
  for (const fe of manifest.farmEntries) {
    const p = within(cwd, fe.path);
    if (!p || !pathPresent(p)) continue;
    plan.push({ action: 'remove-farm', path: fe.path });
  }
  plan.push({ action: 'remove-dir', path: '.forge' });
  return plan;
}

// --- apply ------------------------------------------------------------------

function applyPlan(cwd: string, manifest: ForgeManifest, _plan: readonly EjectPlanItem[]): void {
  // Root files.
  for (const rf of manifest.rootFiles) {
    const p = within(cwd, rf.path);
    if (!p || !existsSync(p)) continue;
    if (rf.forgeCreated) {
      unlinkSync(p);
      continue;
    }
    // forge only STAMPED a marker onto a pre-existing user file — strip the
    // block and keep the file even if the residual is empty (it's the user's
    // file; deleting it would be data loss — Codex impl #1).
    writeAtomic(p, bodyWithoutPrefixBlock(readFileSync(p, 'utf8')));
  }

  // Ignore files.
  for (const ig of manifest.ignoreFiles) {
    const p = within(cwd, ig.path);
    if (!p || !existsSync(p)) continue;
    if (ig.created) {
      unlinkSync(p);
      continue;
    }
    // Pre-existing user file — reverse forge's modification, never delete.
    const before = readFileSync(p, 'utf8');
    const after =
      ig.kind === 'block'
        ? removeGitignoreBlock(before, { priorEndedWithNewline: ig.priorEndedWithNewline })
        : removeAppendedLine(before, ig.line ?? '', ig.priorEndedWithNewline);
    writeAtomic(p, after);
  }

  // Farm entries (manifest-recorded — covers symlink + copy modes).
  const farmParents = new Set<string>();
  for (const fe of manifest.farmEntries) {
    const p = within(cwd, fe.path);
    if (!p || !pathPresent(p)) continue;
    // For symlink mode, only remove if it's still a symlink (a user replacement
    // with a real file at the same path is left alone).
    if (fe.mode === 'symlink' && !isSymlink(p)) continue;
    rmSync(p, { recursive: true, force: true });
    farmParents.add(dirname(p));
  }
  // Remove farm parent dirs (.claude/skills, etc.) and their host roots if empty.
  for (const parent of farmParents) {
    removeEmptyDirsUp(parent, cwd);
  }
}

// Inverse of appendLineIfMissing: forge appended `${sep}${line}\n` where
// sep = priorEndedWithNewline ? '' : '\n'. Restore the prior content exactly
// when the file still ends with that suffix; otherwise remove the exact line.
function removeAppendedLine(contents: string, line: string, priorEndedWithNewline: boolean): string {
  if (line.length === 0) return contents;
  const sep = priorEndedWithNewline ? '' : '\n';
  const appended = `${sep}${line}\n`;
  if (contents.endsWith(appended)) {
    return contents.slice(0, contents.length - appended.length);
  }
  const lines = contents.split('\n');
  const idx = lines.lastIndexOf(line);
  if (idx !== -1) lines.splice(idx, 1);
  return lines.join('\n');
}

// --- backup + restore -------------------------------------------------------

function createBackup(cwd: string, manifest: ForgeManifest, plan: readonly EjectPlanItem[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = resolve(cwd, `.forge.eject-backup-${stamp}`);
  let n = 1;
  while (existsSync(dir)) dir = resolve(cwd, `.forge.eject-backup-${stamp}-${n++}`);
  mkdirSync(dir, { recursive: true });

  // Back up every path the plan touches, preserving relative layout + symlinks.
  const paths = new Set<string>(plan.map((p) => p.path));
  for (const rel of paths) {
    copyPreservingLinks(resolve(cwd, rel), resolve(dir, rel));
  }

  writeFileSync(
    resolve(dir, BACKUP_MARKER),
    `${JSON.stringify({ version: 1, ejectedAt: new Date().toISOString(), manifest }, null, 2)}\n`,
  );
  return dir;
}

function restore(cwd: string, backupArg: string): EjectResult {
  const dir = resolve(cwd, backupArg);
  const markerPath = resolve(dir, BACKUP_MARKER);
  const warnings: string[] = [];

  if (!existsSync(markerPath)) {
    return {
      exitCode: 1,
      mode: 'refused',
      planned: [],
      stderr: `forge eject --restore: '${backupArg}' is not a forge eject backup (no ${BACKUP_MARKER}).`,
      warnings,
    };
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { ejectedAt?: string; manifest?: unknown };
    if (!ForgeManifestSchema.safeParse(marker.manifest).success) {
      warnings.push('Backup manifest failed validation — restoring files as-is.');
    }
    if (marker.ejectedAt) {
      const ageMs = Date.now() - new Date(marker.ejectedAt).getTime();
      const ageDays = ageMs / 86_400_000;
      if (ageDays > 7) {
        warnings.push(`Backup is ${Math.floor(ageDays)} days old (> 7) — restoring anyway.`);
      }
    }
  } catch {
    warnings.push('Could not read backup marker metadata — restoring files as-is.');
  }

  const restored: EjectPlanItem[] = [];
  for (const rel of topLevelEntries(dir)) {
    if (rel === BACKUP_MARKER) continue;
    copyPreservingLinks(resolve(dir, rel), resolve(cwd, rel));
    restored.push({ action: 'delete-file', path: rel });
  }

  return {
    exitCode: 0,
    mode: 'restored',
    planned: restored,
    backupDir: dir,
    stderr: '',
    warnings,
  };
}

// --- fs helpers -------------------------------------------------------------

/** Resolve `rel` under `cwd`, returning the absolute path only if it stays
 * strictly inside the project (never cwd itself). null = escapes / is cwd. */
function within(cwd: string, rel: string): string | null {
  const root = resolve(cwd);
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) ? abs : null;
}

/** Like existsSync but true for broken symlinks too (lstat, not stat). */
function pathPresent(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Copy a file/dir/symlink to dest, recreating symlinks as symlinks. */
function copyPreservingLinks(src: string, dest: string): void {
  if (!pathPresent(src)) return;
  const st = lstatSync(src);
  mkdirSync(dirname(dest), { recursive: true });
  if (st.isSymbolicLink()) {
    if (pathPresent(dest)) rmSync(dest, { recursive: true, force: true });
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  cpSync(src, dest, { recursive: true, force: true });
}

/** Top-level relative entries of a directory. */
function topLevelEntries(dir: string): string[] {
  return readdirSync(dir);
}

/** Remove `dir` and its ancestors up to (not including) `stopAt` while empty.
 * Uses rmdirSync, which removes an empty dir and throws ENOTEMPTY otherwise —
 * so a non-empty ancestor (e.g. a .claude/ holding user-owned content) stops the
 * walk. (rmSync without recursive:true refuses to remove directories at all.) */
function removeEmptyDirsUp(dir: string, stopAt: string): void {
  let current = dir;
  const stop = resolve(stopAt);
  while (current.startsWith(stop) && current !== stop) {
    try {
      rmdirSync(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

// --- legacy fallback --------------------------------------------------------

// Derive a best-effort manifest for projects that predate FORGE-158. ignoreFiles
// is intentionally left EMPTY: we cannot prove forge created .gitignore or know
// the prior newline state, and guessing risks deleting a user's file. The
// .forge/ dir, root file blocks, and farm entries are still reversible via
// settings + provenance, so eject stays useful.
function deriveLegacyManifest(cwd: string): ForgeManifest {
  const hosts = readEnabledHostsFromSettings(cwd);
  return {
    version: 1,
    forgeVersion: 'unknown',
    enabledHosts: hosts,
    // Strip the marker block but never delete — we can't prove forge created them.
    rootFiles: hosts
      .map((h) => ROOT_FILE_BY_AGENT[h])
      .filter((p) => existsSync(resolve(cwd, p)))
      .map((path) => ({ path, forgeCreated: false })),
    ignoreFiles: [],
    farmEntries: legacyFarmEntries(cwd, hosts),
    staticPaths: [],
  };
}

const LEGACY_FARM_DIRS = ['skills', 'agents'] as const;
const HOST_PREFIX: Record<string, string> = { claude: '.claude', codex: '.codex', gemini: '.gemini' };

// Enumerate existing farm entries by walking the host dirs and recording any
// symlink (provenance can't be re-checked without the package, so we record
// symlinks only — never a user's real file).
function legacyFarmEntries(cwd: string, hosts: readonly string[]): ForgeManifest['farmEntries'] {
  const out: ForgeManifest['farmEntries'] = [];
  for (const host of hosts) {
    const prefix = HOST_PREFIX[host];
    if (!prefix) continue;
    for (const sub of LEGACY_FARM_DIRS) {
      const farmDir = resolve(cwd, prefix, sub);
      if (!existsSync(farmDir)) continue;
      for (const name of readdirSync(farmDir)) {
        const p = resolve(farmDir, name);
        if (isSymlink(p)) {
          out.push({ path: relative(cwd, p), mode: 'symlink' });
        }
      }
    }
  }
  return out;
}
