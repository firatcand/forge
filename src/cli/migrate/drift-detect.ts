// Pure drift detection for `forge migrate` (FORGE-109). No writes — every
// detector returns findings with the COMPLETE planned edit (before/after
// bytes) so the apply step is a mechanical writeAtomic and the preview shows
// exactly what will land.
//
// Finding classes (Codex pre-opinion: idempotency must distinguish these):
//   - actionable: migrate WILL rewrite/copy this on apply. After a successful
//     apply, the detector finds nothing — re-runs are clean.
//   - warning: detected, but migrate deliberately does not auto-rewrite
//     (e.g. dropped verbs with no replacement). Persists until manual fix.
//   - followup: detected, but another command owns the fix (forge init,
//     forge orchestrate gc, /draft-design). Persists until that command runs;
//     never blocks or writes.

import { existsSync, lstatSync, opendirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { validateUnderRoot } from '../../core/workspace.ts';
import { parseDocument } from 'yaml';

import { SettingsSchema } from '../../schemas/settings.ts';

export type DriftKind =
  | 'missing-settings'
  | 'settings-missing-blocks'
  | 'settings-invalid'
  | 'design-inherit'
  | 'design-inherit-marker'
  | 'push-to-linear-refs'
  | 'dropped-verbs-renamed'
  | 'dropped-verbs-removed'
  | 'missing-adr-template'
  | 'legacy-orchestrator-state';

export type DriftClass = 'actionable' | 'warning' | 'followup';

export interface PlannedEdit {
  readonly relPath: string;
  readonly before: string;
  readonly after: string;
}

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly class: DriftClass;
  readonly detail: string;
  readonly relPath?: string;
  readonly edit?: PlannedEdit;
  // For missing-adr-template: copy bundled template to this repo-relative path.
  readonly copyToRel?: string;
}

export interface SkippedFile {
  readonly relPath: string;
  readonly reason: 'symlink' | 'too-large' | 'unreadable';
}

export interface DriftReport {
  readonly findings: readonly DriftFinding[];
  readonly skipped: readonly SkippedFile[];
  // True when an aggregate scan bound (file count / total bytes / depth) was
  // hit — detection is incomplete; re-run after pruning the tree.
  readonly scanTruncated: boolean;
}

export const SCAN_FILE_MAX_BYTES = 1024 * 1024; // 1 MiB per scanned file
// Aggregate scan budget (Codex impl-review: per-file caps alone allow
// resource exhaustion on adversarial trees). Exceeding any bound stops the
// scan deterministically and surfaces `scanTruncated` so the caller can tell
// the user detection was incomplete.
export const SCAN_MAX_FILES = 2_000;
export const SCAN_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MiB (lstat sizes, pre-read)
export const SCAN_MAX_DEPTH = 12;
// Bounds directory-entry visits too: readdirSync materializes whole
// directories, and a broad tree of dirs (no .md files) would otherwise walk
// unbounded (Codex impl-review round 2).
export const SCAN_MAX_ENTRIES = 50_000;

// Schema-default blocks inserted into a stale settings.yaml. Values mirror
// src/schemas/settings.ts CodexSchema/DecisionsSchema/DoctorSchema defaults —
// the unit tests assert this equality against SettingsSchema.parse output so
// the two can never drift apart silently.
export const SETTINGS_DEFAULT_BLOCKS: Record<string, Record<string, unknown>> = {
  codex: { auto_codex_enabled: true, auto_codex_token_cap: 50_000 },
  decisions: { decision_dir: './spec/decisions', stale_draft_threshold_days: 7 },
  doctor: { spec_code_check_enabled: true },
};

const INHERIT_LINE = /^@inherit\b.*$/gm;
const INHERIT_MARKER = 'forge-migrate:';
const PUSH_TO_LINEAR = /\/push-to-linear\b/g;
// Only rewrite `next` in the unambiguous `forge orchestrate next` form — a
// bare "next" is far too common a word to touch (plan §signature 5).
const ORCHESTRATE_NEXT = /\bforge(\s+)orchestrate(\s+)next\b/g;
const SUGGEST_NEXT = /\bsuggest-next\b/g;
const REMOVED_VERBS = /\b(session-check|intent-detect)\b/g;

// Root agent files + markdown trees that may reference forge commands.
const SCAN_ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const SCAN_DIRS = ['docs', '.claude', '.agents', 'skills'];
const SCAN_EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.forge']);

interface ReadResult {
  content?: string;
  skipped?: SkippedFile;
}

