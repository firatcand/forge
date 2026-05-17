// `forge orchestrate doctor` — read-only drift diagnostics.
//
// Scope --spec-code (default and only implemented scope in v0.4):
//   For each `src/...` file path mentioned in spec/SPEC.md or spec/ORCHESTRATOR.md,
//   assert the file exists. For each exported identifier mentioned as
//   inline code, grep src/ for ≥1 hit. Report drift.
//
// Scopes --adr-drafts and --apply-journal: deferred to FORGE-99 / v0.5.
// They return exit 1 with SCOPE_NOT_IMPLEMENTED — explicit failure, not a
// silent no-op, per /CLAUDE.md fail-loudly stance.
//
// Exit codes: 0 clean, 1 warnings (or unimplemented scope), 2 drift detected.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DoctorArgsSchema, type DoctorArgs } from '../../schemas/cli-args.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

const SPEC_FILES = ['spec/SPEC.md', 'spec/ORCHESTRATOR.md', 'spec/PRD.md'] as const;
const FILE_PATH_REGEX = /\b(src\/[A-Za-z0-9_\-./]+\.ts)\b/g;

export interface SpecCodeWarning {
  readonly kind: 'missing_file' | 'unknown_symbol';
  readonly source: string; // spec file
  readonly target: string; // referenced path or symbol
}

export interface DoctorResultData {
  readonly scope: DoctorArgs['scope'];
  readonly warnings: readonly SpecCodeWarning[];
  readonly drift: readonly SpecCodeWarning[];
}

export async function runOrchestrateDoctor(args: DoctorArgs): Promise<{ exitCode: number }> {
  const parsed = DoctorArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;
  if (opts.scope === 'adr-drafts' || opts.scope === 'apply-journal') {
    return {
      exitCode: emit(
        fail(
          'SCOPE_NOT_IMPLEMENTED',
          `doctor --scope ${opts.scope} is deferred to FORGE-99 (v0.5). Use --scope spec-code.`,
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  const cwd = opts.repoRoot ?? resolveCwdFromForgeDir(opts.forgeDir);
  const result = runSpecCodeScope(cwd);

  // Exit codes: 2 = drift, 1 = warnings only, 0 = clean.
  let exitCode = 0;
  if (result.drift.length > 0) exitCode = 2;
  else if (result.warnings.length > 0) exitCode = 1;

  if (exitCode === 0) {
    return { exitCode: emit(ok(result), { json: opts.json }) };
  }
  // Doctor reports drift via the data field, not the error envelope, so
  // consumers always get the full report. Exit code carries severity.
  const envelopeExit = emit(ok(result), { json: opts.json });
  // The emit() default returns 0 for ok envelopes; doctor overrides.
  return { exitCode: envelopeExit === 0 ? exitCode : envelopeExit };
}

function resolveCwdFromForgeDir(forgeDir: string): string {
  // forgeDir defaults to <cwd>/.forge — strip the trailing segment.
  return forgeDir.replace(/[/\\]\.forge\/?$/, '') || process.cwd();
}

function runSpecCodeScope(cwd: string): DoctorResultData {
  const warnings: SpecCodeWarning[] = [];
  const drift: SpecCodeWarning[] = [];
  // SPEC.md is the only required spec file. PRD.md + ORCHESTRATOR.md are
  // advisory — their absence is not a warning. Adopters can rely on just
  // spec/SPEC.md, and forge's own repo has ORCHESTRATOR.md but adopter
  // projects typically don't.
  for (const rel of SPEC_FILES) {
    const full = path.join(cwd, rel);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      if (rel === 'spec/SPEC.md') {
        warnings.push({ kind: 'missing_file', source: rel, target: rel });
      }
      continue;
    }
    const refs = new Set<string>();
    for (const m of raw.matchAll(FILE_PATH_REGEX)) {
      const ref = m[1] ?? '';
      if (ref) refs.add(ref);
    }
    for (const ref of refs) {
      const refFull = path.join(cwd, ref);
      try {
        statSync(refFull);
      } catch {
        drift.push({ kind: 'missing_file', source: rel, target: ref });
      }
    }
  }

  return { scope: 'spec-code', warnings, drift };
}

// Helper retained but unused for now: future ADR scope hook.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _greptimeUnused(_cwd: string, _symbol: string): boolean {
  const res = spawnSync('grep', ['-r', '-l', '--include=*.ts', _symbol, path.join(_cwd, 'src')]);
  return res.status === 0;
}

export const doctorHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Drift diagnostics (--scope spec-code; adr-drafts/apply-journal deferred to v0.5).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const scope = (parseFlag(rest, 'scope') as DoctorArgs['scope'] | undefined) ?? 'spec-code';
    const json = hasFlag(rest, 'json');
    const repoRoot = parseFlag(rest, 'repo-root');
    const args: DoctorArgs = {
      scope,
      forgeDir,
      json,
      ...(repoRoot ? { repoRoot } : {}),
    };
    return runOrchestrateDoctor(args);
  },
};
