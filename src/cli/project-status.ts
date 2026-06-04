// FORGE-159: `forge status` — read-only, agent-readable project state.
//
// One round-trip answer to "what state is this forge project in?": version
// drift, agent-root-file markers, symlink-farm provenance counts, spec
// placeholder counts, plans/tracker/secrets config. Supports `--json` (stable
// { ok, data } envelope) and a default human-readable summary.
//
// This is DISTINCT from `forge orchestrate status` (orchestrator run-state).
// That verb reports a running orchestration's worker progress; this reports
// the project's forge installation health. They share a word, not a scope.
//
// Read-only: never writes. Every section degrades independently — a missing or
// malformed input is reported as absent, never thrown.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ok } from './envelope.ts';
import { hasFlag, resolveForgeDir } from './orchestrate/flags.ts';
import { loadSettings } from '../core/settings.ts';
import {
  compareVersions,
  readBundledMethodologyVersion,
} from './upgrade/version-check.ts';
import {
  ROOT_FILE_BY_AGENT,
  bodyWithoutPrefixBlock,
  extractPrefixBlock,
  type AgentKind,
} from './upgrade/agent-root-files.ts';
import { classifyHostFarm, locatePackageRoot, type FarmProvenanceCounts } from './upgrade/skill-farm.ts';

const ALL_HOSTS: readonly AgentKind[] = ['claude', 'codex', 'gemini'];
const SPEC_FILES = ['BRIEF.md', 'PRD.md', 'SPEC.md', 'DESIGN.md'] as const;
// The only placeholder markers the templates ship today is `<!-- REQUIRED:`.
// `<!-- TODO:` is matched too for forward-compat (harmless if never present).
const PLACEHOLDER_RE = /<!--\s*(REQUIRED|TODO):/g;
// Spec/root files are untrusted input; cap reads so a pathological file can't
// blow up memory. 1 MB is far above any real BRIEF/PRD/SPEC/CLAUDE.md.
const FILE_READ_CAP_BYTES = 1024 * 1024;

interface RootFileInfo {
  readonly exists: boolean;
  readonly hasForgeMarker?: boolean;
  readonly userBodyBytes?: number;
}

interface SpecInfo {
  readonly exists: boolean;
  readonly complete?: boolean;
  readonly placeholderSectionCount?: number;
}

interface ProjectStatusData {
  readonly project: { readonly name: string; readonly managedByForge: boolean };
  readonly forgeVersion?: {
    readonly bundled: string;
    readonly onDisk: string | null;
    readonly drift: 'older' | 'newer' | null;
  };
  readonly enabledHosts?: readonly AgentKind[];
  readonly agentRootFiles?: Record<string, RootFileInfo>;
  readonly farms?: Record<string, FarmProvenanceCounts>;
  readonly specs?: Record<string, SpecInfo>;
  readonly plans?: {
    readonly 'phases.yaml': {
      readonly exists: boolean;
      readonly phaseCount: number;
      readonly taskCount: number;
    };
  };
  readonly tracker?: { readonly type: string; readonly configured: boolean };
  readonly secrets?: { readonly manager: string; readonly configured: boolean };
  /** Present only when settings.yaml exists but failed to load/parse. */
  readonly settingsError?: string;
}

export interface ProjectStatusOptions {
  readonly cwd: string;
  readonly rest: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
}

export interface ProjectStatusResult {
  readonly exitCode: number;
}

/** Read a small text file, returning null on any error or if over the cap. */
function readCapped(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > FILE_READ_CAP_BYTES) return null;
    return raw;
  } catch {
    return null;
  }
}

function gatherForgeVersion(forgeDir: string): ProjectStatusData['forgeVersion'] {
  let bundled: string;
  try {
    bundled = readBundledMethodologyVersion();
  } catch {
    // Should never happen from an installed package; degrade rather than throw.
    return undefined;
  }
  // Honor --forge-dir for the on-disk read; checkVersionDrift assumes cwd/.forge,
  // so read .version directly here.
  const versionRaw = readCapped(join(forgeDir, '.version'));
  const onDisk = versionRaw ? versionRaw.trim() : null;
  let drift: 'older' | 'newer' | null = null;
  if (onDisk && onDisk !== bundled) {
    try {
      const cmp = compareVersions(onDisk, bundled);
      drift = cmp === 'match' ? null : cmp;
    } catch {
      // Non-semver on-disk value — report mismatch without a direction.
      drift = 'older';
    }
  }
  return { bundled, onDisk, drift };
}

