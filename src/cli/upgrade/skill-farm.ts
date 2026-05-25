// FORGE-156: per-host project-local skill + agent farm.
//
// The npm package ships `skills/<name>/SKILL.md` and `agents/<name>.md` but
// adopters' hosts (Claude Code / Codex CLI / Gemini CLI) don't read them from
// node_modules. Each host has its own convention:
//
//   Claude Code → .claude/skills/<name>/SKILL.md       and .claude/agents/<name>.md
//   Codex CLI   → .codex/skills/<name>/SKILL.md        and .codex/agents/<name>.md
//   Gemini CLI  → .gemini/skills/<name>/SKILL.md       and .gemini/agents/<name>.md
//                 (Gemini agents path inferred from .gemini/skills/ convention;
//                 if Gemini does not honor it, the files are simply ignored.)
//
// This module materializes a per-host farm of pointers (symlinks on POSIX,
// recursive copies on Windows) so all enabled hosts can discover the bundled
// skills + agents in a freshly-initialized project.
//
// Idempotency: replace-if-mismatched. A target that already points at the
// expected source is left alone; a target that doesn't (different path, real
// file/dir, broken link) is backed up with `.bak` and replaced. Per the
// FORGE-156 design ticket — strict-match-bail (FORGE-153 pattern) was rejected
// as too strict for farm refresh; the user can always recover from a `.bak`.
//
// Gitignore: the farm directories are gitignored by the shared block in
// gitignore-block.ts (`/.claude/skills/`, `/.codex/agents/`, etc.) — each
// adopter regenerates via `forge init` or `forge upgrade`.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentKind } from './agent-root-files.ts';

// `symlink` is the happy path; `copy` is the Windows fallback because
// `npm install -g` + symlinks on Windows requires admin/dev-mode. The
// override field lets unit tests pin a mode regardless of host platform.
export type FarmMode = 'symlink' | 'copy';

// Per-host project-local directories. Skills are SKILL.md-bearing directories;
// agents are individual .md files. Both farm types share the per-host root.
const HOST_DIRS: Readonly<Record<AgentKind, { readonly skills: string; readonly agents: string }>> = {
  claude: { skills: '.claude/skills', agents: '.claude/agents' },
  codex: { skills: '.codex/skills', agents: '.codex/agents' },
  gemini: { skills: '.gemini/skills', agents: '.gemini/agents' },
} as const;

export interface SkillFarmOptions {
  /** Project root (the cwd of `forge init` / `forge upgrade`). */
  readonly cwd: string;
  /** Forge package root — contains skills/ and agents/ as bundled in the npm tarball. */
  readonly packageRoot: string;
  /** Hosts to materialize the farm for. Driven by settings.agents.enabled_root_files. */
  readonly enabledAgents: readonly AgentKind[];
  /** Override platform detection — set explicitly in tests, omit in production. */
  readonly mode?: FarmMode;
  /** When true, compute plan without touching disk. */
  readonly dryRun?: boolean;
}

export interface SkillFarmResult {
  /** Targets that didn't exist before — newly written. */
  readonly created: readonly string[];
  /** Targets that existed but pointed/contained something else — backed up + rewritten. */
  readonly refreshed: readonly string[];
  /** Targets already pointing at the expected source — left alone. */
  readonly skipped: readonly string[];
  /** Effective mode (after platform detection if not overridden). */
  readonly mode: FarmMode;
}

/** POSIX → symlink, Windows → copy. Override via opts.mode for tests. */
function detectMode(): FarmMode {
  return process.platform === 'win32' ? 'copy' : 'symlink';
}

/**
 * Resolve a path through any symlinks (e.g. macOS /tmp → /private/tmp) so
 * two callers see the same form. Returns the input unchanged if the path
 * doesn't exist yet — realpath would throw ENOENT, but a freshly-created
 * cwd is still a legitimate target.
 */
function canonicalizeIfExists(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Walk up from this module file looking for package.json. Works in both dev
 * (src/cli/upgrade/skill-farm.ts → repo root, 3 levels up) and in adopters'
 * node_modules (`node_modules/@firatcand/forge/dist/index.cjs` → forge package
 * root, 1 level up). Matches the readPackageVersion() pattern in scaffold.ts.
 */
export function locatePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(here, ...Array(i).fill('..'), 'package.json');
    if (existsSync(candidate)) return dirname(candidate);
  }
  throw new Error(
    'forge skill-farm: could not locate forge package root (no package.json within 5 parents of skill-farm.ts).',
  );
}

