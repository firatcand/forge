import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import type { ExecaLike } from './validate.ts';

export interface PreflightOptions {
  cwd: string;
  // Confirmer for overwrite + git-init prompts. Default true means "yes, overwrite/init"
  // (matches plan §6 E14 — git init default yes; per-file overwrite default false).
  confirm?: (message: string, defaultValue: boolean) => Promise<boolean>;
  // When true, no prompts are issued and existing-file overwrite is auto-declined; git init is auto-accepted.
  nonInteractive?: boolean;
  exec?: ExecaLike;
}

export type PreflightStatus =
  | { kind: 'ok'; gitInitialised: boolean; overwrite: Record<string, boolean> }
  | { kind: 'refuse-framework'; message: string }
  | { kind: 'cancelled'; reason: string };

const SCAFFOLD_PATHS = [
  '.forge/settings.yaml',
  'spec/BRIEF.md',
  'spec/PRD.md',
  'spec/SPEC.md',
  'spec/DESIGN.md',
  'CRITICAL.md',
  'CLAUDE.md',
];

function readPackageName(cwd: string): string | null {
  const p = resolve(cwd, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === 'string') return parsed.name;
    return null;
  } catch {
    return null;
  }
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightStatus> {
  const { cwd } = opts;
  const confirm = opts.confirm ?? (async (_m: string, d: boolean) => d);
  const nonInteractive = opts.nonInteractive ?? false;
  const exec = opts.exec ?? (execa as unknown as ExecaLike);

  // 1. Framework refusal.
  const pkgName = readPackageName(cwd);
  if (pkgName === '@firatcand/forge') {
    return {
      kind: 'refuse-framework',
      message: 'forge init refuses to run inside the forge framework repo. Use a different project directory.',
    };
  }

  // 2. Existing scaffold files — per-file overwrite confirmation.
  const overwrite: Record<string, boolean> = {};
  for (const rel of SCAFFOLD_PATHS) {
    const abs = resolve(cwd, rel);
    if (!existsSync(abs)) continue;
    if (nonInteractive) {
      overwrite[rel] = false;
      continue;
    }
    const yes = await confirm(`${rel} already exists — overwrite?`, false);
    overwrite[rel] = yes;
  }

  // settings.yaml is the marker — if user declined overwrite, init is cancelled (refusing without re-confirm per E3).
  if (existsSync(resolve(cwd, '.forge/settings.yaml')) && overwrite['.forge/settings.yaml'] === false) {
    return {
      kind: 'cancelled',
      reason: '.forge/settings.yaml exists and user declined to overwrite. Re-run with confirmation to proceed.',
    };
  }

  // 3. Git presence — offer `git init` if missing.
  let gitInitialised = existsSync(resolve(cwd, '.git'));
  if (!gitInitialised) {
    const yes = nonInteractive ? true : await confirm('No .git directory — run `git init`?', true);
    if (yes) {
      const r = await exec('git', ['init'], { timeout: 10_000, reject: false, cwd });
      if (r.exitCode !== 0) {
        return {
          kind: 'cancelled',
          reason: `git init exited ${r.exitCode}; aborting. stderr: ${r.stderr}`,
        };
      }
      gitInitialised = true;
    }
  }

  return { kind: 'ok', gitInitialised, overwrite };
}