// Budget accounting uses the lstat size BEFORE the read (Codex impl-review
// round 2: post-read string.length is not a byte cap — the read already
// happened).
function readScannable(cwd: string, relPath: string, budget?: ScanBudget): ReadResult {
  const abs = join(cwd, relPath);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return {}; // absent — nothing to scan
  }
  if (st.isSymbolicLink()) {
    return { skipped: { relPath, reason: 'symlink' } };
  }
  if (!st.isFile()) return {};
  // A symlinked ANCESTOR (e.g. spec/ → elsewhere) passes the leaf lstat but
  // resolves outside the repo — validateUnderRoot resolves real paths and
  // throws on escape (Codex impl-review round 3).
  try {
    validateUnderRoot(abs, cwd);
  } catch {
    return { skipped: { relPath, reason: 'symlink' } };
  }
  if (st.size > SCAN_FILE_MAX_BYTES) {
    return { skipped: { relPath, reason: 'too-large' } };
  }
  if (budget) {
    if (budget.bytes + st.size > SCAN_MAX_TOTAL_BYTES) {
      budget.truncated = true;
      return {};
    }
    budget.bytes += st.size;
    budget.files += 1;
  }
  try {
    return { content: readFileSync(abs, 'utf8') };
  } catch {
    return { skipped: { relPath, reason: 'unreadable' } };
  }
}

// Scan budget threaded through the walk + the per-file reads.
export interface ScanBudget {
  files: number;
  bytes: number;
  entries: number;
  truncated: boolean;
}

// Iterative .md walk under `dir` (repo-relative), honoring excludes and the
// aggregate budget. Symlinked directories are skipped wholesale (never
// followed); an explicit stack (not recursion) makes depth a data bound, not
// a call-stack bound.
function collectMarkdownFiles(
  cwd: string,
  dirRel: string,
  out: string[],
  skipped: SkippedFile[],
  budget: ScanBudget,
): void {
  // The scan ROOT itself must not be a symlink — a symlinked docs/ or
  // .claude/ would let the whole walk read outside the repository (Codex
  // impl-review round 2).
  try {
    const rootSt = lstatSync(join(cwd, dirRel));
    if (rootSt.isSymbolicLink()) {
      skipped.push({ relPath: dirRel, reason: 'symlink' });
      return;
    }
    if (!rootSt.isDirectory()) return;
  } catch {
    return; // absent
  }
  const stack: Array<{ rel: string; depth: number }> = [{ rel: dirRel, depth: 0 }];
  while (stack.length > 0) {
    const { rel, depth } = stack.pop()!;
    if (depth > SCAN_MAX_DEPTH) {
      budget.truncated = true;
      continue;
    }
    // opendirSync streams entries one at a time, so SCAN_MAX_ENTRIES bounds
    // ALLOCATION too — readdirSync would materialize an entire (possibly
    // enormous) directory before the cap could apply (Codex impl-review r3).
    let dir;
    try {
      dir = opendirSync(join(cwd, rel));
    } catch {
      continue;
    }
    try {
      let entry;
      while ((entry = dir.readSync()) !== null) {
        if (SCAN_EXCLUDE_DIRS.has(entry.name)) continue;
        budget.entries += 1;
        if (budget.entries > SCAN_MAX_ENTRIES || out.length >= SCAN_MAX_FILES) {
          budget.truncated = true;
          return;
        }
        const childRel = join(rel, entry.name);
        if (entry.isSymbolicLink()) {
          skipped.push({ relPath: childRel, reason: 'symlink' });
          continue;
        }
        if (entry.isDirectory()) {
          stack.push({ rel: childRel, depth: depth + 1 });
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) out.push(childRel);
      }
    } finally {
      try {
        dir.closeSync();
      } catch {
        // already closed
      }
    }
  }
}

