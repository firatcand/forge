// `forge upgrade` verb. Refreshes the gitignored .forge/CONTEXT.md and per-agent
// root file marker blocks against the bundled methodology version. Strict
// edit-detection: if the user (or another process) modified .forge/CONTEXT.md
// since the last upgrade, refuse with exit 1 unless --force is passed.
//
// Composition over re-implementation: this verb delegates to the modules that
// landed in Phase A (render-context, agent-root-files, gitignore-block) and
// version-check from B7. It owns ordering, atomicity, and exit-code semantics.
//
// Exit codes (design §9):
//   0 — success or no-op
//   1 — local edit detected without --force
//   3 — settings.yaml missing or malformed
//   4 — repo's methodology is NEWER than CLI bundles (silent-rollback guard)

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as yamlParse, parseDocument, stringify as yamlStringify } from 'yaml';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { firstSymlinkedComponent, firstSymlinkedParent, isHardlinkAt, isSymlinkAt } from '../../core/symlink-guard.ts';
import { SettingsSchema, type Settings } from '../../schemas/index.ts';
import {
  MANIFEST_RELPATH,
  farmEntriesFromResult,
  readManifest,
  refreshManifest,
  writeManifest,
  manifestPath,
} from '../manifest.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../registry.ts';
import {
  MATERIALIZE_WHEN_ENABLED,
  ROOT_FILE_BY_AGENT,
  buildCursorBlock,
  buildCursorRuleFile,
  buildPrefixBlock,
  bodyWithoutPrefixBlock,
  replacePrefixBlock,
  writeCursorRuleBody,
  type AgentKind,
} from './agent-root-files.ts';
import { applyGitignoreBlock } from './gitignore-block.ts';
import { writeStatusLineConfig } from './host-config.ts';
import { migrateClaudemd } from './migrate-claudemd.ts';
import { renderContext } from './render-context.ts';
import { applySkillFarm, locatePackageRoot, pruneHostFarm } from './skill-farm.ts';
import { locateContextTemplate } from './template-loader.ts';
import {
  checkVersionDrift,
  compareVersions,
  formatCliTooOldRefusal,
  readBundledMethodologyVersion,
} from './version-check.ts';

export interface UpgradeOptions {
  readonly cwd: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly addAgent?: AgentKind;
  readonly removeAgent?: AgentKind;
  /** Required to remove an agent whose root file has user content below the marker block. */
  readonly confirm?: boolean;
  /** One-shot migration from v0.4 combined CLAUDE.md → v0.5 split layout (FORGE-154). */
  readonly migrateClaudemd?: boolean;
  /**
   * FORGE-197 (R3): INTERNAL test seam — overrides the home dir the statusLine
   * writer resolves (`~/.claude/settings.json`). NOT a public CLI flag.
   * Production leaves it undefined → the writer uses os.homedir(). Upgrade tests
   * inject a temp fake home so they never touch the real ~/.claude.
   */
  readonly hostConfigHomeDir?: string;
}

export interface UpgradeResult {
  readonly exitCode: number;
  readonly filesChanged: readonly string[];
  readonly stderr: string;
  /**
   * FORGE-197: a non-blocking, idempotent DISCOVERY notice (the statusLine
   * opt-in offer) surfaced when `hosts.claude.status_line` is off. Kept OUT of
   * `stderr` deliberately — `stderr` is a deterministic structured contract that
   * existing idempotency tests pin (twice == once), so a per-run offer must not
   * pollute it. bin/forge.ts prints this to process.stderr. FORGE_QUIET-
   * suppressed (then undefined). Undefined when the opt-in is on.
   */
  readonly discoveryNotice?: string;
}

const FORGE_REPO_URL = 'https://github.com/firatcand/forge';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** FORGE-209: read a symlink's immediate target for a notice, or null if the
 * read fails (e.g. the link vanished in the window between the isSymlinkAt check
 * and here → raw ENOENT). Callers fall back to a target-less notice so a
 * vanished link never crashes `forge upgrade` (exit 0 preserved). */
function readlinkOrNull(absPath: string): string | null {
  try {
    return readlinkSync(absPath);
  } catch {
    return null;
  }
}

/**
 * FORGE-208/209: skip notice for a symlinked forge-managed root file. Printed in
 * BOTH dry-run and real mode (dry-run parity AC); the path never enters
 * `changed`.
 *
 * FORGE-209-(4): when the enabled set is provided, resolve the IMMEDIATE link
 * target against the file's own directory and state whether that target is
 * actually managed by an ENABLED host. A `CLAUDE.md → AGENTS.md` link whose
 * target host (codex) is NOT enabled means NO loop iteration maintains a
 * methodology block anywhere — the notice must say so explicitly rather than
 * imply "managing the target if enabled". Only the immediate target is
 * considered (a chained target isn't "managed").
 *
 * FORGE-209-(1): the readlink is guarded — a link that vanished in the check→use
 * window degrades to a target-less `(symlink)` notice instead of throwing ENOENT.
 */
