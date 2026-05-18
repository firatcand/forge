// `forge orchestrate doctor` — read-only drift diagnostics (v0.4).
//
// v0.4 scope: file-path drift only — for each `src/...ts` path mentioned in
// spec/SPEC.md, spec/PRD.md, or spec/ORCHESTRATOR.md, assert the file exists.
// Exported-name / symbol grep is deferred to v0.5 (spec/SPEC.md §21).
//
// Scopes:
//   --scope spec-code (default): file-path drift check
//   --scope all              : alias for spec-code in v0.4; reserved for v0.5
//
// Deprecated scopes (--scope adr-drafts | --scope apply-journal) were dropped
// in v0.4 per the 2026-05-17 PM pivot. They get a pre-parse custom INVALID_ARGS
// pointing adopters at v0.5 before Zod's generic .enum() error fires.
//
// Settings: honors `settings.doctor.spec_code_check_enabled` (default true).
// false → short-circuit with empty drift report and exit 0. Missing/unreadable
// settings.yaml → defaults apply (check runs).
//
// Exit codes: 0 clean, 1 warnings (e.g. required SPEC.md missing), 2 drift detected.

import path from 'node:path';

import { DoctorArgsSchema, type DoctorArgs } from '../../schemas/cli-args.ts';
import { loadSettings } from '../../core/settings.ts';
import { detectSpecCodeDrift, type SpecCodeDriftReport } from '../../orchestrator/drift.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// Legacy scope strings that adopters may still type from v0.3.x scripts or
// shell history. Pre-parse rejects them with a v0.5-pointing message before
// Zod's enum check produces a generic "Invalid enum value" error.
const DEPRECATED_SCOPES = new Set(['adr-drafts', 'apply-journal']);

export async function runOrchestrateDoctor(args: DoctorArgs): Promise<{ exitCode: number }> {
  // (1) Pre-parse deprecated scopes — emit a tailored error before Zod sees
  // the value and produces a generic enum-validation message. Adopters get a
  // pointer to the v0.5 deferral instead of a wall of zod text.
  const rawScope = (args as { scope?: unknown }).scope;
  if (typeof rawScope === 'string' && DEPRECATED_SCOPES.has(rawScope)) {
    return {
      exitCode: emit(
        fail(
          'INVALID_ARGS',
          `--scope ${rawScope} was dropped in v0.4 (see spec/SPEC.md §21). ` +
            `Use --scope spec-code (or --scope all). Deferred to v0.5.`,
          false,
        ),
        { json: Boolean((args as { json?: unknown }).json) },
      ),
    };
  }

  const parsed = DoctorArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // (2) Best-effort settings load. Missing/unreadable → defaults apply
  // (check runs). Adopter projects that haven't run `forge init` may not
  // have a settings.yaml yet — doctor must not refuse to run.
  const specCodeEnabled = readSpecCodeCheckEnabled(opts.forgeDir);

  // (3) Feature flag short-circuit. Adopter opted out of spec-code drift;
  // return an empty report (exit 0) so CI gates don't trip.
  if (!specCodeEnabled) {
    const emptyReport: SpecCodeDriftReport = { scope: 'spec-code', warnings: [], drift: [] };
    return { exitCode: emit(ok(emptyReport), { json: opts.json }) };
  }

  // (4) Repo-root resolution stays in the CLI layer (env-dependent fallback).
  // RepoRoot convention mirrors guardrail-check.ts:146 / spec-diff.ts: dirname(forgeDir).
  // The regex-based resolver that shipped in the FORGE-96 scaffold would
  // silently fall through to process.cwd() if forgeDir contained '.forge'
  // mid-path (e.g. /tmp/my.forgedir); path.dirname has no such edge case.
  const repoRoot = opts.repoRoot ?? path.dirname(opts.forgeDir);

  // (5) Pure drift detection.
  const result = detectSpecCodeDrift({ repoRoot });

  // (6) Exit-code mapping. emit() default returns 0 for ok envelopes;
  // doctor overrides when severity > 0 so the exit code carries severity
  // even though the envelope itself reports ok (drift lives in `data`,
  // not `error`, so --json consumers always get the full report).
  let severityExit = 0;
  if (result.drift.length > 0) severityExit = 2;
  else if (result.warnings.length > 0) severityExit = 1;

  const envelopeExit = emit(ok(result), { json: opts.json });
  return { exitCode: envelopeExit === 0 ? severityExit : envelopeExit };
}

function readSpecCodeCheckEnabled(forgeDir: string): boolean {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.doctor.spec_code_check_enabled;
  } catch {
    // Missing, unreadable, or invalid settings.yaml → defaults apply.
    // The schema default for spec_code_check_enabled is true.
    return true;
  }
}

export const doctorHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Drift diagnostics (--scope spec-code|all; v0.4 file-path checks).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const rawScope = parseFlag(rest, 'scope');
    const json = hasFlag(rest, 'json');
    const repoRoot = parseFlag(rest, 'repo-root');
    // Pass scope through verbatim (not narrowed) so the pre-parse layer can
    // recognize deprecated values; runOrchestrateDoctor handles both the
    // legacy-string case and the Zod-narrowed case below.
    const args = {
      scope: rawScope ?? 'spec-code',
      forgeDir,
      json,
      ...(repoRoot ? { repoRoot } : {}),
    } as DoctorArgs;
    return runOrchestrateDoctor(args);
  },
};
