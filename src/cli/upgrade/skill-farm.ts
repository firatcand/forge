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
// file/dir, broken link) is removed and rewritten in place. FORGE-221: no
// `.bak` backup is kept — the pre-fix `.bak` rename dumped a duplicate-loading
// entry into the skills-discovery dir (every host globs `.X/skills/*` and loads
// `<name>.bak` as a second skill). A symlink holds no data and is regenerable
// from the bundle; the copy-mode tree is regenerable too. Older `.bak` orphans
// left by previous forge versions are swept on the next upgrade.
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
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstSymlinkedComponent } from '../../core/symlink-guard.ts';
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
  // FORGE-160 (USER CHOICE B): `.agents/skills` is Cursor's NATIVE cross-tool
  // skill root (one root all tools can read); subagent definitions farm into
  // `.cursor/agents/`. Note `.agents/skills` is a SHARED root — pruneHostFarm
  // must not remove it while another enabled host still maps to it (none do
  // today, but the enabled-host guard makes that future-proof).
  cursor: { skills: '.agents/skills', agents: '.cursor/agents' },
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
  /**
   * Stale forge-owned farm symlinks removed: entries whose skill/agent is no
   * longer in the bundle (e.g. a skill deleted in a forge release), PLUS
   * orphaned `*.bak` symlinks swept by the FORGE-221 self-heal. Only
   * provenance-verified forge symlinks and regenerable `.bak` symlinks are
   * pruned; user content (real files/dirs) is left alone.
   */
  readonly pruned: readonly string[];
  /** Effective mode (after platform detection if not overridden). */
  readonly mode: FarmMode;
  /**
   * FORGE-160 symlink guard: human-readable notices for hosts whose farm was
   * SKIPPED because a component of the host's skills/agents dir is a symlink
   * (writing/renaming through it would escape the working tree). One entry per
   * skipped (host, kind) pair. Empty in the common case.
   */
  readonly notices: readonly string[];
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
 * symlink with a different target, is removed and replaced in place (no `.bak`
 * — FORGE-221).
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
    // Mismatch — replace in place, NO `.bak` (FORGE-221). The old `.bak` rename
    // left a duplicate-loading entry inside the skills-discovery dir. A symlink
    // holds no data and is regenerable from the bundle; the copy-mode dest is
    // regenerable too (maintainer accepted dropping the Windows backup — the
    // source tree is intact, so a re-run restores it). rmSync on a symlink
    // removes the link itself, never its target.
    if (!dryRun) {
      rmSync(dest, { recursive: true, force: true });
      writeTarget(src, dest, mode, linkTarget);
    }
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
  const pruned: string[] = [];
  const notices: string[] = [];

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
  const skillNameSet = new Set(skillNames);
  const agentFileSet = new Set(agentFiles);

  for (const agent of opts.enabledAgents) {
    const hostDirs = HOST_DIRS[agent];

    // FORGE-221 self-heal: sweep orphaned `*.bak` symlinks left by older forge
    // versions (the pre-fix refresh renamed mismatched links to `<name>.bak`
    // inside the skills-discovery dir, so each loaded as a duplicate skill).
    // Runs for EVERY host regardless of the FORGE-160 guard below (USER CHOICE B)
    // — but sweepOrphanBak refuses to unlink through a farm dir that resolves
    // outside the working tree, so the FORGE-160 escape invariant still holds.
    pruned.push(...sweepOrphanBak({ cwd, destDirRel: hostDirs.skills, dryRun }));
    pruned.push(...sweepOrphanBak({ cwd, destDirRel: hostDirs.agents, dryRun }));

    // FORGE-160 symlink guard. The farm dir (e.g. cursor's `.agents/skills` or
    // `.cursor/agents`, claude's `.claude/skills`/`.claude/agents`) is a
    // directory forge mkdir/symlinks/renames INTO. If ANY component of that dir
    // path is a symlink — `.agents` (dotfiles repo) OR `.agents/skills`, and
    // equally `.claude` for the claude host — mkdirSync/symlinkSync/renameSync
    // would follow the link and create/rename forge entries OUTSIDE the working
    // tree. Skip THIS host's skills/agents farm with a surfaced notice; other
    // enabled hosts are unaffected. dryRun behaves identically (we check the
    // real filesystem either way, and never write).
    const skillsLink = firstSymlinkedComponent(cwd, hostDirs.skills);
    if (skillsLink) {
      notices.push(
        `skipped ${agent} skill farm: '${skillsLink}' is a symlink — materializing '${hostDirs.skills}' through it would escape the working tree`,
      );
    } else {
      for (const name of skillNames) {
        const outcome = applyOne({
          src: resolve(skillsRoot, name),
          dest: resolve(cwd, hostDirs.skills, name),
          mode,
          dryRun,
        });
        pushOutcome(outcome, resolve(cwd, hostDirs.skills, name), created, refreshed, skipped);
      }
      pruned.push(
        ...pruneStaleEntries({
          cwd,
          destDirRel: hostDirs.skills,
          bundleRoot: skillsRoot,
          bundleNames: skillNameSet,
          dryRun,
        }),
      );
    }

    const agentsLink = firstSymlinkedComponent(cwd, hostDirs.agents);
    if (agentsLink) {
      notices.push(
        `skipped ${agent} agent farm: '${agentsLink}' is a symlink — materializing '${hostDirs.agents}' through it would escape the working tree`,
      );
    } else {
      for (const fileName of agentFiles) {
        const outcome = applyOne({
          src: resolve(agentsRoot, fileName),
          dest: resolve(cwd, hostDirs.agents, fileName),
          mode,
          dryRun,
        });
        pushOutcome(outcome, resolve(cwd, hostDirs.agents, fileName), created, refreshed, skipped);
      }
      pruned.push(
        ...pruneStaleEntries({
          cwd,
          destDirRel: hostDirs.agents,
          bundleRoot: agentsRoot,
          bundleNames: agentFileSet,
          dryRun,
        }),
      );
    }
  }

  return { created, refreshed, skipped, pruned, mode, notices };
}