function symlinkSkipNotice(
  fileName: string,
  absPath: string,
  enabledRootFiles?: readonly AgentKind[],
  cwd?: string,
): string {
  const target = readlinkOrNull(absPath);
  if (target === null) {
    return `skipped: ${fileName} (symlink) — forge does not manage symlinked root files; managing the target if enabled`;
  }
  // FORGE-209-(4): enabled-set awareness. Resolve the (possibly relative) target
  // against the link's directory, normalize to absolute, and compare against
  // each enabled host's ROOT_FILE_BY_AGENT absolute path.
  if (enabledRootFiles !== undefined && cwd !== undefined) {
    const resolvedTarget = resolve(dirname(absPath), target);
    const managingHost = enabledRootFiles.find(
      (agent) => resolve(cwd, ROOT_FILE_BY_AGENT[agent]) === resolvedTarget,
    );
    if (managingHost !== undefined) {
      return `skipped: ${fileName} (symlink → ${target}) — forge does not manage symlinked root files (target ${target} is managed by host ${managingHost})`;
    }
    return `skipped: ${fileName} (symlink → ${target}) — forge does not manage symlinked root files (target ${target} is NOT managed by any enabled host — no methodology block is maintained anywhere; enable that host or replace the symlink with a regular file)`;
  }
  return `skipped: ${fileName} (symlink → ${target}) — forge does not manage symlinked root files; managing the target if enabled`;
}

/** FORGE-208: skip notice for a forge artifact whose PARENT directory is a
 * symlink. Mirrors {@link symlinkSkipNotice}'s shape (printed in dry-run + real
 * mode; path never enters `changed`). FORGE-209-(1): readlink guarded. */
function symlinkParentSkipNotice(fileName: string, parentRel: string, cwd: string): string {
  const target = readlinkOrNull(resolve(cwd, parentRel));
  const suffix = target === null ? '' : ` → ${target}`;
  return `skipped: ${fileName} (parent ${parentRel} is a symlink${suffix}) — forge does not write through symlinked parent directories`;
}

/** FORGE-209-(5): skip notice for a forge-managed file that is a HARD LINK
 * (nlink > 1). Mirrors {@link symlinkSkipNotice}'s shape — printed in dry-run +
 * real mode; the path never enters `changed`. writeAtomic would refuse this
 * anyway (HARDLINK_TARGET_REFUSED); the precheck keeps the refusal from
 * aborting an upgrade mid-flight, after CONTEXT.md/.version are already written. */
function hardlinkSkipNotice(fileName: string): string {
  return `skipped: ${fileName} (hard link) — forge does not write through hard-linked files; renaming over it would detach this link and leave the other link(s) pointing at the old content. Replace it with a regular file if you want forge to manage it.`;
}

/**
 * Working snapshot of settings.yaml as parsed YAML — mutable so --add-agent /
 * --remove-agent can update agents.enabled_root_files and re-serialize. This
 * preserves all raw YAML fields (comments are lost; field ordering is mostly
 * preserved by the yaml package). We validate the parsed shape via
 * SettingsSchema.safeParse() to fail fast on unknown agent kinds or other
 * shape drift — but we DO NOT serialize the schema-defaulted object back to
 * disk (that would expand every default), so the working snapshot is the raw
 * parsed YAML, not the schema output.
 */
interface SettingsYaml {
  readonly version: number;
  readonly project: { readonly name: string };
  agents: {
    readonly primary_host_cli: AgentKind;
    enabled_root_files: AgentKind[];
  };
  [key: string]: unknown;
}

