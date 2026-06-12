// `src/orchestrator/drift.ts` — Pure SPEC↔code drift detection (v0.4).
//
// Scans each input spec file for `src/...ts` path references and reports
// any path that does not exist on disk under `repoRoot`. This is the only
// drift check shipped in v0.4 — exported-name / symbol grep is deferred to
// v0.5 (Fork 1 of FORGE-99 plan).
//
// **Pure module contract.** Callers (currently `src/cli/orchestrate/doctor.ts`)
// resolve `repoRoot` from CLI args / settings / env and pass it as an absolute
// path. This module has no env access, no `process.*` calls, no stdout, no
// settings access. Optional `fs` injection enables hermetic unit tests.

import {
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  statSync as nodeStatSync,
} from 'node:fs';
import path from 'node:path';

// FORGE-131: the symbol-mention check is a BOUNDED grep, NOT export analysis.
//
// Honest contract (documented in spec/ORCHESTRATOR.md §doctor + SPEC §21):
//   - It flags an identifier-shaped backtick span in a spec file when that
//     literal string appears NOWHERE in any `src/**/*.ts` file.
//   - It is a MENTION index, not a symbol table: a symbol that appears only in
//     a comment or a test still counts as "present". A renamed export with
//     stale prose is caught ONLY when the old name vanishes from src entirely.
//   - The shape filter (CamelCase ≥2 humps / camelCase / ALL_CAPS_SNAKE, len ≥4)
//     is the main false-positive killer; ordinary prose nouns rarely match it.
//   - This will NOT grow toward AST analysis in this batch.
export interface SpecCodeDriftEntry {
  readonly kind: 'missing_file' | 'missing_symbol';
  readonly source: string;
  readonly target: string;
}

export interface SpecCodeDriftReport {
  readonly scope: 'spec-code';
  readonly warnings: readonly SpecCodeDriftEntry[];
  readonly drift: readonly SpecCodeDriftEntry[];
}

export interface DriftFsAdapter {
  readonly readFileSync: (p: string, enc: 'utf8') => string;
  readonly statSync: (p: string) => unknown;
  // FORGE-131: directory walk for the src/**/*.ts mention index. Optional on
  // injected adapters — when absent (legacy test fixtures), the symbol check is
  // skipped (no index ⇒ nothing to compare against ⇒ no missing_symbol entries).
  readonly readdirSync?: (
    p: string,
  ) => ReadonlyArray<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
}

export interface DriftDetectionOpts {
  readonly repoRoot: string;
  readonly specFiles?: readonly string[];
  readonly fs?: DriftFsAdapter;
  // FORGE-131: extra adopter-declared symbols to treat as legitimate prose
  // (settings.doctor.symbol_allowlist). Merged with BASE_SYMBOL_ALLOWLIST.
  readonly symbolAllowlist?: readonly string[];
}

const DEFAULT_SPEC_FILES = ['spec/SPEC.md', 'spec/ORCHESTRATOR.md', 'spec/PRD.md'] as const;
const FILE_PATH_REGEX = /\b(src\/[A-Za-z0-9_\-./]+\.ts)\b/g;
const REQUIRED_SPEC = 'spec/SPEC.md';

// FORGE-131: backtick-span extraction + identifier-shape filter.
//
// We pull every `…` inline-code span, then keep ONLY spans that are a single
// bare identifier AND match one of three "looks like code, not prose" shapes:
//   - CamelCase with ≥2 humps   (e.g. SpecCodeDriftEntry, LeaseSchema)
//   - camelCase                 (e.g. computeSpecRevision, leaseFilePath)
//   - ALL_CAPS_SNAKE            (e.g. MARKER_OPEN, TASK_STATES)
// plus a minimum length of 4 to drop short noise (`id`, `cwd`, `npm`).
const BACKTICK_SPAN_REGEX = /`([^`\n]+)`/g;
const BARE_IDENTIFIER_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CAMEL_CASE_2_HUMPS = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*){1,}$/; // ≥2 humps
const LOWER_CAMEL_CASE = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
const ALL_CAPS_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const MIN_SYMBOL_LEN = 4;

function isSymbolShaped(s: string): boolean {
  if (s.length < MIN_SYMBOL_LEN) return false;
  if (!BARE_IDENTIFIER_REGEX.test(s)) return false;
  return CAMEL_CASE_2_HUMPS.test(s) || LOWER_CAMEL_CASE.test(s) || ALL_CAPS_SNAKE.test(s);
}

// src/**/*.ts walk caps — defense in depth against a pathological repo (deep
// nesting, huge files) when invoked with a caller-supplied --repo-root.
const SRC_WALK_MAX_FILES = 5_000;
const SRC_WALK_MAX_DEPTH = 25;
const SRC_FILE_MAX_BYTES = 2 * 1024 * 1024;

// FORGE-131: language / framework / CLI terms that legitimately appear in SPEC
// prose but are NOT forge source symbols, grouped by category. The doctor's
// self-clean gate (the existing e2e at test/unit/.../doctor.test.ts) runs the
// symbol check against forge's OWN SPEC and must stay exit 0 — every term here
// is a genuine prose mention verified against spec/SPEC.md + ORCHESTRATOR.md +
// PRD.md, never test fudging. Adopters extend via settings.doctor.symbol_allowlist.
export const BASE_SYMBOL_ALLOWLIST: readonly string[] = [
  // ── External CLIs / tools mentioned in prose ──
  'GitHub', 'GitLab', 'Linear', 'Notion', 'TypeScript', 'JavaScript',
  'Markdown', 'YAML', 'JSON', 'JSONL',
  // ── Host / agent product names ──
  'ClaudeCode', 'Codex', 'Gemini', 'Cursor', 'OpenAI', 'Anthropic',
  // ── Library / framework names ──
  'NodeJS', 'Vitest', 'ESLint', 'Prettier',
  // ── Methodology / domain prose terms (CamelCase concept names) ──
  'IronLaw', 'BoilTheLake',
  // ── Host-tool / IDE primitives the SPEC documents but forge does not export ──
  // (Claude Code / Cursor features referenced by name in the methodology prose.)
  'AskUserQuestion', 'EnterPlanMode', 'SessionStart', 'statusLine',
  // ── Documented environment variables (read via generic env access, not as
  //    named source symbols — verified absent from src on 2026-06-12). ──
  'FORGE_LOG_LEVEL', 'FORGE_PRIMARY_HOST_CLI', 'FORGE_REVIEW_HOST_CLI',
  'FORGE_SETTINGS_PATH', 'OP_SERVICE_ACCOUNT_TOKEN', 'LEASE_RELEASED',
  // ── Illustrative / conceptual type & function names used in SPEC + ORCHESTRATOR
  //    prose to describe behavior — NOT actual forge exports (verified absent
  //    from src on 2026-06-12). If any of these is later implemented under the
  //    same name, remove it here so genuine drift surfaces. ──
  'IssueUpdate', 'IssueQuery', 'VersionConflict', 'QuestionIndex',
  'ArtifactKind', 'WorkerContext', 'priorReviewFindings', 'collectTasksByState',
  'issueRemoveLabel', 'ifMatch',
] as const;

interface BoundedFsAdapter {
  readFileSync: (p: string, enc: 'utf8') => string;
  statSync: (p: string) => unknown;
  readdirSync?: (
    p: string,
  ) => ReadonlyArray<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
}

/**
 * FORGE-131: build a bounded membership index of every identifier-shaped token
 * that appears anywhere in `src/**\/*.ts`. The index is a Set of raw token
 * strings — a "mention" index, not a symbol table (see the kind comment above).
 * Returns null when the adapter cannot walk directories (no readdirSync), which
 * the caller treats as "skip the symbol check".
 */
