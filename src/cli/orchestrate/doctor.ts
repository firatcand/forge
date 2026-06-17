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

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';

import { DoctorArgsSchema, type DoctorArgs } from '../../schemas/cli-args.ts';
import { loadSettings } from '../../core/settings.ts';
import { detectSpecCodeDrift, type SpecCodeDriftReport } from '../../orchestrator/drift.ts';
import { resolveDiffPaths } from '../../docs-coverage/git-diff.ts';
import { coverageReport, type CoverageReport } from '../../docs-coverage/report.ts';
import type { DocsCoverage } from '../../schemas/settings.ts';
import {
  computeAvailability,
  defaultAvailabilityDeps,
  type HostAvailability,
} from '../../orchestrator/availability.ts';
import { HOSTS, type Host } from '../../schemas/hosts.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// FORGE-150: typed doctor settings warnings. NOT bare strings pushed into the
// drift list — each entry carries a stable `kind` + message so JSON consumers
// can branch on it. `drift` stays reserved for spec↔code path drift.
export interface DoctorSettingsWarning {
  readonly kind: 'legacy-codex-settings';
  readonly message: string;
}

// The doctor report = the pure spec-code report PLUS doctor-owned settings
// warnings. Spreading the spec-code report preserves `scope`/`warnings`/`drift`
// (so the `drift: []` gate and existing JSON consumers are unaffected) and adds
// the new typed channel.
export interface DoctorReport extends SpecCodeDriftReport {
  readonly settingsWarnings: readonly DoctorSettingsWarning[];
}

// FORGE-205: the `--scope docs` envelope payload. NON-BLOCKING — it lives in
// `data.docsCoverage` and contributes 0 to severity (docs gaps NEVER change the
// exit code). It is emitted ONLY under `--scope docs`; the spec-code and `all`
// paths never carry it (preserving the all≡spec-code data-equality contract).
export interface DocsCoverageReport {
  readonly scope: 'docs';
  readonly docsCoverage: CoverageReport;
  readonly warnings: readonly string[];
  // null when docs-coverage is disabled via settings.docs_coverage.enabled.
  readonly note: string | null;
}

// `--scope hosts`: the host-reachability preflight payload. NON-BLOCKING — a
// gated/missing host is informational (reasons, not an error) and contributes 0
// to the exit code. Emitted ONLY under `--scope hosts`.
export interface HostReachabilityReport {
  readonly scope: 'hosts';
  readonly hosts: Record<Host, HostAvailability>;
  readonly warnings: readonly string[];
}

// Legacy scope strings that adopters may still type from v0.3.x scripts or
// shell history. Pre-parse rejects them with a v0.5-pointing message before
// Zod's enum check produces a generic "Invalid enum value" error.
const DEPRECATED_SCOPES = new Set(['adr-drafts', 'apply-journal']);

// FORGE-205 (B2): hand-mirrored defaults for `settings.docs_coverage`. Mirrors
// AUDIT_DEFAULTS in audit.ts — `loadSettings` THROWS on a missing/invalid
// settings.yaml (version/project/tracker/secrets are required), so a docs run
// in an uninitialized/adopter repo would crash. We degrade to these defaults +
// a warning instead. Kept byte-aligned with DocsCoverageSchema's defaults in
// src/schemas/settings.ts.
const DOCS_COVERAGE_DEFAULTS: DocsCoverage = {
  enabled: true,
  categories: {
    Contract: { trigger: ['src/schemas/**', 'src/cli/**'], satisfy: ['spec/SPEC.md', 'CHANGELOG.md', 'README.md'] },
    Operator: { trigger: ['src/cli/init/**', 'src/trackers/**', '**/*settings*.ts'], satisfy: ['README.md', 'docs/**'] },
    Walkthrough: { trigger: ['spec/PRD.md'], satisfy: ['docs/**', 'README.md'] },
    Rationale: { trigger: ['spec/decisions/**'], satisfy: ['spec/decisions/**', 'spec/SPEC.md'] },
    FieldNote: { trigger: [], satisfy: ['docs/learnings/**'] },
  },
};

interface DocsCoverageConfig {
  readonly config: DocsCoverage;
  readonly warnings: readonly string[];
}