function gatherAgentRootFiles(cwd: string): Record<string, RootFileInfo> {
  const out: Record<string, RootFileInfo> = {};
  for (const host of ALL_HOSTS) {
    const filename = ROOT_FILE_BY_AGENT[host];
    const contents = readCapped(resolve(cwd, filename));
    if (contents === null) {
      out[filename] = { exists: false };
      continue;
    }
    out[filename] = {
      exists: true,
      hasForgeMarker: extractPrefixBlock(contents) !== null,
      userBodyBytes: Buffer.byteLength(bodyWithoutPrefixBlock(contents), 'utf8'),
    };
  }
  return out;
}

function gatherFarms(
  cwd: string,
  hosts: readonly AgentKind[],
): Record<string, FarmProvenanceCounts> | undefined {
  let packageRoot: string;
  try {
    packageRoot = locatePackageRoot();
  } catch {
    return undefined;
  }
  const out: Record<string, FarmProvenanceCounts> = {};
  for (const host of hosts) {
    for (const kind of ['skills', 'agents'] as const) {
      out[`.${host}/${kind}/`] = classifyHostFarm({ cwd, packageRoot, host, kind });
    }
  }
  return out;
}

function gatherSpecs(cwd: string): Record<string, SpecInfo> {
  const out: Record<string, SpecInfo> = {};
  for (const name of SPEC_FILES) {
    const contents = readCapped(resolve(cwd, 'spec', name));
    if (contents === null) {
      out[name] = { exists: false };
      continue;
    }
    const placeholderSectionCount = (contents.match(PLACEHOLDER_RE) ?? []).length;
    out[name] = {
      exists: true,
      complete: placeholderSectionCount === 0,
      placeholderSectionCount,
    };
  }
  return out;
}

function gatherPlans(cwd: string): ProjectStatusData['plans'] {
  const path = resolve(cwd, 'plans', 'phases.yaml');
  const contents = readCapped(path);
  if (contents === null) {
    return { 'phases.yaml': { exists: false, phaseCount: 0, taskCount: 0 } };
  }
  let phaseCount = 0;
  let taskCount = 0;
  try {
    const parsed = parseYaml(contents) as unknown;
    const phases = (parsed as { phases?: unknown })?.phases;
    if (Array.isArray(phases)) {
      phaseCount = phases.length;
      for (const phase of phases) {
        const tasks = (phase as { tasks?: unknown })?.tasks;
        if (Array.isArray(tasks)) taskCount += tasks.length;
      }
    }
  } catch {
    // Unparseable — report exists with zero counts rather than throwing.
  }
  return { 'phases.yaml': { exists: true, phaseCount, taskCount } };
}

function gather(opts: ProjectStatusOptions): ProjectStatusData {
  const { cwd } = opts;
  const forgeDir = resolveForgeDir(opts.rest, cwd);
  const settingsPath = join(forgeDir, 'settings.yaml');
  const managedByForge = existsSync(settingsPath);

  if (!managedByForge) {
    return { project: { name: basename(resolve(cwd)), managedByForge: false } };
  }

  let settings: ReturnType<typeof loadSettings> | null = null;
  let settingsError: string | undefined;
  try {
    settings = loadSettings(settingsPath);
  } catch (e) {
    settingsError = e instanceof Error ? e.message : String(e);
  }

  const hosts = settings ? settings.agents.enabled_root_files : ALL_HOSTS;

  return {
    project: {
      name: settings?.project.name ?? basename(resolve(cwd)),
      managedByForge: true,
    },
    forgeVersion: gatherForgeVersion(forgeDir),
    enabledHosts: hosts,
    agentRootFiles: gatherAgentRootFiles(cwd),
    farms: gatherFarms(cwd, hosts),
    specs: gatherSpecs(cwd),
    plans: gatherPlans(cwd),
    ...(settings
      ? {
          tracker: { type: settings.tracker.type, configured: true },
          secrets: { manager: settings.secrets.manager, configured: true },
        }
      : {}),
    ...(settingsError ? { settingsError } : {}),
  };
}