export async function upgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const cwd = opts.cwd;

  // FORGE-154 Phase C — one-shot legacy migration. Routes BEFORE the
  // settings.yaml validation below because the migration's own precondition
  // checks (.forge/CONTEXT.md must not exist; settings.yaml must exist) are
  // tuned for the v0.4 → v0.5 transition and return their own exit codes.
  // Mutex with other write-modifying flags is enforced at the CLI router
  // (src/bin/forge.ts) so by the time we reach here, no conflict is possible.
  if (opts.migrateClaudemd) {
    return migrateClaudemd({ cwd, dryRun: opts.dryRun });
  }

  const settingsPath = resolve(cwd, '.forge/settings.yaml');
  const versionPath = resolve(cwd, '.forge/.version');
  const contextPath = resolve(cwd, '.forge/CONTEXT.md');
  const gitignorePath = resolve(cwd, '.gitignore');

  const changed: string[] = [];
  // FORGE-208: skip notices for symlinked managed files. Reported on stderr
  // with exit 0 — a symlinked root file is a deliberate adopter topology
  // (e.g. CLAUDE.md → AGENTS.md parity), not an error.
  const notices: string[] = [];

  // FORGE-160: refuse UPFRONT when `.forge` itself (or a parent component of it)
  // is a symbolic link — BEFORE the existsSync(settingsPath) probe and ANY
  // read/mutation. A symlinked `.forge` directory passes the leaf settings.yaml
  // check below (the leaf is a real file under the link), then writeAtomic writes
  // CONTEXT.md/.version/settings.yaml THROUGH the link, escaping the working
  // tree. Refusing here keeps the refusal idempotent (exit 1, nothing written,
  // link intact). Message consistent with the leaf settings.yaml refusal.
  const forgeLink = firstSymlinkedComponent(cwd, '.forge');
  if (forgeLink !== null) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr:
        'forge upgrade: .forge is a symbolic link. Refusing — destructive writes through symlinks could mutate files outside the working tree. Resolve the symlink or replace with a regular directory first.',
    };
  }

  // 0. Settings must exist (design §9 exit code 3).
  if (!existsSync(settingsPath)) {
    return {
      exitCode: 3,
      filesChanged: [],
      stderr: 'forge upgrade: .forge/settings.yaml not found. Run `forge init` first.',
    };
  }
  // FORGE-208: refuse a symlinked settings.yaml UPFRONT — before parsing and
  // before ANY mutation (CONTEXT.md, .version, root files, .gitignore). The
  // later settings re-serializations (--add-agent / --remove-agent) go through
  // writeAtomic, whose own preflight would throw mid-flow; refusing here keeps
  // the refusal idempotent (exit 1, nothing written). Consistent with
  // migrate-claudemd's M2 guard.
  if (isSymlinkAt(settingsPath)) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr:
        'forge upgrade: .forge/settings.yaml is a symbolic link. Refusing — destructive writes through symlinks could mutate files outside the working tree. Resolve the symlink or replace with a regular file first.',
    };
  }
  // FORGE-209-(5): refuse a hard-linked settings.yaml UPFRONT too — the later
  // settings re-serializations (--add-agent / --remove-agent / methodology pin)
  // route through writeAtomic, whose rename would detach this link and leave the
  // other link(s) pointing at the old content. Refusing here (vs the skip used
  // for root files / .gitignore) mirrors the symlink settings refusal directly
  // above: settings.yaml is integral, not a skippable artifact, and the refusal
  // stays idempotent (exit 1, nothing written).
  if (isHardlinkAt(settingsPath)) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr:
        'forge upgrade: .forge/settings.yaml is a hard link (nlink > 1). Refusing — writing through it would detach this link and leave the other link(s) pointing at the old content. Replace it with a regular file first.',
    };
  }
  // FORGE-209-(5) (GPT-5.5 cross-review B1): refuse UPFRONT when any forge-OWNED
  // always-write file is a hard link. CONTEXT.md / .version / manifest.json are
  // written unconditionally later (lines ~387, ~388, and the manifest refresh);
  // a hardlinked one would make writeAtomic throw HARDLINK_TARGET_REFUSED
  // MID-upgrade (e.g. .version after CONTEXT.md, or manifest after every other
  // write) — a partial upgrade. Like the settings.yaml refusal above, these are
  // integral forge-internal files (not skippable artifacts), so refuse here
  // before ANY mutation, keeping the refusal idempotent (exit 1, nothing written).
  const manifestAbs = manifestPath(cwd);
  for (const [label, p] of [
    ['.forge/CONTEXT.md', contextPath],
    ['.forge/.version', versionPath],
    ['.forge/manifest.json', manifestAbs],
  ] as const) {
    if (isHardlinkAt(p)) {
      return {
        exitCode: 1,
        filesChanged: [],
        stderr: `forge upgrade: ${label} is a hard link (nlink > 1). Refusing — writing through it would detach this link and leave the other link(s) pointing at the old content. Replace it with a regular file first.`,
      };
    }
  }
  let settings: SettingsYaml;
  let validated: Settings;
  try {
    const raw = yamlParse(readFileSync(settingsPath, 'utf8')) as unknown;
    // Validate via SettingsSchema — fail fast on unknown agent kinds, missing
    // fields, or malformed shape. Codex review (FORGE-153 round 1) caught
    // that an unchecked cast lets `enabled_root_files: ["cursor"]` reach the
    // refresh loop and throw mid-write. Schema validation BEFORE any writes
    // keeps refusal idempotent (exit 3, no partial state).
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const path = firstIssue?.path.join('.') ?? '(root)';
      return {
        exitCode: 3,
        filesChanged: [],
        stderr: `forge upgrade: invalid .forge/settings.yaml — ${path}: ${firstIssue?.message ?? 'schema validation failed'}`,
      };
    }
    validated = parsed.data;
    // Build the working snapshot from the RAW YAML (so re-serialization stays
    // minimal) but mirror enabled_root_files from the schema-defaulted value
    // (which expands empty/absent → [primary_host_cli]).
    settings = raw as SettingsYaml;
    if (!Array.isArray(settings.agents.enabled_root_files) || settings.agents.enabled_root_files.length === 0) {
      settings.agents = { ...settings.agents, enabled_root_files: [...validated.agents.enabled_root_files] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 3,
      filesChanged: [],
      stderr: `forge upgrade: failed to parse .forge/settings.yaml — ${msg}`,
    };
  }
  // `validated` is the schema-defaulted Settings — consumed both to mirror
  // enabled_root_files above and to read the FORGE-197 hosts.claude.status_line
  // opt-in in step 12 below.

  // 1. Resolve the CLI's bundled methodology version.
  const bundledVersion = readBundledMethodologyVersion();

  // 2. B10 — refuse with exit 4 when on-disk version is NEWER than bundle.
  //    Runs BEFORE any write (and ignores --force — downgrade is never a happy path).
  const drift = checkVersionDrift({ cwd, currentVersion: bundledVersion });
  if (drift && compareVersions(drift.onDisk, drift.current) === 'newer') {
    return {
      exitCode: 4,
      filesChanged: [],
      stderr: formatCliTooOldRefusal(drift),
    };
  }

  // 3. Mutate settings if --add-agent / --remove-agent. The mutation happens
  //    BEFORE the refresh loop so the newly-added agent is included in step 6,
  //    and the removed agent is excluded.
  const recentlyWritten = new Set<string>();

  if (opts.addAgent) {
    const result = applyAddAgent(opts, settings, cwd, recentlyWritten, changed);
    if (result) return result;
  }

  if (opts.removeAgent) {
    const result = applyRemoveAgent(opts, settings, cwd, changed, notices);
    if (result) return result;
  }

  // 4. Render desired CONTEXT.md from bundled template + registry.
  const contextTemplate = locateContextTemplate();
  const desiredContext = renderContext(contextTemplate, {
    version: bundledVersion,
    verbs: CLI_VERBS,
    slashCommands: SLASH_COMMANDS,
  });

  // 5. Compare on-disk CONTEXT.md to desired.
  const onDiskContext = existsSync(contextPath) ? readFileSync(contextPath, 'utf8') : '';
  const onDiskVersionAtCheck = existsSync(versionPath)
    ? readFileSync(versionPath, 'utf8').trim()
    : '';
  if (sha256(onDiskContext) !== sha256(desiredContext)) {
    // Edit-detection (B2): refuse with exit 1 ONLY when the on-disk version
    // matches the bundled version (so a SHA mismatch unambiguously means the
    // user edited the file). When versions differ, a SHA mismatch is the
    // expected stale state — overwrite silently without requiring --force.
    const versionsMatch =
      onDiskVersionAtCheck.length > 0 && onDiskVersionAtCheck === bundledVersion;
    if (onDiskContext.length > 0 && versionsMatch && !opts.force) {
      return {
        exitCode: 1,
        filesChanged: [],
        stderr: [
          'forge upgrade: .forge/CONTEXT.md has local edits.',
          'Re-run with --force to overwrite (your edits will be saved as .forge/CONTEXT.md.bak).',
        ].join('\n'),
      };
    }
    const versionNeedsBump = onDiskVersionAtCheck !== bundledVersion;
    if (!opts.dryRun) {
      // Atomicity (revised after Codex review): write CONTEXT.md FIRST, then
      // .version. The naive "write .version first as sentinel" pattern inverts
      // crash recovery — if we crash between the writes with .version=bundled
      // but CONTEXT.md=stale, the next upgrade sees versionsMatch=true +
      // SHA-mismatch and refuses as "local edits", forcing the user to --force.
      //
      // With CONTEXT.md first:
      //   - crash before CONTEXT.md write: nothing changed; next run retries
      //   - crash after CONTEXT.md, before .version: SHA matches → no rewrite
      //     of CONTEXT.md; the `else` branch below catches the stale .version
      //     and refreshes it idempotently.
      // writeAtomic() uses tmp+rename so partial CONTEXT.md is impossible.
      if (onDiskContext.length > 0 && versionsMatch && opts.force) {
        writeFileSync(`${contextPath}.bak`, onDiskContext);
      }
      writeAtomic(contextPath, desiredContext);
      writeAtomic(versionPath, `${bundledVersion}\n`);
    }
    changed.push('.forge/CONTEXT.md');
    if (versionNeedsBump) changed.push('.forge/.version');
  } else {
    // SHA matches but .version may have been hand-edited to something stale —
    // refresh the stamp so the drift-warning pre-hook doesn't fire forever.
    if (onDiskVersionAtCheck !== bundledVersion) {
      if (!opts.dryRun) writeAtomic(versionPath, `${bundledVersion}\n`);
      changed.push('.forge/.version');
    }
  }

  // 7. Refresh each enabled agent's root file marker block (preserves user
  //    body below the second marker via replacePrefixBlock from A5).
  for (const agent of settings.agents.enabled_root_files) {
    const fileName = ROOT_FILE_BY_AGENT[agent];
    if (recentlyWritten.has(fileName)) continue; // plan §4a: skip add-agent's just-written file
    const filePath = resolve(cwd, fileName);
    // FORGE-208: a symlinked root file (e.g. CLAUDE.md → AGENTS.md) is
    // skipped with a notice, NOT rewritten — writeAtomic's rename would
    // destroy the link and materialize divergent content. The target (if
    // it's another enabled agent's real root file) is still refreshed by
    // its own loop iteration. Never enters `changed`; notice is identical
    // in dry-run and real mode.
    if (isSymlinkAt(filePath)) {
      // FORGE-209-(4): pass the enabled set + cwd so the notice states whether
      // the link's immediate target is actually managed by an enabled host.
      notices.push(
        symlinkSkipNotice(fileName, filePath, settings.agents.enabled_root_files, cwd),
      );
      continue;
    }
    // FORGE-209-(5): a hard-linked root file (nlink > 1) is skipped with a notice
    // here — a PRECHECK that mirrors the isSymlinkAt precheck above. Without it,
    // writeAtomic's HARDLINK_TARGET_REFUSED would hard-throw AFTER CONTEXT.md /
    // .version were already written this run, leaving a partial upgrade. Never
    // enters `changed`; notice identical in dry-run and real mode.
    if (isHardlinkAt(filePath)) {
      notices.push(hardlinkSkipNotice(fileName));
      continue;
    }
    // FORGE-160: cursor's `.cursor/rules/forge-context.mdc` is forge-owned and
    // MATERIALIZE_WHEN_ENABLED — created here when absent (other hosts keep
    // skip-if-missing because their root file is product-owned). The cursor
    // write path ALWAYS routes through the frontmatter-first wrapper; the
    // generic replacePrefixBlock is never invoked for cursor (it would put the
    // marker block above the required .mdc frontmatter).
    if (agent === 'cursor') {
      // FORGE-208 (one level up): a symlinked PARENT (.cursor or .cursor/rules)
      // would be followed by the mkdirSync/writeAtomic below, escaping the
      // working tree. Skip with a notice — consistent with the leaf-symlink
      // skip policy above. Checked before existsSync so a write through the link
      // is never even contemplated. The leaf itself is still guarded by the
      // isSymlinkAt(filePath) check earlier in this loop body.
      const symlinkedParent = firstSymlinkedParent(cwd, fileName);
      if (symlinkedParent !== null) {
        notices.push(symlinkParentSkipNotice(fileName, symlinkedParent, cwd));
        continue;
      }
      const exists = existsSync(filePath);
      if (!exists && !MATERIALIZE_WHEN_ENABLED.cursor) continue;
      const desiredBlock = buildCursorBlock({ repoUrl: FORGE_REPO_URL }, desiredContext);
      const updated = exists
        ? writeCursorRuleBody(readFileSync(filePath, 'utf8'), desiredBlock)
        : buildCursorRuleFile({ repoUrl: FORGE_REPO_URL }, desiredContext);
      const prior = exists ? readFileSync(filePath, 'utf8') : '';
      if (updated !== prior) {
        if (!opts.dryRun) {
          mkdirSync(dirname(filePath), { recursive: true });
          writeAtomic(filePath, updated);
        }
        changed.push(fileName);
      }
      continue;
    }
    if (!existsSync(filePath)) continue;
    const fileContents = readFileSync(filePath, 'utf8');
    const desiredPrefix = buildPrefixBlock(agent, { repoUrl: FORGE_REPO_URL });
    const updated = replacePrefixBlock(fileContents, desiredPrefix);
    if (updated !== fileContents) {
      if (!opts.dryRun) writeAtomic(filePath, updated);
      changed.push(fileName);
    }
  }

  // 8. Refresh .gitignore marker block.
  // FORGE-208: same skip + notice as the root-file loop when .gitignore is a
  // symlink — exit 0, link intact, never enters `changed`.
  if (isSymlinkAt(gitignorePath)) {
    notices.push(symlinkSkipNotice('.gitignore', gitignorePath));
  } else if (isHardlinkAt(gitignorePath)) {
    // FORGE-209-(5): hardlink precheck mirroring the symlink precheck above —
    // skip with a notice rather than let writeAtomic hard-throw mid-upgrade.
    notices.push(hardlinkSkipNotice('.gitignore'));
  } else {
    const currentGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    const desiredGitignore = applyGitignoreBlock(currentGitignore);
    if (desiredGitignore !== currentGitignore) {
      if (!opts.dryRun) writeAtomic(gitignorePath, desiredGitignore);
      changed.push('.gitignore');
    }
  }

  // 9. Refresh per-host skill + agent farm (FORGE-156). Each enabled host
  //    gets pointers to the bundled skills/<name>/ and agents/<name>.md so
  //    the host's slash-command / subagent discovery resolves in this project.
  //    Idempotent: existing-and-correct entries are left alone; mismatches
  //    are backed up to `.bak` and replaced. dryRun is passed through so
  //    --dry-run still surfaces the would-be created entries (Codex review).
  const farm = applySkillFarm({
    cwd,
    packageRoot: locatePackageRoot(),
    enabledAgents: settings.agents.enabled_root_files,
    dryRun: opts.dryRun,
  });
  for (const p of farm.created) changed.push(relativeFromCwd(cwd, p));
  for (const p of farm.refreshed) changed.push(relativeFromCwd(cwd, p));
  // Stale farm symlinks pruned because their skill/agent left the bundle.
  for (const p of farm.pruned) changed.push(p);
  // FORGE-160: surface symlink-guard skips (a host's farm dir was a symlink).
  for (const n of farm.notices) notices.push(n);

  // 10. FORGE-158: refresh .forge/manifest.json so `forge eject` has an
  //     up-to-date record. Preserves install-time truth (ignoreFiles + each
  //     root file's forgeCreated flag) from the prior manifest; recomputes the
  //     rest. recentlyWritten holds any root file --add-agent just created.
  //
  //     Idempotency: only write when the manifest actually changes. And never
  //     CREATE a missing manifest on an otherwise-clean run — that would turn a
  //     no-op upgrade of a pre-manifest repo into a write. A missing manifest is
  //     materialized the next time upgrade changes something (or by init); eject
  //     handles its absence via the legacy fallback.
  const priorManifest = readManifest(cwd);
  const desiredManifest = refreshManifest(priorManifest, {
    cwd,
    forgeVersion: bundledVersion,
    enabledHosts: settings.agents.enabled_root_files,
    farmEntries: farmEntriesFromResult(cwd, farm),
    createdRootFiles: [...recentlyWritten],
  });
  const manifestDiffers =
    priorManifest === null
      ? changed.length > 0
      : JSON.stringify(priorManifest) !== JSON.stringify(desiredManifest);
  if (manifestDiffers) {
    if (!opts.dryRun) writeManifest(cwd, desiredManifest);
    changed.push(MANIFEST_RELPATH);
  }

  // 11. FORGE-161: stamp the tracked methodology_version pin. COMMENT-PRESERVING
  //     surgical edit via a YAML Document setIn — NOT the wholesale
  //     yamlStringify rewrite the add/remove-agent path uses (that nukes
  //     adopter comments). It re-reads the on-disk file so it composes over any
  //     prior add/remove-agent rewrite (neither write clobbers the other).
  //
  //     ORDERING (GPT-5.5 review F3): this is the LAST settings mutation, placed
  //     AFTER every refusal / early-exit path (the edited-CONTEXT.md exit-1
  //     refusal, exit-4 downgrade guard, add/remove-agent refusals). Stamping
  //     the pin earlier let an upgrade that ultimately exits 1 still mutate
  //     settings.yaml — violating the refusal/no-write contract. Now the pin
  //     only fires on the success path. Dry-run reports the would-be change
  //     without writing; `changed` includes the path only when the pin differs.
  {
    const onDiskSettings = readFileSync(settingsPath, 'utf8');
    const doc = parseDocument(onDiskSettings);
    const currentPin = doc.get('methodology_version');
    if (currentPin !== bundledVersion) {
      doc.setIn(['methodology_version'], bundledVersion);
      const updatedSettings = doc.toString({ lineWidth: 0 });
      if (updatedSettings !== onDiskSettings) {
        if (!opts.dryRun) writeAtomic(settingsPath, updatedSettings);
        if (!changed.includes('.forge/settings.yaml')) changed.push('.forge/settings.yaml');
      }
    }
  }

  // 12. FORGE-197: display-only `statusLine` host integration. OPT-IN ONLY —
  //     gated on `settings.hosts.claude.status_line === true` (the consent). This
  //     is the ONLY thing Forge writes into the user's GLOBAL ~/.claude config,
  //     so the gate is absolute: when the flag is FALSE we NEVER write — instead
  //     a one-line DISCOVERY notice offers the integration (FORGE_QUIET-
  //     suppressible). The writer itself is non-clobbering + symlink-guarded +
  //     plain-object-guarded (see host-config.ts) and respects dryRun.
  let discoveryNotice: string | undefined;
  if (validated.hosts.claude.status_line) {
    const res = writeStatusLineConfig({
      ...(opts.hostConfigHomeDir !== undefined ? { homeDir: opts.hostConfigHomeDir } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    // The global ~/.claude/settings.json is OUTSIDE the working tree, so it is
    // not a repo-relative `changed` path; surface every outcome as a notice.
    // (Skip outcomes — symlink/clobber/corrupt — are reported too so the user
    // knows the opt-in did not take effect.)
    notices.push(res.notice);
  } else if (process.env.FORGE_QUIET !== '1') {
    // Off → a one-line DISCOVERY notice offering the integration. Deterministic
    // (NOT gated on changed) so it is idempotent, and kept OUT of `stderr`
    // (see UpgradeResult.discoveryNotice) so it never pollutes the structured,
    // pinned stderr contract. FORGE_QUIET-suppressible.
    discoveryNotice =
      'forge: set hosts.claude.status_line: true in .forge/settings.yaml to show a parked-decision badge in Claude Code.';
  }

  return {
    exitCode: 0,
    filesChanged: changed,
    stderr: notices.join('\n'),
    ...(discoveryNotice !== undefined ? { discoveryNotice } : {}),
  };
}

/** Render a path relative to cwd for the filesChanged report — keeps the
 * report readable rather than dumping absolute /Users/... paths. */
function relativeFromCwd(cwd: string, abs: string): string {
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
}

/** B4: --add-agent. Idempotent. Returns a refusal result on schema violation, else null. */
function applyAddAgent(
  opts: UpgradeOptions,
  settings: SettingsYaml,
  cwd: string,
  recentlyWritten: Set<string>,
  changed: string[],
): UpgradeResult | null {
  const agent = opts.addAgent!;

  // FORGE-208: hard refusal (exit 1) when the requested agent's root file is
  // a symlink — this is an explicit user request targeting that file, so a
  // silent skip would be lying about what was done. Checked BEFORE the
  // in-memory settings mutation so nothing is written on refusal.
  const addFileName = ROOT_FILE_BY_AGENT[agent];
  const addFilePath = resolve(cwd, addFileName);
  if (isSymlinkAt(addFilePath)) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: `forge upgrade --add-agent: ${addFileName} is a symbolic link. Refusing — writing through it would destroy the link and materialize a divergent regular file. Resolve the symlink or replace with a regular file first.`,
    };
  }
  // FORGE-209-(5): an explicit --add-agent targeting a hard-linked root file is a
  // HARD refusal too (mirrors the symlink refusal above) — a silent skip would
  // lie about what was done, and writeAtomic would detach the link.
  if (isHardlinkAt(addFilePath)) {
    return {
      exitCode: 1,
      filesChanged: [],
      stderr: `forge upgrade --add-agent: ${addFileName} is a hard link (nlink > 1). Refusing — writing through it would detach this link and leave the other link(s) pointing at the old content. Replace it with a regular file first.`,
    };
  }

  let settingsTouched = false;

  if (!settings.agents.enabled_root_files.includes(agent)) {
    settings.agents.enabled_root_files.push(agent);
    settingsTouched = true;
  }

  const fileName = ROOT_FILE_BY_AGENT[agent];
  const filePath = resolve(cwd, fileName);

  // FORGE-160: cursor's artifact inlines the rendered methodology context, which
  // is not yet computed at this point in upgrade() (step 3 vs step 4). Rather
  // than recompute it here, DON'T write the cursor file in add-agent and DON'T
  // mark it recentlyWritten — the refresh loop (step 7) materializes it with the
  // inlined context because cursor is MATERIALIZE_WHEN_ENABLED. The settings
  // mutation below still records cursor in enabled_root_files.
  if (agent !== 'cursor' && !existsSync(filePath)) {
    // Write a fresh root file with ONLY the marker prefix block. User adds
    // product content below as needed. Keeping the body empty means a future
    // --remove-agent can run without requiring --confirm (per plan §4b
    // semantics: refusal is body-non-empty, not file-exists).
    const prefix = buildPrefixBlock(agent, { repoUrl: FORGE_REPO_URL });
    if (!opts.dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeAtomic(filePath, prefix);
    }
    changed.push(fileName);
    recentlyWritten.add(fileName);
  }

  if (settingsTouched) {
    if (!opts.dryRun) {
      // FORGE-208: a symlinked settings.yaml was already refused upfront in
      // step 0; if one is swapped in during the TOCTOU window, writeAtomic's
      // preflight throws FsWriteError, which propagates loudly (exit 1 via
      // the bin/forge.ts catch) — the required hard-refusal behavior.
      writeAtomic(resolve(cwd, '.forge/settings.yaml'), yamlStringify(settings, { lineWidth: 0 }));
    }
    changed.push('.forge/settings.yaml');
  }

  return null;
}