function buildSrcMentionIndex(repoRoot: string, fs: BoundedFsAdapter): Set<string> | null {
  if (typeof fs.readdirSync !== 'function') return null;
  const readdir = fs.readdirSync;
  const index = new Set<string>();
  let fileCount = 0;
  const tokenRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;

  const walk = (dir: string, depth: number): void => {
    if (depth > SRC_WALK_MAX_DEPTH || fileCount >= SRC_WALK_MAX_FILES) return;
    let entries: ReturnType<typeof readdir>;
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= SRC_WALK_MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        fileCount += 1;
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (content.length > SRC_FILE_MAX_BYTES) continue;
        for (const m of content.matchAll(tokenRe)) {
          index.add(m[0]);
        }
      }
    }
  };

  walk(path.join(repoRoot, 'src'), 0);
  return index;
}

export function detectSpecCodeDrift(opts: DriftDetectionOpts): SpecCodeDriftReport {
  const { repoRoot } = opts;
  const specFiles = opts.specFiles ?? DEFAULT_SPEC_FILES;
  const fs: DriftFsAdapter =
    opts.fs ?? { readFileSync: nodeReadFileSync, statSync: nodeStatSync, readdirSync: nodeReaddirSyncEntries };
  const warnings: SpecCodeDriftEntry[] = [];
  const drift: SpecCodeDriftEntry[] = [];

  // FORGE-131: build the src/**/*.ts mention index ONCE per run (null when the
  // adapter can't walk dirs → symbol check skipped). The allowlist is the base
  // set plus any adopter-declared symbols.
  const mentionIndex = buildSrcMentionIndex(repoRoot, fs);
  const allowlist = new Set<string>([...BASE_SYMBOL_ALLOWLIST, ...(opts.symbolAllowlist ?? [])]);

  for (const rel of specFiles) {
    const full = path.join(repoRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      // Only SPEC.md is required; PRD.md + ORCHESTRATOR.md are advisory
      // and missing-silently is intentional for adopter projects that don't
      // ship all three artifacts.
      if (rel === REQUIRED_SPEC) {
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
      const refFull = path.join(repoRoot, ref);
      try {
        fs.statSync(refFull);
      } catch {
        drift.push({ kind: 'missing_file', source: rel, target: ref });
      }
    }

    // FORGE-131: symbol-mention drift. Extract identifier-shaped backtick spans
    // and flag any that are absent from the entire src mention index (and not
    // allowlisted). Dedup per spec file so the same stale symbol isn't reported
    // many times for one document.
    if (mentionIndex !== null) {
      const reported = new Set<string>();
      for (const m of raw.matchAll(BACKTICK_SPAN_REGEX)) {
        const span = (m[1] ?? '').trim();
        if (!isSymbolShaped(span)) continue;
        if (allowlist.has(span)) continue;
        if (mentionIndex.has(span)) continue;
        if (reported.has(span)) continue;
        reported.add(span);
        drift.push({ kind: 'missing_symbol', source: rel, target: span });
      }
    }
  }

  return { scope: 'spec-code', warnings, drift };
}

// Default readdir adapter producing Dirent-like entries (withFileTypes), shaped
// to the BoundedFsAdapter contract.
function nodeReaddirSyncEntries(
  p: string,
): ReadonlyArray<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> {
  return nodeReaddirSync(p, { withFileTypes: true }).map((d) => ({
    name: d.name,
    isDirectory: () => d.isDirectory(),
    isFile: () => d.isFile(),
  }));
}
