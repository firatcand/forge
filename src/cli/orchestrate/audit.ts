// FORGE-179: the `/audit` read-only core — `audit plan` + `audit collect`.
//
// `audit plan`   — reads the repo + adopter config, resolves scope + dimensions
//                  + protected globs, and RENDERS one read-only subagent prompt
//                  per (scope × dimension). Writes NOTHING.
// `audit collect`— ingests the findings the skill assembled from those subagents
//                  (`--findings-file <json>`), filters out every escaping /
//                  out-of-scope / protected / non-repo-relative finding IN CODE,
//                  and writes ONLY `.forge/audits/<ts>/work-order.{md,json}`.
//
// Band note: both verbs are 'read' — "read" means NO lease/tracker mutation, NOT
// "no filesystem writes". `collect` DOES write the audit artifacts under
// `.forge/audits/`; the band label is help/rendering metadata, not a write gate.
//
// Zero hardcoded forge paths: scope comes from `settings.audit.scope_globs` or
// auto-discovery over the real git tree; protected globs come from the adopter's
// CRITICAL.md + agents.preflight_globs + settings.audit.protected_globs. The
// only fixed paths here are the OUTPUT dir convention (`.forge/audits/`) and the
// shipped guardrails template (resolved via the package's templates dir) — both
// generic to any adopter repo, not forge-internal source paths.

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeAtomic } from '../../core/fs-atomic.ts';
import { loadSettings } from '../../core/settings.ts';
import { firstSymlinkedComponent } from '../../core/symlink-guard.ts';
import { matchAny, InvalidGlobError } from '../../orchestrator/glob-match.ts';
import { matchPreflight, resolveRepoRelative } from '../../orchestrator/preflight.ts';
import { resolveTemplatesDir } from '../init/templates.ts';
import {
  AUDIT_CLASSIFICATIONS,
  FindingSchema,
  WorkOrderSchema,
  isSafeRepoRelativePath,
  type Classification,
  type Finding,
  type WorkOrder,
} from '../../schemas/audit.ts';
import type { Audit } from '../../schemas/settings.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// (Codex cross-review B4) Untrusted-input caps for `audit collect`'s
// --findings-file (assembled from N subagents). Bound both the byte size and the
// number of findings so a hostile/runaway producer can't exhaust memory/CPU.
const MAX_FINDINGS_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_FINDINGS = 5000;

// ── Best-effort audit config (B2) ────────────────────────────────────────────
// loadSettings THROWS on a missing/invalid settings.yaml and SettingsSchema
// cannot recover from `{}` (version/project/tracker/secrets are required). So we
// degrade: on ANY load error fall back to AuditSchema defaults + an empty
// preflight/verify view, and surface a warning. `audit plan/collect` MUST run on
// a repo with no settings.yaml.
interface AuditConfig {
  readonly audit: Audit;
  readonly preflightGlobs: readonly string[];
  readonly verifyConfigured: boolean;
  // FORGE-180: the configured tracker type (linear|github|notion) so
  // `audit create-issues` can tell the skill how to file the rendered specs.
  // null when no settings.yaml / no tracker is configured.
  readonly trackerType: string | null;
  readonly warnings: readonly string[];
}

// AuditSchema is not exported from settings.ts; reconstruct its defaults by
// parsing an empty object through the same shape the SettingsSchema mounts. We
// avoid re-declaring the schema by reading it off a fully-defaulted Settings
// parse when possible, and falling back to a hand-mirrored default otherwise.
const AUDIT_DEFAULTS: Audit = {
  dimensions: [
    'dead-code',
    'duplication',
    'over-export',
    'complexity',
    'dependency-bloat',
    'stale-docs',
  ],
  max_findings_per_agent: 50,
};

function loadAuditConfig(forgeDir: string): AuditConfig {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return {
      audit: settings.audit,
      preflightGlobs: settings.agents.preflight_globs,
      verifyConfigured: settings.verify !== undefined,
      trackerType: settings.tracker.type,
      warnings: [],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      audit: AUDIT_DEFAULTS,
      preflightGlobs: [],
      verifyConfigured: false,
      trackerType: null,
      warnings: [
        `settings.yaml unavailable (${reason}); using audit defaults, no preflight globs, verify unconfigured`,
      ],
    };
  }
}

// ── Repo root resolution ─────────────────────────────────────────────────────
// resolveForgeDir does NOT resolve a relative --forge-dir, and the forge dir is
// `<repoRoot>/.forge`. Strip a trailing `.forge` segment and resolve to an
// absolute path so realpath-based containment in resolveRepoRelative is sound.
function repoRootFromForgeDir(forgeDir: string): string {
  const resolved = path.resolve(forgeDir);
  const base = path.basename(resolved);
  return base === '.forge' ? path.dirname(resolved) : resolved;
}