/** B5: --remove-agent. Refuses to remove primary_host_cli or to drop below 1 enabled file. */
function applyRemoveAgent(
  opts: UpgradeOptions,
  settings: SettingsYaml,
  cwd: string,
  changed: string[],
  notices: string[],
): UpgradeResult | null {
  const agent = opts.removeAgent!;

  if (agent === settings.agents.primary_host_cli) {
    return {
      exitCode: 1,
      filesChanged: changed,
      stderr: `forge upgrade --remove-agent: refusing — ${agent} is primary_host_cli. Change primary_host_cli in .forge/settings.yaml first.`,
    };
  }

  if (!settings.agents.enabled_root_files.includes(agent)) {
    // No-op: agent not enabled. Return null so the rest of upgrade() runs as a refresh.
    return null;
  }

  // Plan §4b: refuse if removal would drop enabled_root_files below 1.
  if (settings.agents.enabled_root_files.length <= 1) {
    return {
      exitCode: 1,
      filesChanged: changed,
      stderr: `forge upgrade --remove-agent: refusing — would leave enabled_root_files empty (schema requires at least one entry).`,
    };
  }

  const fileName = ROOT_FILE_BY_AGENT[agent];
  const filePath = resolve(cwd, fileName);

  // FORGE-160 (round 2): a NESTED forge artifact (cursor's
  // `.cursor/rules/forge-context.mdc`) can have a symlinked PARENT directory
  // (`.cursor` or `.cursor/rules`). The leaf check below sees a regular file
  // (the symlink TARGET's file), so unlinkSync would reach THROUGH the link and
  // delete a file outside the working tree. Guard the parent BEFORE the leaf
  // check and before any file mutation: skip the deletion with a notice (the
  // .pre-removal.bak would also snapshot through the link), then fall through so
  // the agent is still removed from enabled_root_files + its farm pruned. Same
  // skip-don't-refuse policy and dry-run parity as the refresh write path.
  const symlinkedParent = firstSymlinkedParent(cwd, fileName);
  if (symlinkedParent !== null) {
    notices.push(symlinkParentSkipNotice(fileName, symlinkedParent, cwd));
  } else if (isSymlinkAt(filePath)) {
    // FORGE-208: hard refusal (exit 1) when the root file itself is a symlink —
    // the unlinkSync below would destroy the parity link (and a .pre-removal.bak
    // would snapshot the TARGET's content, not the link). Same message style
    // as --add-agent. Checked before any settings/file mutation.
    return {
      exitCode: 1,
      filesChanged: changed,
      stderr: `forge upgrade --remove-agent: ${fileName} is a symbolic link. Refusing — removing it would destroy the link. Resolve the symlink or replace with a regular file first.`,
    };
  } else if (existsSync(filePath)) {
    const contents = readFileSync(filePath, 'utf8');
    // FORGE-160: cursor's `.mdc` is fully forge-owned (frontmatter + marker
    // block, gitignored, no user content). Treat its body as empty so removal
    // never requires --confirm — the frontmatter is forge's, not the user's.
    const userBody = agent === 'cursor' ? '' : bodyWithoutPrefixBlock(contents).trim();
    if (userBody.length > 0 && !opts.confirm) {
      return {
        exitCode: 1,
        filesChanged: changed,
        stderr: [
          `forge upgrade --remove-agent: ${fileName} has user content below the marker block.`,
          `Re-run with --confirm to remove (a backup will be saved as ${fileName}.pre-removal.bak).`,
        ].join('\n'),
      };
    }
    if (!opts.dryRun) {
      if (userBody.length > 0) writeFileSync(`${filePath}.pre-removal.bak`, contents);
      unlinkSync(filePath);
    }
    changed.push(fileName);
  }

  settings.agents.enabled_root_files = settings.agents.enabled_root_files.filter((a) => a !== agent);
  if (!opts.dryRun) {
    // FORGE-208: symlinked settings.yaml refused upfront in step 0; a TOCTOU
    // swap-in hits writeAtomic's preflight → FsWriteError propagates loudly.
    writeAtomic(resolve(cwd, '.forge/settings.yaml'), yamlStringify(settings, { lineWidth: 0 }));
  }
  changed.push('.forge/settings.yaml');

  // FORGE-156 follow-up (Codex review): prune the disabled host's farm
  // entries so it can no longer discover forge slash commands / subagents
  // in this project. Enumerates bundled forge entries from packageRoot and
  // deletes ONLY those specific entries — user-owned non-forge content in
  // the same `.X/skills/` or `.X/agents/` dir survives (Codex P1 review).
  const pruned = pruneHostFarm({
    cwd,
    host: agent,
    packageRoot: locatePackageRoot(),
    dryRun: opts.dryRun,
    // FORGE-160 shared-root prune safety: the agent was already filtered out of
    // enabled_root_files above; pass the SURVIVORS so a root the removed host
    // shared with a still-enabled host (e.g. cursor's `.agents/skills`) is kept.
    enabledHosts: settings.agents.enabled_root_files,
  });
  for (const p of pruned.removed) changed.push(p);
  // FORGE-160: surface symlink-guard skips (a pruned host's farm dir was a symlink).
  for (const n of pruned.notices) notices.push(n);

  return null;
}