// FORGE-205 (B2): best-effort docs-coverage config load. On ANY error fall back
// to DOCS_COVERAGE_DEFAULTS + a warning, mirroring audit.ts loadAuditConfig.
function loadDocsCoverageConfig(forgeDir: string): DocsCoverageConfig {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return { config: settings.docs_coverage, warnings: [] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      config: DOCS_COVERAGE_DEFAULTS,
      warnings: [`settings.yaml unavailable (${reason}); using docs-coverage defaults.`],
    };
  }
}

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

  // FORGE-205 (B1): handle `--scope docs` at the TOP — BEFORE the
  // spec_code_check_enabled short-circuit. docs-coverage has its own enable
  // toggle (settings.docs_coverage.enabled, default true); disabling spec-code
  // drift must NOT silently kill docs-coverage. This path is NON-BLOCKING and
  // ALWAYS exits 0 (gaps never raise the exit code), and it does NOT touch the
  // spec-code/all envelope shape (preserving the all≡spec-code contract).
  if (opts.scope === 'docs') {
    return { exitCode: runDocsCoverage(opts) };
  }

  // Host-reachability preflight. NON-BLOCKING — ALWAYS exits 0 (a gated/missing
  // host is a reason, not drift). Probes bin --version + env + file-exists only;
  // never a paid call. Separate envelope shape; preserves the all≡spec-code
  // contract by living entirely outside the spec-code path.
  if (opts.scope === 'hosts') {
    return { exitCode: await runHostReachability(opts) };
  }

  // (2) Best-effort settings load. Missing/unreadable → defaults apply
  // (check runs). Adopter projects that haven't run `forge init` may not
  // have a settings.yaml yet — doctor must not refuse to run.
  const specCodeEnabled = readSpecCodeCheckEnabled(opts.forgeDir);

  // FORGE-150: typed legacy-codex settings warning. Computed for every scope so
  // the `--scope all` ≡ `--scope spec-code` data-equality contract holds.
  const settingsWarnings = detectLegacyCodexWarning(opts.forgeDir);

  // (3) Feature flag short-circuit. Adopter opted out of spec-code drift;
  // return an empty report (exit 0) so CI gates don't trip.
  if (!specCodeEnabled) {
    const emptyReport: DoctorReport = {
      scope: 'spec-code',
      warnings: [],
      drift: [],
      settingsWarnings,
    };
    return { exitCode: emit(ok(emptyReport), { json: opts.json }) };
  }

  // (4) Repo-root resolution stays in the CLI layer (env-dependent fallback).
  // RepoRoot convention mirrors guardrail-check.ts:146 / spec-diff.ts: dirname(forgeDir).
  // The regex-based resolver that shipped in the FORGE-96 scaffold would
  // silently fall through to process.cwd() if forgeDir contained '.forge'
  // mid-path (e.g. /tmp/my.forgedir); path.dirname has no such edge case.
  const repoRoot = opts.repoRoot ?? path.dirname(opts.forgeDir);

  // (5) Pure drift detection. FORGE-131: thread the adopter's symbol allowlist
  // (settings.doctor.symbol_allowlist) into the symbol-mention check.
  const symbolAllowlist = readSymbolAllowlist(opts.forgeDir);
  const specResult = detectSpecCodeDrift({ repoRoot, symbolAllowlist });
  const result: DoctorReport = { ...specResult, settingsWarnings };

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

// FORGE-205: `--scope docs` handler. Read-only, NON-BLOCKING — ALWAYS returns
// exit 0. Resolves the diff (best-effort git; every failure → warning + empty),
// runs the pure coverageReport, and emits an `ok` envelope with the report in
// `data.docsCoverage`. Disabled (settings.docs_coverage.enabled === false) →
// an empty report + a note, still exit 0.
function runDocsCoverage(opts: DoctorArgs): number {
  const { config, warnings: cfgWarnings } = loadDocsCoverageConfig(opts.forgeDir);
  // RepoRoot convention mirrors the spec-code path (path.dirname(forgeDir)).
  const repoRoot = opts.repoRoot ?? path.dirname(opts.forgeDir);

  if (config.enabled === false) {
    const report: DocsCoverageReport = {
      scope: 'docs',
      docsCoverage: { required: [], satisfied: [], gaps: [], warnings: [] },
      warnings: [...cfgWarnings],
      note: 'docs-coverage is disabled (settings.docs_coverage.enabled = false).',
    };
    return emit(ok(report), { json: opts.json });
  }

  const { paths, warnings: diffWarnings } = resolveDiffPaths({
    repoRoot,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
  });
  const coverage = coverageReport({ diffPaths: paths, repoRoot, config });

  const report: DocsCoverageReport = {
    scope: 'docs',
    docsCoverage: coverage,
    warnings: [...cfgWarnings, ...diffWarnings],
    note: null,
  };
  // NON-BLOCKING: emit() returns 0 for ok envelopes; docs gaps never override it.
  return emit(ok(report), { json: opts.json });
}

