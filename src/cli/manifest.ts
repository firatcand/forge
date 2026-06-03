// FORGE-158: read/write `.forge/manifest.json` — forge's record of what it wrote
// into a project. Shared by `forge init` (build + write), `forge upgrade`
// (refresh), and `forge eject` (read + reverse). Kept here (not under upgrade/)
// so eject doesn't import the whole upgrade surface.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { writeAtomic } from '../core/fs-atomic.ts';
import {
  ForgeManifestSchema,
  MANIFEST_VERSION,
  SettingsSchema,
  type ForgeManifest,
  type ManifestFarmEntry,
} from '../schemas/index.ts';
import {
  ROOT_FILE_BY_AGENT,
  type AgentKind,
  type FarmMode,
} from './upgrade/index.ts';

export const MANIFEST_RELPATH = '.forge/manifest.json';

// .forge/ files forge writes at install time. eject removes .forge/ wholesale,
// so this list drives the dry-run plan + backup selection rather than deletion.
const STATIC_FORGE_FILES = [
  '.forge/CONTEXT.md',
  '.forge/.version',
  '.forge/settings.yaml',
  MANIFEST_RELPATH,
] as const;

export function manifestPath(cwd: string): string {
  return resolve(cwd, MANIFEST_RELPATH);
}

/** Parse + validate the manifest. Returns null when absent or malformed. */
export function readManifest(cwd: string): ForgeManifest | null {
  const p = manifestPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const parsed = ForgeManifestSchema.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeManifest(cwd: string, manifest: ForgeManifest): void {
  writeAtomic(manifestPath(cwd), `${JSON.stringify(manifest, null, 2)}\n`);
}

export interface BuildManifestInput {
  readonly cwd: string;
  readonly forgeVersion: string;
  readonly enabledHosts: readonly AgentKind[];
  /** Root files forge CREATED this run (did not pre-exist). */
  readonly createdRootFiles: readonly string[];
  /** Ignore-file modifications forge performed this run. */
  readonly ignoreFiles: ForgeManifest['ignoreFiles'];
  /** Exact farm entries forge materialized (path relative to cwd + mode). */
  readonly farmEntries: readonly ManifestFarmEntry[];
}

/**
 * Assemble a fresh manifest from an init run. Every root file forge wrote at
 * init is forge-created (scaffold only writes when the file did not exist).
 */
export function buildManifest(input: BuildManifestInput): ForgeManifest {
  return {
    version: MANIFEST_VERSION,
    forgeVersion: input.forgeVersion,
    enabledHosts: [...input.enabledHosts],
    rootFiles: input.createdRootFiles.map((path) => ({ path, forgeCreated: true })),
    ignoreFiles: [...input.ignoreFiles],
    farmEntries: [...input.farmEntries],
    staticPaths: [...STATIC_FORGE_FILES],
  };
}

export interface RefreshManifestInput {
  readonly cwd: string;
  readonly forgeVersion: string;
  readonly enabledHosts: readonly AgentKind[];
  readonly farmEntries: readonly ManifestFarmEntry[];
  /** Root files upgrade CREATED this run (e.g. --add-agent of a new host). */
  readonly createdRootFiles: readonly string[];
}

/**
 * Refresh the manifest during `forge upgrade`. Install-time truth that upgrade
 * cannot reconstruct from the post-install tree — `ignoreFiles` and each root
 * file's `forgeCreated` flag — is preserved from the existing manifest. The
 * recomputable fields (version, hosts, farm, static paths) are refreshed.
 *
 * Legacy fallback (no existing manifest, pre-FORGE-158 project): derive a
 * best-effort manifest. `ignoreFiles` is left empty — we cannot prove forge
 * created .gitignore or know the prior newline state, and guessing risks
 * deleting a user's file. eject's legacy path warns accordingly.
 */
export function refreshManifest(
  prior: ForgeManifest | null,
  input: RefreshManifestInput,
): ForgeManifest {
  const enabled = new Set(input.enabledHosts);
  const enabledPaths = new Set([...enabled].map((h) => ROOT_FILE_BY_AGENT[h]));

  const createdSet = new Set(input.createdRootFiles);
  const priorByPath = new Map((prior?.rootFiles ?? []).map((r) => [r.path, r]));

  const rootFiles = [...enabledPaths].map((path) => {
    const existing = priorByPath.get(path);
    if (existing) return existing;
    return { path, forgeCreated: createdSet.has(path) };
  });

  return {
    version: MANIFEST_VERSION,
    forgeVersion: input.forgeVersion,
    enabledHosts: [...input.enabledHosts],
    rootFiles,
    ignoreFiles: prior?.ignoreFiles ?? [],
    farmEntries: [...input.farmEntries],
    staticPaths: [...STATIC_FORGE_FILES],
  };
}

/**
 * Map a SkillFarmResult's bucketed absolute paths + uniform mode into manifest
 * farm entries (relative to cwd). created ∪ refreshed ∪ skipped = every entry
 * forge owns this run.
 */
export function farmEntriesFromResult(
  cwd: string,
  result: { created: readonly string[]; refreshed: readonly string[]; skipped: readonly string[]; mode: FarmMode },
): ManifestFarmEntry[] {
  // applySkillFarm canonicalizes cwd (realpathSync) before building its paths —
  // on macOS /tmp → /private/tmp — so the result paths are canonical. Relativize
  // against the canonical root so the stored paths stay relative (and eject's
  // empty-dir cleanup, which walks up to cwd, works regardless of symlinked tmp).
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = cwd;
  }
  const all = [...result.created, ...result.refreshed, ...result.skipped];
  // Sort by path: the created/refreshed/skipped split shifts between runs (a
  // freshly-added host's entries are 'created' once, then 'skipped' forever),
  // which would reorder the array and make an otherwise-identical manifest look
  // changed. A stable sort keeps upgrade idempotent.
  return all
    .map((abs) => ({ path: relative(root, abs), mode: result.mode }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Read enabled hosts from settings.yaml — used by eject's legacy fallback. */
export function readEnabledHostsFromSettings(cwd: string): AgentKind[] {
  const p = resolve(cwd, '.forge/settings.yaml');
  if (!existsSync(p)) return [];
  try {
    const parsed = SettingsSchema.safeParse(yamlParse(readFileSync(p, 'utf8')));
    if (!parsed.success) return [];
    return [...parsed.data.agents.enabled_root_files];
  } catch {
    return [];
  }
}