function renderHuman(data: ProjectStatusData): string {
  const lines: string[] = [];
  const p = data.project;
  if (!p.managedByForge) {
    lines.push(`Project: ${p.name} (not forge-managed — no .forge/settings.yaml)`);
    return lines.join('\n') + '\n';
  }

  lines.push(`Project: ${p.name} (forge-managed)`);
  if (data.settingsError) {
    lines.push(`⚠ settings.yaml present but could not be loaded: ${data.settingsError}`);
  }
  if (data.forgeVersion) {
    const v = data.forgeVersion;
    const onDisk = v.onDisk ?? '(none)';
    const state = v.drift === null ? 'in sync' : `DRIFT (${v.drift})`;
    lines.push(`Forge version (bundled / on-disk): ${v.bundled} / ${onDisk} — ${state}`);
  }
  if (data.enabledHosts) {
    lines.push(`Enabled hosts: ${data.enabledHosts.join(', ')}`);
  }

  if (data.agentRootFiles) {
    lines.push('', 'Agent root files:');
    for (const [name, info] of Object.entries(data.agentRootFiles)) {
      if (!info.exists) {
        lines.push(`  ${name.padEnd(12)} —`);
      } else {
        const marker = info.hasForgeMarker ? 'forge marker' : 'no forge marker';
        lines.push(`  ${name.padEnd(12)} ✓ (${marker} + ${info.userBodyBytes} bytes user content)`);
      }
    }
  }

  if (data.farms && Object.keys(data.farms).length > 0) {
    lines.push('', 'Farms:');
    for (const [dir, c] of Object.entries(data.farms)) {
      lines.push(
        `  ${dir.padEnd(18)} ${c.forgeOwned} forge-installed, ${c.userOwned} user-owned, ${c.broken} broken`,
      );
    }
  }

  if (data.specs) {
    lines.push('', 'Specs:');
    const hint: Record<string, string> = {
      'BRIEF.md': '/forge',
      'PRD.md': '/draft-prd',
      'SPEC.md': '/draft-spec',
      'DESIGN.md': '/draft-design',
    };
    for (const [name, info] of Object.entries(data.specs)) {
      const cmd = hint[name];
      const runHint = cmd ? ` — run ${cmd}` : '';
      if (!info.exists) {
        lines.push(`  ${name.padEnd(12)} missing${runHint}`);
      } else if (info.complete) {
        lines.push(`  ${name.padEnd(12)} complete`);
      } else {
        lines.push(
          `  ${name.padEnd(12)} incomplete (${info.placeholderSectionCount} placeholder sections${runHint})`,
        );
      }
    }
  }

  if (data.plans) {
    const ph = data.plans['phases.yaml'];
    lines.push('', 'Plans:');
    if (!ph.exists) {
      lines.push('  phases.yaml   missing — run /decompose');
    } else {
      lines.push(`  phases.yaml   ${ph.phaseCount} phases / ${ph.taskCount} tasks`);
    }
  }

  if (data.tracker || data.secrets) {
    lines.push('');
    if (data.tracker) lines.push(`Tracker: ${data.tracker.type} (configured)`);
    if (data.secrets) lines.push(`Secrets: ${data.secrets.manager} (configured)`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Entry point for `forge status`. Always exits 0 (read-only diagnostic; a
 * non-forge project or a degraded section is information, not an error). The
 * envelope SHAPE is reused from envelope.ts (`ok`); the write is done against an
 * injectable stream so tests can capture output without patching process.stdout.
 */
export function runProjectStatus(opts: ProjectStatusOptions): ProjectStatusResult {
  const out = opts.stdout ?? process.stdout;
  const json = hasFlag(opts.rest, 'json');
  const data = gather(opts);
  const envelope = ok(data);
  if (json) {
    out.write(`${JSON.stringify(envelope)}\n`);
  } else {
    out.write(renderHuman(data));
  }
  return { exitCode: 0 };
}
