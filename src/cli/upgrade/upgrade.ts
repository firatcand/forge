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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { SettingsSchema, type Settings } from '../../schemas/index.ts';
import { CLI_VERBS, SLASH_COMMANDS } from '../registry.ts';
import {
  ROOT_FILE_BY_AGENT,
  buildPrefixBlock,
  bodyWithoutPrefixBlock,
  replacePrefixBlock,
  type AgentKind,
} from './agent-root-files.ts';
import { applyGitignoreBlock } from './gitignore-block.ts';
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
}

export interface UpgradeResult {
  readonly exitCode: number;
  readonly filesChanged: readonly string[];
  readonly stderr: string;
}

const FORGE_REPO_URL = 'https://github.com/firatcand/forge';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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

  // 0. Settings must exist (design §9 exit code 3).
  if (!existsSync(settingsPath)) {
    return {
      exitCode: 3,
      filesChanged: [],
      stderr: 'forge upgrade: .forge/settings.yaml not found. Run `forge init` first.',
    };
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
  // Defensive: unused var silences typescript's "declared but never read" when
  // the validated object is only consumed to mirror enabled_root_files.
  void validated;

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
    const result = applyRemoveAgent(opts, settings, cwd, changed);
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
  const currentGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const desiredGitignore = applyGitignoreBlock(currentGitignore);
  if (desiredGitignore !== currentGitignore) {
    if (!opts.dryRun) writeAtomic(gitignorePath, desiredGitignore);
    changed.push('.gitignore');
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

  return { exitCode: 0, filesChanged: changed, stderr: '' };
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
  let settingsTouched = false;

  if (!settings.agents.enabled_root_files.includes(agent)) {
    settings.agents.enabled_root_files.push(agent);
    settingsTouched = true;
  }

  const fileName = ROOT_FILE_BY_AGENT[agent];
  const filePath = resolve(cwd, fileName);

  if (!existsSync(filePath)) {
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

  if (existsSync(filePath)) {
    const contents = readFileSync(filePath, 'utf8');
    const userBody = bodyWithoutPrefixBlock(contents).trim();
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
  });
  for (const p of pruned) changed.push(p);

  return null;
}