function detectSettings(cwd: string): DriftFinding[] {
  const rel = join('.forge', 'settings.yaml');
  const abs = join(cwd, rel);
  if (!existsSync(abs)) {
    return [
      {
        kind: 'missing-settings',
        class: 'followup',
        relPath: rel,
        detail: '.forge/settings.yaml is missing — run `forge init` (it owns the project/tracker/secrets interview). Other signatures still migrate.',
      },
    ];
  }
  let raw: string;
  try {
    // lstat, not stat: a symlinked settings.yaml is refused (never followed) —
    // consistent with every other read in this scanner (Codex impl-review).
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      return [
        { kind: 'settings-invalid', class: 'warning', relPath: rel, detail: 'settings.yaml is a symlink — refusing to follow; migrate it manually.' },
      ];
    }
    if (st.size > SCAN_FILE_MAX_BYTES) {
      return [
        { kind: 'settings-invalid', class: 'warning', relPath: rel, detail: 'settings.yaml exceeds the 1 MiB scan cap — fix manually.' },
      ];
    }
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    return [
      { kind: 'settings-invalid', class: 'warning', relPath: rel, detail: `settings.yaml unreadable: ${(err as Error).message}` },
    ];
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return [
      {
        kind: 'settings-invalid',
        class: 'warning',
        relPath: rel,
        detail: `settings.yaml has YAML errors (${doc.errors[0]!.message}) — fix manually, then re-run forge migrate.`,
      },
    ];
  }
  const missing = Object.keys(SETTINGS_DEFAULT_BLOCKS).filter((key) => !doc.has(key));
  if (missing.length === 0) return [];

  for (const key of missing) {
    doc.set(key, SETTINGS_DEFAULT_BLOCKS[key]);
  }
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: false });

  // Fail-closed: only offer the edit if the RESULT validates. A v0.2.x file
  // whose other blocks no longer fit the v0.4 schema gets a manual-fix
  // warning instead of a write that still doesn't parse.
  const revalidated = SettingsSchema.safeParse(parseDocument(after).toJS());
  if (!revalidated.success) {
    const issue = revalidated.error.issues[0];
    return [
      {
        kind: 'settings-invalid',
        class: 'warning',
        relPath: rel,
        detail:
          `settings.yaml would still fail the v0.4 schema after adding ${missing.join('/')} ` +
          `(${issue?.path.join('.')}: ${issue?.message}) — migrate it manually (compare with \`forge init\` output).`,
      },
    ];
  }
  return [
    {
      kind: 'settings-missing-blocks',
      class: 'actionable',
      relPath: rel,
      detail: `settings.yaml lacks the v0.4 ${missing.join(', ')} block(s) — adding schema defaults.`,
      edit: { relPath: rel, before: raw, after },
    },
  ];
}

function detectDesignInherit(cwd: string, skipped: SkippedFile[]): DriftFinding[] {
  const rel = join('spec', 'DESIGN.md');
  const { content, skipped: skip } = readScannable(cwd, rel);
  if (skip) {
    skipped.push(skip);
    return [];
  }
  if (content === undefined) return [];

  const inheritLines = content.match(INHERIT_LINE);
  if (inheritLines && inheritLines.length > 0) {
    const after = content.replace(
      INHERIT_LINE,
      (line) =>
        `<!-- forge-migrate: '${line.trim()}' removed — pattern deleted in v0.4. ` +
        'Run /draft-design to generate a self-contained design system. -->',
    );
    return [
      {
        kind: 'design-inherit',
        class: 'actionable',
        relPath: rel,
        detail: `spec/DESIGN.md uses the deleted @inherit pattern (${inheritLines.length} line(s)) — stripping with an in-file marker.`,
        edit: { relPath: rel, before: content, after },
      },
    ];
  }
  // Marker from a prior migrate run: the strip happened, but the design
  // system is still not project-owned — keep surfacing until /draft-design
  // resolves it (Codex pre-opinion: SPEC requires concrete content).
  if (content.includes(INHERIT_MARKER) && content.includes('@inherit')) {
    return [
      {
        kind: 'design-inherit-marker',
        class: 'followup',
        relPath: rel,
        detail: 'spec/DESIGN.md still carries the forge-migrate @inherit marker — run /draft-design to regenerate a self-contained design system.',
      },
    ];
  }
  return [];
}

interface TextRewriteResult {
  after: string;
  pushToLinear: number;
  renamedNext: number;
  renamedSuggest: number;
  removedVerbs: string[];
}

export function rewriteCommandRefs(content: string): TextRewriteResult {
  let after = content;
  const pushToLinear = (after.match(PUSH_TO_LINEAR) ?? []).length;
  after = after.replace(PUSH_TO_LINEAR, '/push-to-tracker');
  const renamedNext = (after.match(ORCHESTRATE_NEXT) ?? []).length;
  after = after.replace(ORCHESTRATE_NEXT, 'forge$1orchestrate$2claim');
  const renamedSuggest = (after.match(SUGGEST_NEXT) ?? []).length;
  after = after.replace(SUGGEST_NEXT, 'phases --ready');
  const removedVerbs = [...new Set((after.match(REMOVED_VERBS) ?? []).map((m) => m))];
  return { after, pushToLinear, renamedNext, renamedSuggest, removedVerbs };
}