/**
 * Remove forge-owned farm symlinks whose skill/agent is no longer in the bundle
 * (e.g. a skill deleted in a forge release). Mirrors `pruneHostFarm`'s
 * provenance contract — only entries that are provenance-verified forge symlinks
 * are removed; user content, `.bak` backups, and current-bundle entries are left
 * alone. The caller guarantees no path component of `destDirRel` is a symlink
 * (the FORGE-160 guard runs first), so `rmSync` can never delete through a link.
 * Copy-mode farms (Windows) carry no provenance signal, so stale copies are
 * left in place — same limitation as `pruneHostFarm`.
 */
function pruneStaleEntries(args: {
  readonly cwd: string;
  readonly destDirRel: string;
  readonly bundleRoot: string;
  readonly bundleNames: ReadonlySet<string>;
  readonly dryRun: boolean;
}): string[] {
  const removed: string[] = [];
  const destDir = resolve(args.cwd, args.destDirRel);
  if (!existsSync(destDir)) return removed;
  for (const name of readdirSync(destDir)) {
    if (name.endsWith('.bak')) continue; // applyOne backup — never auto-delete
    if (args.bundleNames.has(name)) continue; // still in the bundle — handled by applyOne
    const dest = resolve(destDir, name);
    // Only forge-created symlinks (target matches the bundled path forge would
    // compute) are ours to remove — even when that target no longer exists
    // (a dangling link from a removed skill). User content / foreign symlinks
    // fail this check and are left alone.
    if (!isForgeOwnedSymlink(dest, resolve(args.bundleRoot, name))) continue;
    if (!args.dryRun) rmSync(dest, { recursive: true, force: true });
    removed.push(`${args.destDirRel}/${name}`);
  }
  return removed;
}

/**
 * FORGE-221 self-heal: remove orphaned `*.bak` symlinks from a farm directory.
 *
 * Only entries that are SYMBOLIC LINKS (live or broken) are removed — a symlink
 * holds no data and is trivially regenerable, so deleting it loses nothing. Real
 * files/dirs named `*.bak` are left alone (could be user content or a copy-mode
 * artifact carrying real bytes).
 *
 * FORGE-160 containment (USER CHOICE B): this runs even when the host farm dir is
 * symlink-guarded, so it FIRST verifies the farm dir resolves INSIDE the working
 * tree. If any path component is a symlink escaping `cwd`, `rmSync` would unlink
 * through it and delete outside the tree — we skip entirely in that case. The
 * benign case (a symlinked component that still resolves within `cwd`) is swept.
 */