// `--scope hosts` handler. Read-only, NON-BLOCKING — ALWAYS returns exit 0.
// Probes every host's reachability via the shared `computeAvailability` preflight
// (the same primitive the orchestrator dispatch path relies on) and emits the
// per-host availability set. Best-effort settings load: a missing/unreadable
// settings.yaml falls back to cursor beta opt-in = false + a warning.
async function runHostReachability(opts: DoctorArgs): Promise<number> {
  let betaOptIn = false;
  const warnings: string[] = [];
  try {
    const settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
    betaOptIn = settings.agents.cursor_host_beta_opt_in;
  } catch {
    warnings.push('settings.yaml missing/unreadable — assuming cursor_host_beta_opt_in=false.');
  }

  const hosts = await computeAvailability(HOSTS, defaultAvailabilityDeps(betaOptIn));
  const report: HostReachabilityReport = { scope: 'hosts', hosts, warnings };
  // NON-BLOCKING: gated/missing hosts never raise the exit code.
  return emit(ok(report), { json: opts.json });
}

// FORGE-150: warn when settings.yaml carries a legacy `codex` block WITHOUT a
// `second_opinion` block. Best-effort + hardened (lstat first, size-bound the
// read, typeof-checked); absent/unreadable/symlinked → no warning. Reads the
// RAW YAML (not the schema-parsed Settings) because the parsed `second_opinion`
// block always materializes via its schema default, which would mask whether
// the file actually contains it.
const SETTINGS_READ_MAX_BYTES = 256 * 1024;
function detectLegacyCodexWarning(forgeDir: string): DoctorSettingsWarning[] {
  try {
    const settingsPath = path.join(forgeDir, 'settings.yaml');
    const st = lstatSync(settingsPath);
    if (st.isSymbolicLink() || !st.isFile()) return [];
    if (st.size > SETTINGS_READ_MAX_BYTES) return [];
    const parsed = yamlParse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return [];
    const obj = parsed as Record<string, unknown>;
    const hasCodex = Object.prototype.hasOwnProperty.call(obj, 'codex');
    const hasSecondOpinion = Object.prototype.hasOwnProperty.call(obj, 'second_opinion');
    if (hasCodex && !hasSecondOpinion) {
      return [
        {
          kind: 'legacy-codex-settings',
          message:
            'legacy codex.* settings — run `forge migrate` (mirrored for compatibility; removal in v0.6).',
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
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

// FORGE-131: best-effort read of settings.doctor.symbol_allowlist. Missing /
// unreadable / invalid settings → empty extension (BASE_SYMBOL_ALLOWLIST still
// applies inside detectSpecCodeDrift).
function readSymbolAllowlist(forgeDir: string): readonly string[] {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.doctor.symbol_allowlist;
  } catch {
    return [];
  }
}

export const doctorHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Drift diagnostics (--scope spec-code|all; docs; hosts — non-blocking per-host reachability preflight).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const rawScope = parseFlag(rest, 'scope');
    const json = hasFlag(rest, 'json');
    const repoRoot = parseFlag(rest, 'repo-root');
    // FORGE-205: --base selects the docs-coverage diff base (docs scope only).
    const base = parseFlag(rest, 'base');
    // Pass scope through verbatim (not narrowed) so the pre-parse layer can
    // recognize deprecated values; runOrchestrateDoctor handles both the
    // legacy-string case and the Zod-narrowed case below.
    const args = {
      scope: rawScope ?? 'spec-code',
      forgeDir,
      json,
      ...(repoRoot ? { repoRoot } : {}),
      ...(base ? { base } : {}),
    } as DoctorArgs;
    return runOrchestrateDoctor(args);
  },
};