// ── CRITICAL.md glob parser ──────────────────────────────────────────────────
// CRITICAL.md is human MARKDOWN, so a line may be a bare glob, a list item
// (`- glob` / `* glob` / `+ glob`), a backtick-wrapped glob (`` `glob` ``), a
// header (`## ...`), or prose. We extract only GLOB-LIKE tokens: strip a leading
// list marker + surrounding backticks, then keep the token ONLY when it looks
// like a path/glob (contains `/` or `*`) AND has no inner whitespace (prose has
// spaces; a glob token does not). `#` lines and blanks are skipped. Missing file
// → empty list (not an error). (Codex cross-review NB2.)
function parseCriticalGlobs(repoRoot: string): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, 'CRITICAL.md'), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (const line of raw.split('\n')) {
    let t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    // Strip a leading markdown list marker (-, *, +) once.
    t = t.replace(/^[-*+]\s+/, '').trim();
    // Strip surrounding backticks (`glob`).
    t = t.replace(/^`+|`+$/g, '').trim();
    if (t.length === 0) continue;
    // Glob-like: a path/glob token (has `/` or `*`) with no inner whitespace.
    if (!/[/*]/.test(t)) continue; // prose / headings without a path
    if (/\s/.test(t)) continue; // prose sentence that happens to contain a slash
    globs.push(t);
  }
  return globs;
}

// ── Scope auto-discovery ─────────────────────────────────────────────────────
// Rank the repo's tracked top-level path segments by file count and take the
// code-bearing dirs. NEVER hardcode `src/` — this is a pure ranking over the
// real tree. On a non-git repo / empty tracked set, fall back to `['**']` and
// warn (rather than silently producing zero prompts).
interface ScopeResult {
  readonly scopeGlobs: readonly string[];
  readonly warnings: readonly string[];
}

function discoverScope(repoRoot: string): ScopeResult {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return {
      scopeGlobs: ['**'],
      warnings: ['scope auto-discovery: not a git repo (or git unavailable); falling back to scope ["**"]'],
    };
  }

  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const file = line.trim();
    if (file.length === 0) continue;
    const slash = file.indexOf('/');
    // Top-level files (no slash) are not a directory scope; skip for ranking.
    if (slash <= 0) continue;
    const top = file.slice(0, slash);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return {
      scopeGlobs: ['**'],
      warnings: ['scope auto-discovery: no tracked files under any top-level directory; falling back to scope ["**"]'],
    };
  }

  // Rank by descending file count; take dirs holding a meaningful share. We keep
  // the top dirs whose count is >= 10% of the largest, capped at 8, so a repo's
  // primary code dirs are covered without sweeping config/asset dirs.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]![1];
  const threshold = Math.max(1, Math.floor(top * 0.1));
  const chosen = ranked
    .filter(([, n]) => n >= threshold)
    .slice(0, 8)
    .map(([dir]) => `${dir}/**`);

  return { scopeGlobs: chosen, warnings: [] };
}

// ── Protected-glob union ─────────────────────────────────────────────────────
function resolveProtectedGlobs(repoRoot: string, cfg: AuditConfig): readonly string[] {
  const union = new Set<string>();
  for (const g of parseCriticalGlobs(repoRoot)) union.add(g);
  for (const g of cfg.audit.protected_globs ?? []) union.add(g);
  for (const g of cfg.preflightGlobs) union.add(g);
  return [...union];
}

// ── Prompt rendering ─────────────────────────────────────────────────────────
function renderSubagentPrompt(args: {
  readonly dimension: string;
  readonly scopeGlob: string;
  readonly principles: string;
  readonly protectedGlobs: readonly string[];
  readonly maxFindings: number;
}): string {
  const protectedList =
    args.protectedGlobs.length > 0
      ? args.protectedGlobs.map((g) => `  - ${g}`).join('\n')
      : '  (none configured — still treat the protected-surface CLASSES below as off-limits)';

  const classifications = AUDIT_CLASSIFICATIONS.map((c) => `  - ${c}`).join('\n');

  return [
    'You are auditing a codebase for SAFE simplification. READ-ONLY: analyze only — do NOT edit, create, move, or delete any file.',
    '',
    `Scope (audit ONLY files matching this glob): ${args.scopeGlob}`,
    `Dimension (focus this pass on): ${args.dimension}`,
    `Cap: report at most ${args.maxFindings} findings.`,
    '',
    'Protected globs — do NOT propose changes to any file matching these:',
    protectedList,
    '',
    '--- Audit principles (guardrails) ---',
    args.principles,
    '--- end principles ---',
    '',
    'Output a JSON array of findings. Each finding object MUST have exactly these keys:',
    '  file (repo-relative path), line (optional positive integer), dimension, classification,',
    '  evidence, why_safe, proposed_change, blast_radius, tests_required (optional).',
    'classification MUST be one of:',
    classifications,
    '',
    'Every finding must cite a repo-relative file path (NEVER an absolute path, NEVER a `../` escape),',
    'real evidence, why the change is safe, the proposed change, and the blast radius. If evidence is weak,',
    'classify as needs-tests-first or risky — never delete-safe. Return ONLY the JSON array.',
  ].join('\n');
}

// ── `audit plan` ─────────────────────────────────────────────────────────────
export interface PlanArgs {
  readonly forgeDir: string;
  readonly json: boolean;
  readonly scopeOverride?: readonly string[];
  readonly dimensionsOverride?: readonly string[];
}

export interface PlanPrompt {
  readonly scope: string;
  readonly dimension: string;
  readonly prompt: string;
}

export interface PlanResult {
  readonly prompts: readonly PlanPrompt[];
  readonly scope: readonly string[];
  readonly dimensions: readonly string[];
  readonly protected_globs: readonly string[];
  readonly verify_configured: boolean;
  readonly warnings: readonly string[];
}

export function runAuditPlan(args: PlanArgs): { exitCode: number } {
  const repoRoot = repoRootFromForgeDir(args.forgeDir);
  const cfg = loadAuditConfig(args.forgeDir);
  const warnings: string[] = [...cfg.warnings];

  // Scope: explicit flag override → settings → auto-discover.
  let scope: readonly string[];
  if (args.scopeOverride && args.scopeOverride.length > 0) {
    scope = args.scopeOverride;
  } else if (cfg.audit.scope_globs && cfg.audit.scope_globs.length > 0) {
    scope = cfg.audit.scope_globs;
  } else {
    const discovered = discoverScope(repoRoot);
    scope = discovered.scopeGlobs;
    warnings.push(...discovered.warnings);
  }

  const dimensions =
    args.dimensionsOverride && args.dimensionsOverride.length > 0
      ? args.dimensionsOverride
      : cfg.audit.dimensions;

  const protectedGlobs = resolveProtectedGlobs(repoRoot, cfg);

  let principles: string;
  try {
    principles = readFileSync(path.join(resolveTemplatesDir(), 'audit-principles.md'), 'utf8');
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'TEMPLATE_NOT_FOUND',
          `audit plan: could not read audit-principles.md (${err instanceof Error ? err.message : String(err)}). Reinstall: npm i -g @firatcand/forge`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  if (!cfg.verifyConfigured) {
    warnings.push(
      'no `verify:` block configured — audit findings are UNVERIFIABLE without a gate. Pair the audit with a verification gate before acting on any finding.',
    );
  }

  const prompts: PlanPrompt[] = [];
  for (const scopeGlob of scope) {
    for (const dimension of dimensions) {
      prompts.push({
        scope: scopeGlob,
        dimension,
        prompt: renderSubagentPrompt({
          dimension,
          scopeGlob,
          principles,
          protectedGlobs,
          maxFindings: cfg.audit.max_findings_per_agent,
        }),
      });
    }
  }

  const result: PlanResult = {
    prompts,
    scope,
    dimensions,
    protected_globs: protectedGlobs,
    verify_configured: cfg.verifyConfigured,
    warnings,
  };
  return { exitCode: emit(ok(result), { json: args.json }) };
}

// ── The filter (code-enforced, unit-tested) ──────────────────────────────────
export type DropReason =
  | 'invalid-finding'
  | 'absolute-path'
  | 'malformed-path'
  | 'outside-repo'
  | 'out-of-scope'
  | 'protected';

export interface FilterOutcome {
  readonly kept: readonly Finding[];
  readonly dropped: readonly { readonly file: string; readonly reason: DropReason }[];
  readonly warnings: readonly string[];
}

// Pure filter so every predicate is independently unit-testable. `rawFindings`
// is untrusted (assembled from subagents); each entry is validated then passed
// through: absolute → outside-repo → out-of-scope → protected.
export function filterFindings(args: {
  readonly repoRoot: string;
  readonly rawFindings: readonly unknown[];
  readonly scopeGlobs: readonly string[];
  readonly protectedGlobs: readonly string[];
}): FilterOutcome {
  const kept: Finding[] = [];
  const dropped: { file: string; reason: DropReason }[] = [];
  const warnings: string[] = [];

  for (const raw of args.rawFindings) {
    const parsed = FindingSchema.safeParse(raw);
    if (!parsed.success) {
      const label =
        raw && typeof raw === 'object' && 'file' in raw && typeof (raw as { file: unknown }).file === 'string'
          ? (raw as { file: string }).file
          : '<invalid>';
      dropped.push({ file: label, reason: 'invalid-finding' });
      warnings.push(`dropped invalid finding (${label}): ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const finding = parsed.data;

    // B1+B2: absolute paths (even absolute-but-inside-repo) are dropped BEFORE
    // any resolve — resolveRepoRelative would accept an absolute path that
    // resolves inside the repo. `path.isAbsolute` is PLATFORM-LOCAL (a Windows
    // `C:\…` passes on POSIX), so check BOTH posix + win32 absolute forms.
    if (path.posix.isAbsolute(finding.file) || path.win32.isAbsolute(finding.file)) {
      dropped.push({ file: finding.file, reason: 'absolute-path' });
      continue;
    }

    // B3: reject a malformed repo-relative path (NUL/control chars, backslash,
    // empty/`.`/`..` segments) BEFORE resolution/glob — a strict forward-slash
    // grammar. A NUL or `..` path could otherwise pass scope/glob matching.
    if (!isSafeRepoRelativePath(finding.file)) {
      dropped.push({ file: finding.file, reason: 'malformed-path' });
      continue;
    }

    // Symlink / realpath escape: resolve the now-safe relative path against
    // repoRoot (catches an in-scope-looking path whose real target is outside).
    const resolved = resolveRepoRelative(args.repoRoot, args.repoRoot, finding.file);
    if ('error' in resolved) {
      dropped.push({ file: finding.file, reason: 'outside-repo' });
      continue;
    }
    const rel = resolved.relative;

    // Out-of-scope: the repo-relative path matches no scope glob.
    let inScope: boolean;
    try {
      inScope = matchAny(rel, args.scopeGlobs).matched;
    } catch (e) {
      // A configured scope glob is malformed — warn + treat as not-matching for
      // that glob (matchAny throws on the first bad glob). Be conservative: a
      // bad scope config drops the finding rather than admitting it.
      if (e instanceof InvalidGlobError) {
        warnings.push(`invalid scope glob '${e.glob}': ${e.message}; treating as no-match`);
        inScope = false;
      } else {
        throw e;
      }
    }
    if (!inScope) {
      dropped.push({ file: finding.file, reason: 'out-of-scope' });
      continue;
    }

    // Protected: the repo-relative path matches a protected glob. One bad
    // configured glob is a WARNING + skip-that-glob, never a crash.
    const pf = matchPreflight(rel, args.protectedGlobs);
    if (pf.kind === 'invalid_glob') {
      warnings.push(`invalid protected glob '${pf.glob}': ${pf.message}; skipping that glob`);
      // Re-match excluding the bad glob so a single bad entry doesn't void
      // protection from the remaining globs.
      const safeGlobs = args.protectedGlobs.filter((g) => g !== pf.glob);
      const retry = matchPreflight(rel, safeGlobs);
      if (retry.kind === 'ok' && retry.result.architectural) {
        dropped.push({ file: finding.file, reason: 'protected' });
        continue;
      }
      // If the retry itself hits ANOTHER bad glob we conservatively keep going;
      // but to avoid silently admitting a protected path, treat any remaining
      // invalid_glob as a drop.
      if (retry.kind === 'invalid_glob') {
        warnings.push(`invalid protected glob '${retry.glob}': ${retry.message}; dropping finding to fail closed`);
        dropped.push({ file: finding.file, reason: 'protected' });
        continue;
      }
    } else if (pf.result.architectural) {
      dropped.push({ file: finding.file, reason: 'protected' });
      continue;
    }

    // Store with the normalized repo-relative path.
    kept.push({ ...finding, file: rel });
  }

  return { kept, dropped, warnings };
}

// ── `audit collect` ──────────────────────────────────────────────────────────
export interface CollectArgs {
  readonly forgeDir: string;
  readonly json: boolean;
  readonly findingsFile?: string;
  readonly scopeOverride?: readonly string[];
  readonly dimensionsOverride?: readonly string[];
  readonly now?: Date;
}

export interface CollectResult {
  readonly work_order_path: string;
  readonly summary: Record<Classification, number>;
  readonly dropped: { readonly count: number; readonly reasons: Record<DropReason, number> };
  readonly verify_configured: boolean;
  readonly warnings: readonly string[];
}

function emptySummary(): Record<Classification, number> {
  const s = {} as Record<Classification, number>;
  for (const c of AUDIT_CLASSIFICATIONS) s[c] = 0;
  return s;
}

function emptyDropReasons(): Record<DropReason, number> {
  return {
    'invalid-finding': 0,
    'absolute-path': 0,
    'malformed-path': 0,
    'outside-repo': 0,
    'out-of-scope': 0,
    protected: 0,
  };
}

function timestampDir(now: Date): string {
  // Filesystem-safe ISO-ish timestamp: 2026-06-15T12-30-00-123Z
  return now.toISOString().replace(/[:.]/g, '-');
}

function renderWorkOrderMd(wo: WorkOrder): string {
  const lines: string[] = [];
  lines.push('# Audit work-order');
  lines.push('');
  lines.push(`> Generated: ${wo.generated_at}`);
  lines.push(`> Scope: ${wo.scope.join(', ')}`);
  lines.push(`> Dimensions: ${wo.dimensions.join(', ')}`);
  lines.push(`> Verify configured: ${wo.verify_configured ? 'yes' : 'NO — findings unverifiable'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  for (const c of AUDIT_CLASSIFICATIONS) {
    lines.push(`- ${c}: ${wo.summary[c]}`);
  }
  lines.push('');
  if (wo.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of wo.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('## Findings');
  lines.push('');
  if (wo.findings.length === 0) {
    lines.push('_No findings survived the scope/protected filter._');
    lines.push('');
  } else {
    for (const c of AUDIT_CLASSIFICATIONS) {
      const group = wo.findings.filter((f) => f.classification === c);
      if (group.length === 0) continue;
      lines.push(`### ${c} (${group.length})`);
      lines.push('');
      for (const f of group) {
        const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
        lines.push(`- **${loc}** — _${f.dimension}_`);
        lines.push(`  - Evidence: ${f.evidence}`);
        lines.push(`  - Why safe: ${f.why_safe}`);
        lines.push(`  - Proposed change: ${f.proposed_change}`);
        lines.push(`  - Blast radius: ${f.blast_radius}`);
        if (f.tests_required) lines.push(`  - Tests required: ${f.tests_required}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

export function runAuditCollect(args: CollectArgs): { exitCode: number } {
  if (!args.findingsFile) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', 'audit collect: --findings-file <path> is required.', false),
        { json: args.json },
      ),
    };
  }

  const repoRoot = repoRootFromForgeDir(args.forgeDir);
  const cfg = loadAuditConfig(args.forgeDir);
  const warnings: string[] = [...cfg.warnings];

  // Resolve scope the same way `plan` does (so collect filters against the same
  // scope the prompts were rendered for).
  let scope: readonly string[];
  if (args.scopeOverride && args.scopeOverride.length > 0) {
    scope = args.scopeOverride;
  } else if (cfg.audit.scope_globs && cfg.audit.scope_globs.length > 0) {
    scope = cfg.audit.scope_globs;
  } else {
    const discovered = discoverScope(repoRoot);
    scope = discovered.scopeGlobs;
    warnings.push(...discovered.warnings);
  }
  const protectedGlobs = resolveProtectedGlobs(repoRoot, cfg);

  // Read + parse the findings file. (Codex cross-review B4/NB3) The findings
  // come from N untrusted subagents, so bound the input BEFORE reading it all:
  // require a REGULAR file (refuse dirs/devices/fifos) and cap the byte size, so
  // a hostile/runaway producer cannot exhaust memory via a huge or special file.
  const findingsPath = path.resolve(args.findingsFile);
  try {
    const st = lstatSync(findingsPath);
    if (!st.isFile()) {
      return {
        exitCode: emit(
          fail('FINDINGS_FILE_INVALID', `audit collect: findings file '${args.findingsFile}' is not a regular file.`, false),
          { json: args.json },
        ),
      };
    }
    if (st.size > MAX_FINDINGS_FILE_BYTES) {
      return {
        exitCode: emit(
          fail(
            'FINDINGS_FILE_TOO_LARGE',
            `audit collect: findings file is ${st.size} bytes; the cap is ${MAX_FINDINGS_FILE_BYTES} (${Math.floor(MAX_FINDINGS_FILE_BYTES / 1024 / 1024)} MB). Split the run or raise the cap.`,
            false,
          ),
          { json: args.json },
        ),
      };
    }
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'FINDINGS_FILE_NOT_FOUND',
          `audit collect: could not stat findings file '${args.findingsFile}': ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  let rawText: string;
  try {
    rawText = readFileSync(findingsPath, 'utf8');
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'FINDINGS_FILE_NOT_FOUND',
          `audit collect: could not read findings file '${args.findingsFile}': ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  let rawFindings: unknown;
  try {
    rawFindings = JSON.parse(rawText);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'FINDINGS_PARSE_ERROR',
          `audit collect: findings file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }
  if (!Array.isArray(rawFindings)) {
    return {
      exitCode: emit(
        fail('FINDINGS_PARSE_ERROR', 'audit collect: findings file must be a JSON array of findings.', false),
        { json: args.json },
      ),
    };
  }

  // (Codex cross-review B4) Cap the array length too — a size-capped file can
  // still hold a very large number of tiny objects. Process the first
  // MAX_FINDINGS and warn loudly about the remainder rather than churning the
  // whole hostile array into an enormous work-order.
  let findingsInput: unknown[] = rawFindings;
  if (findingsInput.length > MAX_FINDINGS) {
    warnings.push(
      `findings array has ${findingsInput.length} entries; capping at ${MAX_FINDINGS} — ${findingsInput.length - MAX_FINDINGS} ignored.`,
    );
    findingsInput = findingsInput.slice(0, MAX_FINDINGS);
  }

  const outcome = filterFindings({
    repoRoot,
    rawFindings: findingsInput,
    scopeGlobs: scope,
    protectedGlobs,
  });
  warnings.push(...outcome.warnings);

  const summary = emptySummary();
  for (const f of outcome.kept) summary[f.classification] += 1;

  const dropReasons = emptyDropReasons();
  for (const d of outcome.dropped) dropReasons[d.reason] += 1;

  if (!cfg.verifyConfigured) {
    warnings.push(
      'no `verify:` block configured — these findings are UNVERIFIABLE without a gate.',
    );
  }

  // (Codex cross-review NB1) Record the dimensions ACTUALLY audited: honor a
  // --dimensions override (matching `plan`) so the work-order metadata can't
  // claim different dimensions than were run.
  const dimensions =
    args.dimensionsOverride && args.dimensionsOverride.length > 0
      ? args.dimensionsOverride
      : cfg.audit.dimensions;

  const now = args.now ?? new Date();
  const workOrder: WorkOrder = {
    generated_at: now.toISOString(),
    scope: [...scope],
    dimensions: [...dimensions],
    verify_configured: cfg.verifyConfigured,
    warnings,
    findings: [...outcome.kept],
    summary,
  };

  // Validate our own output before writing (defense-in-depth).
  const validated = WorkOrderSchema.safeParse(workOrder);
  if (!validated.success) {
    return {
      exitCode: emit(
        fail(
          'WORK_ORDER_INVALID',
          `audit collect: assembled work-order failed validation: ${validated.error.message}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  // B3: guard the audit dir against symlinked-parent (or symlinked-leaf) escape
  // BEFORE writing. writeAtomic guards only the LEAF; a symlinked `.forge`,
  // `.forge/audits`, or `.forge/audits/<ts>` would let a write escape the tree.
  // This is a BEST-EFFORT default-deny against a PRE-EXISTING symlink (the real
  // case); the <ts> leaf is freshly created per run so it cannot pre-exist. The
  // residual check→mkdir→write TOCTOU is the same one writeAtomic documents
  // (fs-atomic.ts) and is accepted here for the same reason: no privilege
  // boundary is crossed — audit writes the user's OWN repo AS the user, so anyone
  // able to swap `.forge/audits` mid-run could already write the repo directly.
  const ts = timestampDir(now);
  const auditRel = path.posix.join('.forge', 'audits', ts);
  const symlinked = firstSymlinkedComponent(repoRoot, auditRel);
  if (symlinked !== null) {
    return {
      exitCode: emit(
        fail(
          'SYMLINK_PARENT_REFUSED',
          `audit collect: refusing to write — '${symlinked}' is a symbolic link; writing through it would escape the working tree.`,
          false,
        ),
        { json: args.json },
      ),
    };
  }

  const auditDir = path.join(repoRoot, '.forge', 'audits', ts);
  try {
    mkdirSync(auditDir, { recursive: true });
    const jsonPath = path.join(auditDir, 'work-order.json');
    const mdPath = path.join(auditDir, 'work-order.md');
    writeAtomic(jsonPath, JSON.stringify(validated.data, null, 2) + '\n');
    writeAtomic(mdPath, renderWorkOrderMd(validated.data));

    const result: CollectResult = {
      work_order_path: jsonPath,
      summary,
      dropped: { count: outcome.dropped.length, reasons: dropReasons },
      verify_configured: cfg.verifyConfigured,
      warnings,
    };
    return { exitCode: emit(ok(result), { json: args.json }) };
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          'WORK_ORDER_WRITE_FAILED',
          `audit collect: failed to write work-order: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
        { json: args.json },
      ),
    };
  }
}

// ── `audit create-issues` (RENDER-ONLY) ─────────────────────────────────────
// FORGE-180 (P2). Reads a work-order and RENDERS one tracker-issue SPEC per
// finding. It mutates NOTHING: the existing `Tracker.createIssue` is bound to
// forge ROADMAP tasks (it requires a non-empty forgeTaskId, which reconcile/gc
// then treat as a managed task), so audit findings — which are OUT-OF-BAND
// issues, not roadmap tasks — must NOT go through it. Instead the `/audit` skill
// files these specs out-of-band via the host's tracker tools (gh / Linear MCP /
// Notion), applying the classification label. This verb only READS settings (for
// the tracker type) + the work-order file. (User-confirmed design, plan
// pre-opinion.)

const MAX_SPEC_TITLE_LEN = 256;

export interface IssueSpec {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly finding_ref: string; // file[:line]
  readonly classification: Classification;
}

export interface UmbrellaSpec {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface CreateIssuesArgs {
  readonly forgeDir: string;
  readonly json: boolean;
  readonly workOrderFile?: string;
  readonly umbrella?: string;
}

export interface CreateIssuesResult {
  readonly tracker_type: string;
  readonly count: number;
  readonly issue_specs: readonly IssueSpec[];
  readonly umbrella_spec?: UmbrellaSpec;
  readonly warnings: readonly string[];
}

function renderFindingBody(f: Finding, verifyConfigured: boolean, umbrellaTitle?: string): string {
  const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  const lines = [
    `**Location:** \`${loc}\``,
    `**Classification:** ${f.classification}`,
    `**Dimension:** ${f.dimension}`,
    '',
    `**Evidence:** ${f.evidence}`,
    `**Why safe:** ${f.why_safe}`,
    `**Proposed change:** ${f.proposed_change}`,
    `**Blast radius:** ${f.blast_radius}`,
  ];
  if (f.tests_required) lines.push(`**Tests required:** ${f.tests_required}`);
  if (!verifyConfigured) {
    lines.push('', '> ⚠️ No `verify:` gate configured — this finding is UNVERIFIABLE until a gate is set.');
  }
  if (umbrellaTitle) lines.push('', `_Part of the audit umbrella: ${umbrellaTitle}_`);
  return lines.join('\n') + '\n';
}

export function runAuditCreateIssues(args: CreateIssuesArgs): { exitCode: number } {
  const cfg = loadAuditConfig(args.forgeDir);

  // Refuse when no tracker is configured — rendering issue specs the skill can't
  // file is pointless, and this honors the acceptance. The verb never connects /
  // authenticates a tracker; it only reads `tracker.type` from settings.
  if (cfg.trackerType === null) {
    return {
      exitCode: emit(
        fail(
          'NO_TRACKER_CONFIGURED',
          'audit create-issues needs a configured tracker (set tracker.type in .forge/settings.yaml) so /audit can file the rendered issues.',
          false,
        ),
        { json: args.json },
      ),
    };
  }

  if (!args.workOrderFile) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', 'audit create-issues: --work-order <path> is required.', false),
        { json: args.json },
      ),
    };
  }

  // Read + validate the work-order. It is our OWN output, but still bound it
  // (regular file + byte cap) + schema-validate before rendering — same posture
  // as `collect`'s --findings-file.
  const woPath = path.resolve(args.workOrderFile);
  try {
    const st = lstatSync(woPath);
    if (!st.isFile()) {
      return {
        exitCode: emit(
          fail('WORK_ORDER_INVALID', `audit create-issues: '${args.workOrderFile}' is not a regular file.`, false),
          { json: args.json },
        ),
      };
    }
    if (st.size > MAX_FINDINGS_FILE_BYTES) {
      return {
        exitCode: emit(
          fail('WORK_ORDER_TOO_LARGE', `audit create-issues: work-order is ${st.size} bytes; cap is ${MAX_FINDINGS_FILE_BYTES}.`, false),
          { json: args.json },
        ),
      };
    }
  } catch (err) {
    return {
      exitCode: emit(
        fail('WORK_ORDER_NOT_FOUND', `audit create-issues: could not stat '${args.workOrderFile}': ${err instanceof Error ? err.message : String(err)}`, false),
        { json: args.json },
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(woPath, 'utf8'));
  } catch (err) {
    return {
      exitCode: emit(
        fail('WORK_ORDER_INVALID', `audit create-issues: work-order is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: args.json },
      ),
    };
  }
  const wo = WorkOrderSchema.safeParse(parsed);
  if (!wo.success) {
    return {
      exitCode: emit(
        fail('WORK_ORDER_INVALID', `audit create-issues: work-order failed validation: ${wo.error.message}`, false),
        { json: args.json },
      ),
    };
  }

  const umbrellaSpec: UmbrellaSpec | undefined = args.umbrella
    ? {
        title: args.umbrella,
        body:
          [
            `Audit umbrella — ${wo.data.findings.length} finding(s).`,
            `**Scope:** ${wo.data.scope.join(', ')}`,
            `**Dimensions:** ${wo.data.dimensions.join(', ')}`,
            '',
            '**Summary by classification:**',
            ...AUDIT_CLASSIFICATIONS.map((c) => `- ${c}: ${wo.data.summary[c]}`),
            '',
            '_Child issues are filed separately and reference this umbrella._',
          ].join('\n') + '\n',
        labels: ['audit'],
      }
    : undefined;

  const issueSpecs: IssueSpec[] = wo.data.findings.map((f) => {
    const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
    const rawTitle = `[audit:${f.classification}] ${loc} — ${f.dimension}`;
    return {
      title: rawTitle.length > MAX_SPEC_TITLE_LEN ? rawTitle.slice(0, MAX_SPEC_TITLE_LEN - 1) + '…' : rawTitle,
      body: renderFindingBody(f, wo.data.verify_configured, umbrellaSpec?.title),
      labels: ['audit', f.classification],
      finding_ref: loc,
      classification: f.classification,
    };
  });

  const result: CreateIssuesResult = {
    tracker_type: cfg.trackerType,
    count: issueSpecs.length,
    issue_specs: issueSpecs,
    ...(umbrellaSpec ? { umbrella_spec: umbrellaSpec } : {}),
    warnings: wo.data.verify_configured ? [] : ['work-order has no verify gate — issues note the findings are unverifiable.'],
  };
  return { exitCode: emit(ok(result), { json: args.json }) };
}

// ── Verb-table handlers ──────────────────────────────────────────────────────
function parseListFlag(rest: readonly string[], long: string): readonly string[] | undefined {
  const raw = parseFlag(rest, long);
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

export const auditPlanHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Plan a read-only audit: render one subagent prompt per (scope × dimension). Writes nothing.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const json = hasFlag(rest, 'json');
    const scopeOverride = parseListFlag(rest, 'scope');
    const dimensionsOverride = parseListFlag(rest, 'dimensions');
    return runAuditPlan({
      forgeDir,
      json,
      ...(scopeOverride ? { scopeOverride } : {}),
      ...(dimensionsOverride ? { dimensionsOverride } : {}),
    });
  },
};

export const auditCollectHandler: VerbHandler = {
  // Band 'read' = no lease/tracker mutation. collect DOES write the audit
  // artifacts under .forge/audits/ — the band is help metadata, not a write gate.
  band: 'read',
  synopsis: 'Collect subagent findings (--findings-file), filter escapes/out-of-scope/protected, write the work-order to .forge/audits/<ts>/.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const json = hasFlag(rest, 'json');
    const findingsFile = parseFlag(rest, 'findings-file');
    const scopeOverride = parseListFlag(rest, 'scope');
    const dimensionsOverride = parseListFlag(rest, 'dimensions');
    return runAuditCollect({
      forgeDir,
      json,
      ...(findingsFile ? { findingsFile } : {}),
      ...(scopeOverride ? { scopeOverride } : {}),
      ...(dimensionsOverride ? { dimensionsOverride } : {}),
    });
  },
};

export const auditCreateIssuesHandler: VerbHandler = {
  // Band 'read': this verb RENDERS issue specs and mutates nothing (no tracker
  // connect/createIssue). The /audit skill files the specs out-of-band.
  band: 'read',
  synopsis: 'Render one tracker-issue spec per audit finding (--work-order); the /audit skill files them out-of-band with labels.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const json = hasFlag(rest, 'json');
    const workOrderFile = parseFlag(rest, 'work-order');
    const umbrella = parseFlag(rest, 'umbrella');
    return runAuditCreateIssues({
      forgeDir,
      json,
      ...(workOrderFile ? { workOrderFile } : {}),
      ...(umbrella ? { umbrella } : {}),
    });
  },
};
