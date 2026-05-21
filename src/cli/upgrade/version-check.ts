import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DriftInfo {
  readonly onDisk: string;
  readonly current: string;
}

export interface CheckVersionDriftInput {
  readonly cwd: string;
  readonly currentVersion: string;
}

export type VersionComparison = 'older' | 'match' | 'newer';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function checkVersionDrift(input: CheckVersionDriftInput): DriftInfo | null {
  const path = resolve(input.cwd, '.forge/.version');
  if (!existsSync(path)) return null;
  const onDisk = readFileSync(path, 'utf8').trim();
  if (onDisk === input.currentVersion) return null;
  return { onDisk, current: input.currentVersion };
}

export function formatDriftWarning(drift: DriftInfo): string {
  return `forge: this repo's methodology is v${drift.onDisk}; your CLI bundles v${drift.current}. Run \`forge upgrade\` to refresh.`;
}

function parseSemver(v: string): readonly [number, number, number] {
  if (!SEMVER_RE.test(v)) {
    throw new Error(`forge: invalid semver in version comparison: "${v}"`);
  }
  const parts = v.split('.').map((n) => Number.parseInt(n, 10));
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function compareVersions(onDisk: string, current: string): VersionComparison {
  const [a1, a2, a3] = parseSemver(onDisk);
  const [b1, b2, b3] = parseSemver(current);
  if (a1 !== b1) return a1 > b1 ? 'newer' : 'older';
  if (a2 !== b2) return a2 > b2 ? 'newer' : 'older';
  if (a3 !== b3) return a3 > b3 ? 'newer' : 'older';
  return 'match';
}

export function formatCliTooOldRefusal(drift: DriftInfo): string {
  return [
    `forge upgrade: refusing — your CLI bundles methodology v${drift.current}, but this repo is on v${drift.onDisk}.`,
    `Running upgrade now would DOWNGRADE the repo's methodology version.`,
    `Update your CLI first: \`npm install -g @firatcand/forge\` (or your equivalent).`,
  ].join('\n');
}