interface ApplyArgs {
  readonly src: string;
  readonly dest: string;
  readonly mode: FarmMode;
  readonly dryRun: boolean;
}

type ApplyOutcome = 'created' | 'refreshed' | 'skipped';

/**
 * Replace-if-mismatched. Returns the outcome so caller can bucket counts.
 *
 * Symlink mode: a target that already points at `src` (via relative path
 * resolution) is left alone. A target that exists as a real file/dir, or a
 * symlink with a different target, is renamed to `<dest>.bak` and replaced.
 *
 * Copy mode: cheap idempotency check (existence + mtime) would race the
 * source's mtime when forge is re-installed at the same version, producing
 * spurious refreshes. We default to always-refresh-on-copy and accept the
 * cost — copy mode is the Windows fallback, the bundled tree is < 1 MB, and
 * forge upgrade is run rarely. If this becomes painful, a content hash check
 * can land in a follow-up.
 */
function applyOne(args: ApplyArgs): ApplyOutcome {
  const { src, dest, mode, dryRun } = args;

  // Symlinks use a path RELATIVE to dest's directory — this keeps the link
  // portable if the project root is moved (the relative path still resolves
  // as long as node_modules stays in its conventional location).
  const linkTarget = relative(dirname(dest), src);

  if (existsSync(dest) || isBrokenSymlink(dest)) {
    if (mode === 'symlink') {
      const st = safeLstat(dest);
      if (st && st.isSymbolicLink()) {
        // readlink can throw if the link has been swapped between the lstat
        // and this read — treat as mismatch, replace.
        const current = safeReadlink(dest);
        if (current === linkTarget) return 'skipped';
      }
    }
    // Mismatch — backup then rewrite. A pre-existing `.bak` is removed first
    // so the rename never fails with EEXIST; the user gets the most recent
    // pre-refresh state in `.bak`.
    if (!dryRun) {
      const bak = `${dest}.bak`;
      if (existsSync(bak) || isBrokenSymlink(bak)) rmSync(bak, { recursive: true, force: true });
      renameSync(dest, bak);
    }
    if (!dryRun) writeTarget(src, dest, mode, linkTarget);
    return 'refreshed';
  }

  if (!dryRun) writeTarget(src, dest, mode, linkTarget);
  return 'created';
}

function writeTarget(src: string, dest: string, mode: FarmMode, linkTarget: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (mode === 'symlink') {
    // Type matters on Windows ('dir' vs 'file') and is ignored on POSIX;
    // pass it correctly for cross-platform safety even though Windows uses
    // the copy branch in production.
    const srcStat = statSync(src);
    symlinkSync(linkTarget, dest, srcStat.isDirectory() ? 'dir' : 'file');
    return;
  }
  copyRecursive(src, dest);
}

function copyRecursive(src: string, dest: string): void {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(resolve(src, entry), resolve(dest, entry));
    }
    return;
  }
  copyFileSync(src, dest);
}

/** lstat without throwing on ENOENT — returns null instead. */
function safeLstat(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** readlink without throwing — returns null on any failure. */
function safeReadlink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * `existsSync` returns false for broken symlinks (it follows the link). We
 * still need to detect them so the backup step doesn't try to rename a
 * non-existent file. lstat sees the link without following it.
 */
function isBrokenSymlink(p: string): boolean {
  const st = safeLstat(p);
  return !!st && st.isSymbolicLink() && !existsSync(p);
}

/**
 * Enumerate bundled skill directories — only those containing a `SKILL.md`.
 * The forge package ships internal helper directories under `skills/` (e.g.
 * `skills/_shared/` referenced by other SKILL.md files via @import) that are
 * NOT themselves skills. Without the SKILL.md filter, those internal dirs
 * leak into adopter farms and show up as invalid skills in every host
 * (Codex review).
 */
function listBundledSkills(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot).filter((name) => {
    const full = resolve(skillsRoot, name);
    try {
      return statSync(full).isDirectory() && existsSync(resolve(full, 'SKILL.md'));
    } catch {
      return false;
    }
  });
}