function detectCommandRefs(cwd: string, skipped: SkippedFile[], budget: ScanBudget): DriftFinding[] {
  const files: string[] = [];
  for (const rootFile of SCAN_ROOT_FILES) {
    if (existsSync(join(cwd, rootFile))) files.push(rootFile);
  }
  for (const dir of SCAN_DIRS) {
    collectMarkdownFiles(cwd, dir, files, skipped, budget);
  }

  const findings: DriftFinding[] = [];
  for (const rel of files) {
    if (budget.truncated) break;
    const { content, skipped: skip } = readScannable(cwd, rel, budget);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    if (content === undefined) continue;

    const result = rewriteCommandRefs(content);
    const parts: string[] = [];
    if (result.pushToLinear > 0) parts.push(`${result.pushToLinear}× /push-to-linear → /push-to-tracker`);
    if (result.renamedNext > 0) parts.push(`${result.renamedNext}× orchestrate next → claim`);
    if (result.renamedSuggest > 0) parts.push(`${result.renamedSuggest}× suggest-next → phases --ready`);

    if (parts.length > 0) {
      findings.push({
        kind: result.pushToLinear > 0 && result.renamedNext + result.renamedSuggest === 0
          ? 'push-to-linear-refs'
          : 'dropped-verbs-renamed',
        class: 'actionable',
        relPath: rel,
        detail: parts.join(' · '),
        edit: { relPath: rel, before: content, after: result.after },
      });
    }
    if (result.removedVerbs.length > 0) {
      findings.push({
        kind: 'dropped-verbs-removed',
        class: 'warning',
        relPath: rel,
        detail:
          `references dropped verb(s) ${result.removedVerbs.join(', ')} — these have no v0.4 replacement; ` +
          'remove the call sites manually (status/dashboard cover the old use cases).',
      });
    }
  }
  return findings;
}

function detectAdrTemplate(cwd: string): DriftFinding[] {
  const rel = join('templates', 'adr.template.md');
  if (existsSync(join(cwd, rel))) return [];
  return [
    {
      kind: 'missing-adr-template',
      class: 'actionable',
      relPath: rel,
      detail: 'templates/adr.template.md is missing — copying the bundled v0.4 scaffold.',
      copyToRel: rel,
    },
  ];
}

function detectLegacyOrchestratorState(cwd: string): DriftFinding[] {
  // gc's Phase-0 legacy markers: flat v1 .forge/{questions,answers}/*.json
  // trees from before the v2 task-keyed rewrite (see gc.ts). Read-only
  // detection here; gc owns the archive operation.
  for (const dir of ['questions', 'answers']) {
    const abs = join(cwd, '.forge', dir);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    // Mirror gc's filter: .tmp residue from crashed v1 writers is ignored.
    if (entries.some((name) => name.endsWith('.json') && !name.includes('.tmp'))) {
      return [
        {
          kind: 'legacy-orchestrator-state',
          class: 'followup',
          relPath: join('.forge', dir),
          detail: 'legacy v1 orchestrator state detected (.forge/questions|answers) — run `forge orchestrate gc --dry-run` to plan the archive; gc owns state migration.',
        },
      ];
    }
  }
  return [];
}

export function detectDrift(cwd: string): DriftReport {
  const root = resolve(cwd);
  const skipped: SkippedFile[] = [];
  const budget: ScanBudget = { files: 0, bytes: 0, entries: 0, truncated: false };

  // A symlinked .forge would redirect the settings read, the legacy-state
  // probe, AND the eventual backup destination outside the repository —
  // refuse it up front (Codex impl-review round 2).
  let forgeDirIsSymlink = false;
  try {
    forgeDirIsSymlink = lstatSync(join(root, '.forge')).isSymbolicLink();
  } catch {
    forgeDirIsSymlink = false; // absent is fine — detectors handle it
  }

  const findings: DriftFinding[] = [
    ...(forgeDirIsSymlink
      ? [
          {
            kind: 'settings-invalid',
            class: 'warning',
            relPath: '.forge',
            detail: '.forge is a symlink — refusing to scan settings/orchestrator state or write backups through it; resolve manually.',
          } as DriftFinding,
        ]
      : [...detectSettings(root), ...detectLegacyOrchestratorState(root)]),
    ...detectDesignInherit(root, skipped),
    ...detectCommandRefs(root, skipped, budget),
    ...detectAdrTemplate(root),
  ];
  // Deterministic ordering for stable previews/tests: by class
  // (actionable → warning → followup), then path.
  const rank: Record<DriftClass, number> = { actionable: 0, warning: 1, followup: 2 };
  findings.sort(
    (a, b) =>
      rank[a.class] - rank[b.class] ||
      (a.relPath ?? '').localeCompare(b.relPath ?? '') ||
      a.kind.localeCompare(b.kind),
  );
  // Defensive: every edit target must stay under the repo root (relative,
  // no traversal) — detectors only produce known-safe relPaths today, but
  // the apply step trusts this invariant.
  for (const f of findings) {
    const target = f.edit?.relPath ?? f.copyToRel;
    if (target) {
      const abs = resolve(root, target);
      if (!abs.startsWith(root + sep) || relative(root, abs).startsWith('..')) {
        throw new Error(`detectDrift: planned edit escapes the repo root: ${target}`);
      }
    }
  }
  return { findings, skipped, scanTruncated: budget.truncated };
}
