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
// src/schemas/settings.ts SecondOpinionSchema/DecisionsSchema/DoctorSchema
// defaults — the unit tests assert this equality against SettingsSchema.parse
// output so the two can never drift apart silently.
//
// FORGE-150: the legacy `codex` block was replaced by `second_opinion` here.
// Absent-both files seed `second_opinion` only (the schema's `codex` block is
// now optional-without-default, so it must NOT be inserted on a fresh migrate).
// A file that ALREADY carries a legacy `codex` block is handled by the
// rename-with-mirror path in detectSettings (which keeps a mirrored codex block
// for old-CLI compat); it does not flow through this missing-block seeding.
export const SETTINGS_DEFAULT_BLOCKS: Record<string, Record<string, unknown>> = {
  second_opinion: { auto_enabled: true },
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

// Paths whose JOB is to mention old command names — historical records,
// design docs discussing renames, and deprecation-alias skills. Rewriting
// them produces self-referential nonsense ("X is deprecated — use X"), so
// detection still runs (to surface the mention as a warning) but migrate
// never auto-rewrites them (FORGE-207, guards-only).
export const REWRITE_GUARD_DIRS = ['docs/retros', 'docs/plans'];
export const REWRITE_GUARD_SKILLS = ['skills/push-to-linear']; // alias dirs named after a rename SOURCE

// Segment-boundary guard match: normalize Windows '\' → '/', then require an
// exact match or a true path-segment prefix. A bare startsWith() would wrongly
// guard siblings like docs/retrospective/ or skills/push-to-linear-old/.
export function isUnderGuard(rel: string, guards: readonly string[]): boolean {
  const norm = rel.replace(/\\/g, '/');
  return guards.some((guard) => norm === guard || norm.startsWith(guard + '/'));
}

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
  // FORGE-150 — ONE COMPOSED EDIT. A v0.2.x/v0.4 settings.yaml may carry a
  // legacy `codex` block but no `second_opinion` block. The migrate must (a)
  // seed `second_opinion.auto_enabled` from the legacy disable value, (b) KEEP
  // a mirrored `codex.auto_codex_enabled` block (old-CLI compat; removed in
  // v0.5) carrying the SAME value, and (c) add any other missing default
  // blocks (decisions/doctor) — all in a SINGLE finding, never a rename finding
  // racing a missing-block finding over the same file.
  const hasLegacyCodex = doc.has('codex');
  const hasSecondOpinion = doc.has('second_opinion');

  // Derive the legacy disable value (default true when the key is absent or
  // not a boolean — mirrors SecondOpinionSchema/CodexSchema defaults). Used to
  // SEED second_opinion when only the legacy block exists (un-migrated repo).
  let legacyValue = true;
  if (hasLegacyCodex) {
    const raw = doc.getIn(['codex', 'auto_codex_enabled']);
    if (typeof raw === 'boolean') legacyValue = raw;
  }

  // Derive the second_opinion value (default true when absent or not a boolean).
  // When BOTH blocks exist, second_opinion is the SOURCE OF TRUTH (GPT-5.5
  // review F2): the legacy codex mirror is refreshed to MATCH this value, so
  // old-CLI and new-CLI behavior never diverge after a migrate.
  let secondOpinionValue = true;
  if (hasSecondOpinion) {
    const raw = doc.getIn(['second_opinion', 'auto_enabled']);
    if (typeof raw === 'boolean') secondOpinionValue = raw;
  }

  // Compute which default blocks are missing. `second_opinion` is handled
  // explicitly below (so its value can carry the legacy mirror), so exclude it
  // from the generic default-seeding loop.
  const missing = Object.keys(SETTINGS_DEFAULT_BLOCKS).filter((key) => !doc.has(key));
  const missingOther = missing.filter((key) => key !== 'second_opinion');

  // Nothing to do: second_opinion present AND no other missing blocks AND no
  // legacy mirror to refresh (i.e. either no codex block, or codex already
  // mirrors second_opinion). The "already mirrored" case is detected by
  // comparing values when both blocks exist.
  const codexMirrorInSync =
    !hasLegacyCodex ||
    (hasSecondOpinion &&
      doc.getIn(['second_opinion', 'auto_enabled']) ===
        doc.getIn(['codex', 'auto_codex_enabled']));
  if (hasSecondOpinion && missingOther.length === 0 && codexMirrorInSync) {
    return [];
  }

  const changes: string[] = [];

  if (!hasSecondOpinion) {
    doc.set('second_opinion', { auto_enabled: legacyValue });
    changes.push('second_opinion');
  }

  // Keep / refresh the legacy mirror only when a codex block already exists in
  // the file. Absent-both files seed second_opinion only (no codex block).
  //
  // The mirror value tracks whichever block is the SOURCE OF TRUTH:
  //   - both blocks present → second_opinion wins; codex is refreshed to MATCH
  //     it (GPT-5.5 review F2 — without this, both-present-disagreeing left old-
  //     CLI and new-CLI divergent and recorded no change).
  //   - only the legacy block present → we just seeded second_opinion FROM it,
  //     so the mirror keeps that same legacyValue.
  if (hasLegacyCodex) {
    const mirrorValue = hasSecondOpinion ? secondOpinionValue : legacyValue;
    const codexChanged = doc.getIn(['codex', 'auto_codex_enabled']) !== mirrorValue;
    doc.setIn(['codex', 'auto_codex_enabled'], mirrorValue);
    const codexNode = doc.get('codex', true) as
      | { commentBefore?: string | null }
      | undefined;
    if (codexNode && typeof codexNode === 'object') {
      codexNode.commentBefore = ' legacy mirror — removed in v0.5';
    }
    if (!hasSecondOpinion) {
      changes.push('codex (mirrored for compatibility)');
    } else if (codexChanged) {
      changes.push('codex (mirror refreshed to match second_opinion)');
    }
  }

  for (const key of missingOther) {
    doc.set(key, SETTINGS_DEFAULT_BLOCKS[key]);
    changes.push(key);
  }

  if (changes.length === 0) return [];

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
          `settings.yaml would still fail the v0.4 schema after adding ${changes.join('/')} ` +
          `(${issue?.path.join('.')}: ${issue?.message}) — migrate it manually (compare with \`forge init\` output).`,
      },
    ];
  }
  return [
    {
      kind: 'settings-missing-blocks',
      class: 'actionable',
      relPath: rel,
      detail: `settings.yaml lacks the v0.4 ${changes.join(', ')} block(s) — adding schema defaults.`,
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
  // Lines that matched an old command name but were NOT rewritten because the
  // replacement target was already present on that line — by construction such
  // a line is prose ABOUT the rename ("use Y instead of X"), and rewriting it
  // would yield "use Y instead of Y" (FORGE-207, line-level self-replace guard).
  selfReplaceSkipped: number;
}

// Replacement targets that, when already present on a line, mark that line as
// prose ABOUT the rename — so rewriting the OLD name on that line would be a
// self-replace. Matched against the original line (pre-rewrite).
// Right boundary must reject command-ish continuations (`-`, `_`, alnum): a
// bare `\b` treats `-` as a boundary, so `/push-to-tracker-old` would falsely
// register the NEW name as present and suppress a legitimate rewrite on that
// line. `(?![A-Za-z0-9_-])` is the command-ish right boundary (FORGE-207).
const PUSH_TO_TRACKER_PRESENT = /\/push-to-tracker(?![A-Za-z0-9_-])/;
const ORCHESTRATE_CLAIM_PRESENT = /\borchestrate\s+claim(?![A-Za-z0-9_-])/;
const PHASES_READY_PRESENT = /phases --ready(?![A-Za-z0-9_-])/;

export function rewriteCommandRefs(content: string): TextRewriteResult {
  let pushToLinear = 0;
  let renamedNext = 0;
  let renamedSuggest = 0;
  const removedSet = new Set<string>();
  // Track UNIQUE skipped lines: one line carrying old+new for MULTIPLE renames
  // must count once, not once per rename pair (FORGE-207). We collect segment
  // indices in a Set across the three rename passes and report set size.
  const selfReplaceSkippedLines = new Set<number>();

  // Split RETAINING separators (incl. lone \r) so untouched lines are emitted
  // byte-for-byte: migrate.ts compares current !== before, and any separator
  // normalization would show as spurious diff noise / phantom edits.
  const segments = content.split(/(\r\n|\n|\r)/);
  const out: string[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    // Separators (odd indices from the capturing split) pass through untouched;
    // they never match a command name, so the cheap path is to leave any
    // non-matching segment exactly as-is.
    let line = segment;

    // NOTE: PUSH_TO_LINEAR / ORCHESTRATE_NEXT / SUGGEST_NEXT / REMOVED_VERBS
    // carry the `g` flag. String.prototype.match(globalRegex) resets and
    // ignores lastIndex, so it is safe to call repeatedly; we deliberately
    // avoid RegExp.prototype.test() on these (it would mutate lastIndex).
    // The *_PRESENT guards are non-global and stateless.

    // removedVerbs is detection-only (never rewrites) — accumulate across all
    // lines regardless of the self-replace guard.
    for (const m of segment.match(REMOVED_VERBS) ?? []) removedSet.add(m);

    const nLinear = (segment.match(PUSH_TO_LINEAR) ?? []).length;
    if (nLinear > 0) {
      if (PUSH_TO_TRACKER_PRESENT.test(segment)) {
        selfReplaceSkippedLines.add(i);
      } else {
        pushToLinear += nLinear;
        line = line.replace(PUSH_TO_LINEAR, '/push-to-tracker');
      }
    }

    const nNext = (segment.match(ORCHESTRATE_NEXT) ?? []).length;
    if (nNext > 0) {
      if (ORCHESTRATE_CLAIM_PRESENT.test(segment)) {
        selfReplaceSkippedLines.add(i);
      } else {
        renamedNext += nNext;
        line = line.replace(ORCHESTRATE_NEXT, 'forge$1orchestrate$2claim');
      }
    }

    const nSuggest = (segment.match(SUGGEST_NEXT) ?? []).length;
    if (nSuggest > 0) {
      if (PHASES_READY_PRESENT.test(segment)) {
        selfReplaceSkippedLines.add(i);
      } else {
        renamedSuggest += nSuggest;
        line = line.replace(SUGGEST_NEXT, 'phases --ready');
      }
    }

    out.push(line);
  }

  return {
    after: out.join(''),
    pushToLinear,
    renamedNext,
    renamedSuggest,
    removedVerbs: [...removedSet],
    selfReplaceSkipped: selfReplaceSkippedLines.size,
  };
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
    const guarded = isUnderGuard(rel, [...REWRITE_GUARD_DIRS, ...REWRITE_GUARD_SKILLS]);

    // Guarded paths exist precisely to mention old names (historical records,
    // rename design docs, deprecation-alias skills). Detection still runs so
    // the mention is visible, but we emit a warning with NO edit — the file is
    // never rewritten (FORGE-207, guards-only). Detection counts come from the
    // pre-self-replace-guard rewrite (any old-name occurrence counts as a
    // "mention" here, even self-replace lines).
    if (guarded) {
      // Re-derive mentioned old names directly from content: the rewrite
      // tallies suppress self-replace lines, but for a guard warning ANY
      // old-name occurrence is a "mention" worth surfacing.
      const parts: string[] = [];
      if ((content.match(PUSH_TO_LINEAR) ?? []).length > 0) parts.push('/push-to-linear');
      if ((content.match(ORCHESTRATE_NEXT) ?? []).length > 0) parts.push('orchestrate next');
      if ((content.match(SUGGEST_NEXT) ?? []).length > 0) parts.push('suggest-next');
      if (parts.length > 0) {
        findings.push({
          kind: 'dropped-verbs-renamed',
          class: 'warning',
          relPath: rel,
          detail: `mentions renamed command(s) (${parts.join(', ')}) — left untouched: historical/alias content (FORGE-207)`,
        });
      }
    } else {
      const parts: string[] = [];
      if (result.pushToLinear > 0) parts.push(`${result.pushToLinear}× /push-to-linear → /push-to-tracker`);
      if (result.renamedNext > 0) parts.push(`${result.renamedNext}× orchestrate next → claim`);
      if (result.renamedSuggest > 0) parts.push(`${result.renamedSuggest}× suggest-next → phases --ready`);

      if (parts.length > 0) {
        let detail = parts.join(' · ');
        if (result.selfReplaceSkipped > 0) {
          detail += ` · ${result.selfReplaceSkipped} line(s) left untouched (mention both old and new name)`;
        }
        findings.push({
          kind: result.pushToLinear > 0 && result.renamedNext + result.renamedSuggest === 0
            ? 'push-to-linear-refs'
            : 'dropped-verbs-renamed',
          class: 'actionable',
          relPath: rel,
          detail,
          edit: { relPath: rel, before: content, after: result.after },
        });
      } else if (result.selfReplaceSkipped > 0) {
        // No rewrites were performed, but the file has self-replace-skipped
        // lines (prose mentioning both an old and new command name). Without a
        // finding this would be silent — contrary to the visibility goal. Emit
        // an edit-free warning so the mention surfaces (FORGE-207).
        findings.push({
          kind: 'dropped-verbs-renamed',
          class: 'warning',
          relPath: rel,
          detail: `${result.selfReplaceSkipped} line(s) mention both an old and new command name — left untouched (FORGE-207)`,
        });
      }
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