/** Enumerate bundled agent files (every `.md` under `agents/`). */
function listBundledAgents(agentsRoot: string): string[] {
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot).filter((name) => {
    const full = resolve(agentsRoot, name);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Materialize the skill + agent farm for each enabled host. Idempotent:
 * existing-and-correct links are left alone; mismatched entries are backed
 * up to `.bak` and rewritten.
 */
export function applySkillFarm(opts: SkillFarmOptions): SkillFarmResult {
  const mode = opts.mode ?? detectMode();
  const dryRun = opts.dryRun ?? false;
  const created: string[] = [];
  const refreshed: string[] = [];
  const skipped: string[] = [];

  // Canonicalize cwd and packageRoot — on macOS, /tmp is a symlink to
  // /private/tmp, so `mkdtemp` returns one form but a child process
  // running `process.cwd()` may resolve to the other. If the two callers
  // (e.g. test bootstrap vs upgrade subprocess) disagree on the path
  // form, the `relative(dirname(dest), src)` we store in the symlink
  // ends up with a different `..` count, breaking idempotency.
  // realpathSync() collapses both to the canonical form.
  const cwd = canonicalizeIfExists(opts.cwd);
  const packageRoot = canonicalizeIfExists(opts.packageRoot);

  const skillsRoot = resolve(packageRoot, 'skills');
  const agentsRoot = resolve(packageRoot, 'agents');

  const skillNames = listBundledSkills(skillsRoot);
  const agentFiles = listBundledAgents(agentsRoot);

  for (const agent of opts.enabledAgents) {
    const hostDirs = HOST_DIRS[agent];

    for (const name of skillNames) {
      const outcome = applyOne({
        src: resolve(skillsRoot, name),
        dest: resolve(cwd, hostDirs.skills, name),
        mode,
        dryRun,
      });
      pushOutcome(outcome, resolve(cwd, hostDirs.skills, name), created, refreshed, skipped);
    }

    for (const fileName of agentFiles) {
      const outcome = applyOne({
        src: resolve(agentsRoot, fileName),
        dest: resolve(cwd, hostDirs.agents, fileName),
        mode,
        dryRun,
      });
      pushOutcome(outcome, resolve(cwd, hostDirs.agents, fileName), created, refreshed, skipped);
    }
  }

  return { created, refreshed, skipped, mode };
}

function pushOutcome(
  outcome: ApplyOutcome,
  path: string,
  created: string[],
  refreshed: string[],
  skipped: string[],
): void {
  if (outcome === 'created') created.push(path);
  else if (outcome === 'refreshed') refreshed.push(path);
  else skipped.push(path);
}

/**
 * Remove the per-host skill + agent farm entries for a single host that
 * were materialized from the bundled npm package. Called by
 * `forge upgrade --remove-agent` so a disabled host can no longer
 * discover forge slash commands/subagents in the project.
 *
 * Data-safety contract (Codex P1 review): we enumerate the bundled skill
 * + agent names from `packageRoot` and delete ONLY those specific entries
 * from the host's `.X/skills/` and `.X/agents/` dirs. Any user-owned
 * non-forge content in those dirs (per gitignore-block.ts: "adopters who
 * want to track their own non-forge skills can add `!` override lines")
 * is left intact.
 *
 * Note: if forge renames a bundled skill across versions, the OLD name is
 * not in the current bundled set and will be left in the farm. Acceptable
 * for v0.3.0 — forge upgrade also wouldn't refresh under the old name,
 * and the user gets a harmless dead symlink at worst.
 *
 * Returns the relative paths it removed (or would remove under dryRun)
 * so the caller can report them in `filesChanged`.
 */
export function pruneHostFarm(
  opts: { cwd: string; host: AgentKind; packageRoot: string; dryRun?: boolean },
): readonly string[] {
  const cwd = canonicalizeIfExists(opts.cwd);
  const packageRoot = canonicalizeIfExists(opts.packageRoot);
  const hostDirs = HOST_DIRS[opts.host];
  const skillNames = listBundledSkills(resolve(packageRoot, 'skills'));
  const agentFiles = listBundledAgents(resolve(packageRoot, 'agents'));
  const removed: string[] = [];

  for (const name of skillNames) {
    const entry = resolve(cwd, hostDirs.skills, name);
    if (!existsSync(entry) && !isBrokenSymlink(entry)) continue;
    if (!opts.dryRun) rmSync(entry, { recursive: true, force: true });
    removed.push(`${hostDirs.skills}/${name}`);
  }
  for (const name of agentFiles) {
    const entry = resolve(cwd, hostDirs.agents, name);
    if (!existsSync(entry) && !isBrokenSymlink(entry)) continue;
    if (!opts.dryRun) rmSync(entry, { recursive: true, force: true });
    removed.push(`${hostDirs.agents}/${name}`);
  }

  return removed;
}