function sweepOrphanBak(args: {
  readonly cwd: string;
  readonly destDirRel: string;
  readonly dryRun: boolean;
}): string[] {
  const removed: string[] = [];
  const destDir = resolve(args.cwd, args.destDirRel);
  let entries: string[];
  try {
    entries = readdirSync(destDir);
  } catch {
    return removed; // farm dir absent — nothing to sweep
  }
  // Containment guard — never unlink through a farm dir that escapes the tree.
  const realCwd = canonicalizeIfExists(args.cwd);
  const realDestDir = canonicalizeIfExists(destDir);
  if (realDestDir !== realCwd && !realDestDir.startsWith(realCwd + sep)) return removed;
  for (const name of entries) {
    if (!name.endsWith('.bak')) continue;
    const dest = resolve(destDir, name);
    const st = safeLstat(dest);
    if (!st || !st.isSymbolicLink()) continue; // real file/dir → leave (may hold data)
    if (!args.dryRun) rmSync(dest, { force: true });
    removed.push(`${args.destDirRel}/${name}`);
  }
  return removed;
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
 * Data-safety contract (Codex P1 + P2 reviews):
 *   1. Only enumerate entries whose names match the bundled forge set
 *      (so we never touch unrelated user content in `.X/skills/`).
 *   2. Within that candidate set, only delete entries whose **provenance
 *      is verifiable as forge-owned** — currently: it's a symlink whose
 *      `readlink` matches the expected bundled target. Anything else
 *      (a real file/dir at a bundled name) is treated as user-replaced
 *      content (e.g. an "eject" of a forge skill via `!` override) and
 *      left in place.
 *
 * Known limitation (Windows / copy mode): copies aren't distinguishable
 * from user content post-hoc without a manifest or content hash, so this
 * function leaves them alone too. Adopters on Windows running
 * `--remove-agent` need to manually `rm .X/skills/` if they want the
 * stale forge copies gone. Tracked as a v0.3.1+ improvement.
 *
 * Returns the relative paths it removed (or would remove under dryRun) plus any
 * symlink-guard notices, so the caller can report them in `filesChanged`.
 */
export interface PruneHostFarmResult {
  /** Relative paths removed (or, under dryRun, that would be removed). */
  readonly removed: readonly string[];
  /**
   * FORGE-160 symlink guard: notices for roots SKIPPED because a component of
   * the host's skills/agents dir is a symlink — rmSync through it would delete
   * OUTSIDE the working tree. Empty in the common case.
   */
  readonly notices: readonly string[];
}

export function pruneHostFarm(
  opts: {
    cwd: string;
    host: AgentKind;
    packageRoot: string;
    dryRun?: boolean;
    /**
     * FORGE-160 shared-root prune safety: hosts that REMAIN enabled after this
     * removal. If one of them maps to the same `skills`/`agents` root as the
     * host being pruned (e.g. cursor + a future host both using `.agents/skills`),
     * that shared root is LEFT IN PLACE — pruning it would orphan the still-
     * enabled host's discovery. Omitted/empty ⇒ no host shares the root (legacy
     * behavior: prune everything forge-owned).
     */
    enabledHosts?: readonly AgentKind[];
  },
): PruneHostFarmResult {
  const cwd = canonicalizeIfExists(opts.cwd);
  const packageRoot = canonicalizeIfExists(opts.packageRoot);
  const hostDirs = HOST_DIRS[opts.host];
  const skillNames = listBundledSkills(resolve(packageRoot, 'skills'));
  const agentFiles = listBundledAgents(resolve(packageRoot, 'agents'));
  const removed: string[] = [];
  const notices: string[] = [];

  // Roots still claimed by another enabled host — never prune these.
  const stillEnabled = (opts.enabledHosts ?? []).filter((h) => h !== opts.host);
  const sharedSkillsRoots = new Set(stillEnabled.map((h) => HOST_DIRS[h].skills));
  const sharedAgentsRoots = new Set(stillEnabled.map((h) => HOST_DIRS[h].agents));
  const skillsRootShared = sharedSkillsRoots.has(hostDirs.skills);
  const agentsRootShared = sharedAgentsRoots.has(hostDirs.agents);

  if (skillsRootShared && agentsRootShared) {
    // Both roots are still in use by another enabled host — nothing to prune.
    return { removed, notices };
  }

  // FORGE-160 symlink guard. Before ANY rmSync, verify no component of the
  // host's farm dir path is a symlink — `.agents` / `.agents/skills` (cursor)
  // or `.claude` / `.claude/skills` (claude). rmSync through a symlinked
  // component would delete the link's TARGET, outside the working tree. Skip
  // that root entirely with a notice; never delete through the link.
  const skillsLink = firstSymlinkedComponent(cwd, hostDirs.skills);
  if (skillsLink) {
    notices.push(
      `skipped pruning ${opts.host} skill farm: '${skillsLink}' is a symlink — removing under '${hostDirs.skills}' would delete through the link`,
    );
  }
  const agentsLink = firstSymlinkedComponent(cwd, hostDirs.agents);
  if (agentsLink) {
    notices.push(
      `skipped pruning ${opts.host} agent farm: '${agentsLink}' is a symlink — removing under '${hostDirs.agents}' would delete through the link`,
    );
  }

  for (const name of skillNames) {
    if (skillsRootShared || skillsLink) break;
    const dest = resolve(cwd, hostDirs.skills, name);
    const src = resolve(packageRoot, 'skills', name);
    if (!isForgeOwnedSymlink(dest, src)) continue;
    if (!opts.dryRun) rmSync(dest, { recursive: true, force: true });
    removed.push(`${hostDirs.skills}/${name}`);
  }
  for (const name of agentFiles) {
    if (agentsRootShared || agentsLink) break;
    const dest = resolve(cwd, hostDirs.agents, name);
    const src = resolve(packageRoot, 'agents', name);
    if (!isForgeOwnedSymlink(dest, src)) continue;
    if (!opts.dryRun) rmSync(dest, { recursive: true, force: true });
    removed.push(`${hostDirs.agents}/${name}`);
  }

  return { removed, notices };
}

/**
 * Provenance check: returns true only when `dest` is a symlink whose
 * `readlink` matches the relative path forge would compute for `src`.
 * Real files/dirs at `dest` (user-replaced content), or symlinks pointing
 * elsewhere (user re-symlinked), return false — we leave them alone.
 */
function isForgeOwnedSymlink(dest: string, src: string): boolean {
  const lst = safeLstat(dest);
  if (!lst || !lst.isSymbolicLink()) return false;
  const expectedTarget = relative(dirname(dest), src);
  return safeReadlink(dest) === expectedTarget;
}

export interface FarmProvenanceCounts {
  /** Symlinks whose target matches the bundled forge source (provenance-verified). */
  readonly forgeOwned: number;
  /** Present entries that are NOT forge-owned: real files/dirs, symlinks pointing
   *  elsewhere, or entries whose name isn't in the bundled set (a user's own skill). */
  readonly userOwned: number;
  /** Dangling symlinks (target no longer exists). */
  readonly broken: number;
}

/**
 * FORGE-159: read-only provenance census of a single host's skill or agent farm
 * directory (e.g. `.claude/skills/`). Powers `forge status`. Uses the SAME
 * `isForgeOwnedSymlink` check `pruneHostFarm` relies on, so "forge-owned" means
 * the same thing whether we're reporting or deleting — single source of truth.
 *
 * Returns all-zero counts when the farm dir is absent. `.bak` backup entries
 * (created by applyOne on refresh) are skipped so they don't inflate userOwned.
 *
 * Windows/copy-mode caveat (same as pruneHostFarm): copies are indistinguishable
 * from user content without a manifest, so on copy-mode farms forge-installed
 * entries count as userOwned. The default POSIX/dogfood path is symlink mode,
 * where provenance is exact.
 *
 * Same-install caveat: "forge-owned" means the symlink points at THIS package's
 * `skills/`/`agents/`. A farm created by a DIFFERENT forge install (e.g. a global
 * npm install) and inspected by a local dev build resolves a different
 * `packageRoot`, so its symlinks read as userOwned. This is intentional — it's
 * the same conservative definition pruneHostFarm uses to decide what's safe to
 * delete. In a normal adopter project (one forge install throughout) the counts
 * are exact.
 */
export function classifyHostFarm(opts: {
  readonly cwd: string;
  readonly packageRoot: string;
  readonly host: AgentKind;
  readonly kind: 'skills' | 'agents';
}): FarmProvenanceCounts {
  const cwd = canonicalizeIfExists(opts.cwd);
  const packageRoot = canonicalizeIfExists(opts.packageRoot);
  const hostDirs = HOST_DIRS[opts.host];
  const farmDir = resolve(cwd, opts.kind === 'skills' ? hostDirs.skills : hostDirs.agents);
  const srcRoot = resolve(packageRoot, opts.kind);
  const bundled = new Set(
    opts.kind === 'skills' ? listBundledSkills(srcRoot) : listBundledAgents(srcRoot),
  );

  let forgeOwned = 0;
  let userOwned = 0;
  let broken = 0;

  let entries: string[];
  try {
    entries = readdirSync(farmDir);
  } catch {
    return { forgeOwned: 0, userOwned: 0, broken: 0 };
  }

  for (const name of entries) {
    if (name.endsWith('.bak')) continue;
    const dest = resolve(farmDir, name);
    // Order matters: a dangling forge symlink is "broken", not "forge-owned".
    if (isBrokenSymlink(dest)) {
      broken += 1;
      continue;
    }
    const src = resolve(srcRoot, name);
    if (bundled.has(name) && isForgeOwnedSymlink(dest, src)) {
      forgeOwned += 1;
    } else {
      userOwned += 1;
    }
  }

  return { forgeOwned, userOwned, broken };
}
