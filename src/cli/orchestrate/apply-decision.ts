// `forge orchestrate apply-decision --adr <slug> [--yes-all] [--resume] [--dry-run]`
//
// The CLI verb behind `/update-spec --apply` (FORGE-95 / P2.5-T04). It is a
// MECHANICAL applier of a payload-complete journal: it propagates an accepted
// ephemeral ADR across SPEC §sections, PRD §sections, phases.yaml task fields,
// and tracker issue bodies, journaling each mutation so a partial failure is
// resumable. On full success it writes the rationale durably (SPEC sections are
// already rewritten by the journal; plus an INDEX.md line + a commit-message
// file), deletes the ADR, and archives the journal.
//
// Per the skill↔verb contract the verb NEVER runs git — it writes the commit
// message body to a file for the skill/user to commit.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

import { ApplyDecisionArgsSchema, type ApplyDecisionArgs } from '../../schemas/cli-args.ts';
import {
  ApplyJournalSchema,
  type ApplyJournal,
  type MarkdownSectionEntry,
  type PhasesTaskEntry,
  type TrackerIssueEntry,
} from '../../schemas/apply-journal.ts';
import { ApplyError } from '../../core/errors.ts';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { loadSettings } from '../../core/settings.ts';
import { validateUnderRoot } from '../../core/workspace.ts';
import { createTracker, trackerSupportsBodyMutation } from '../../trackers/factory.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import {
  resolveAdrPath,
  parseAdr,
  assertAccepted,
  extractRationale,
  deleteAdr,
  type ParsedAdr,
} from '../../orchestrator/adr.ts';
import { parseSectionRef, replaceManagedSection } from '../../orchestrator/markdown-section.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, firstPositional, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

const PHASES_PATH = 'plans/phases.yaml';
const INDEX_PATH = 'spec/decisions/INDEX.md';
const JOURNAL_SUBDIR = ['orchestrator', 'global', 'update-spec-apply-journal'];

interface JournalPaths {
  readonly active: string;
  readonly completed: string;
  readonly commitMsg: string;
}

function journalPaths(forgeDir: string, slug: string): JournalPaths {
  const dir = join(forgeDir, ...JOURNAL_SUBDIR);
  return {
    active: join(dir, `${slug}.json`),
    completed: join(dir, 'completed', `${slug}.json`),
    commitMsg: join(dir, `${slug}.commit-msg.txt`),
  };
}

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function readJournal(path: string): ApplyJournal | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ApplyError('IO_ERROR', `failed to read journal: ${(err as Error).message}`, { path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ApplyError('JOURNAL_PARSE_ERROR', `journal is not valid JSON: ${(err as Error).message}`, { path });
  }
  const result = ApplyJournalSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApplyError('JOURNAL_INVALID', `journal failed schema validation: ${result.error.issues[0]?.message ?? 'unknown'}`, {
      path,
    });
  }
  return result.data;
}

function persistJournal(path: string, journal: ApplyJournal): void {
  writeAtomic(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function allEntriesApplied(j: ApplyJournal): boolean {
  const lists = [j.spec_sections, j.prd_sections, j.phases_tasks, j.tracker_issues];
  return lists.every((l) => l.every((e) => e.status === 'applied'));
}

// Every ADR-declared section/task ref must have a covering journal entry.
// Tracker coverage is intentionally not checked here — affected_tasks is
// ambiguous (tracker id vs phases id) so the journal's tracker_issues is
// authoritative (Codex 2nd-pass round-2 improvement; see FORGE-95 plan).
function assertCoverage(adr: ParsedAdr, j: ApplyJournal): void {
  const missing: string[] = [];
  // Key by file#anchor, not anchor alone — an entry for the wrong file must not
  // satisfy an ADR-declared section that shares an anchor name (Codex impl-review #2).
  const refKey = (ref: string): string => {
    const r = parseSectionRef(ref);
    return `${r.file}#${r.anchor}`;
  };
  const specRefs = new Set(j.spec_sections.map((e) => refKey(e.ref)));
  for (const ref of adr.frontmatter.affected_spec_sections) {
    if (!specRefs.has(refKey(ref))) missing.push(`spec:${ref}`);
  }
  const prdRefs = new Set(j.prd_sections.map((e) => refKey(e.ref)));
  for (const ref of adr.frontmatter.affected_prd_sections) {
    if (!prdRefs.has(refKey(ref))) missing.push(`prd:${ref}`);
  }
  const taskIds = new Set(j.phases_tasks.map((e) => e.id));
  for (const id of adr.frontmatter.affected_phases_tasks) {
    if (!taskIds.has(id)) missing.push(`phases:${id}`);
  }
  if (missing.length > 0) {
    throw new ApplyError('JOURNAL_COVERAGE_MISMATCH', `journal does not cover ${missing.length} ADR-declared ref(s)`, {
      missing,
    });
  }
}

function applyMarkdownEntry(repoRoot: string, entry: MarkdownSectionEntry): void {
  const { file, anchor } = parseSectionRef(entry.ref);
  const abs = validateUnderRoot(resolve(repoRoot, file), repoRoot);
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ApplyError('IO_ERROR', `failed to read ${file}: ${(err as Error).message}`, { file });
  }
  writeAtomic(abs, replaceManagedSection(content, anchor, entry.new_body));
}

function applyPhasesEntry(repoRoot: string, entry: PhasesTaskEntry): void {
  const abs = validateUnderRoot(resolve(repoRoot, PHASES_PATH), repoRoot);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new ApplyError('IO_ERROR', `failed to read phases.yaml: ${(err as Error).message}`, { path: abs });
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new ApplyError('IO_ERROR', `phases.yaml YAML parse error: ${doc.errors[0]!.message}`, { path: abs });
  }
  const js = doc.toJS() as { phases?: Array<{ tasks?: Array<{ id?: string }> }> };
  let phaseIdx = -1;
  let taskIdx = -1;
  (js.phases ?? []).forEach((phase, p) => {
    (phase.tasks ?? []).forEach((task, t) => {
      if (task.id === entry.id) {
        phaseIdx = p;
        taskIdx = t;
      }
    });
  });
  if (phaseIdx < 0) {
    throw new ApplyError('PHASES_TASK_NOT_FOUND', `phases.yaml has no task '${entry.id}'`, { id: entry.id });
  }
  doc.setIn(['phases', phaseIdx, 'tasks', taskIdx, entry.field], entry.value);
  writeAtomic(abs, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
}

// Append a durable index line for an applied decision. Idempotent: keyed by
// slug, so a crash-then-resume re-run does not duplicate (Codex 2nd-pass r2).
function upsertDecisionIndex(repoRoot: string, slug: string, date: string): void {
  const abs = validateUnderRoot(resolve(repoRoot, INDEX_PATH), repoRoot);
  const header =
    '# Decision index\n\n' +
    '> Ephemeral ADRs are deleted after `/update-spec --apply`; this index is the\n' +
    "> durable, browsable record of each applied decision (FORGE-163). Each\n" +
    '> decision\'s full rationale lives in the SPEC sections it touched + the apply commit.\n\n';
  let existing = '';
  if (existsSync(abs)) {
    existing = readFileSync(abs, 'utf8');
  }
  const marker = `\`${slug}\``;
  if (existing.includes(marker)) return; // already indexed — idempotent
  const base = existing.length > 0 ? existing.replace(/\s*$/, '') : header.replace(/\s*$/, '');
  writeAtomic(abs, `${base}\n- ${date} — ${marker}\n`);
}

interface DryRunPlan {
  spec_sections: string[];
  prd_sections: string[];
  phases_tasks: string[];
  tracker_issues: string[];
}

function buildDryRunPlan(j: ApplyJournal): DryRunPlan {
  const show = <T extends { status: string }>(e: T, label: string) =>
    `${label}${e.status === 'applied' ? ' (applied)' : ''}`;
  return {
    spec_sections: j.spec_sections.map((e) => show(e, e.ref)),
    prd_sections: j.prd_sections.map((e) => show(e, e.ref)),
    phases_tasks: j.phases_tasks.map((e) => show(e, `${e.id}.${e.field}`)),
    tracker_issues: j.tracker_issues.map((e) => show(e, e.id)),
  };
}

export interface ApplyDecisionDeps {
  // Test seam (mirrors reconcile.ts): inject a tracker instead of resolving one
  // from settings.yaml. Production callers omit this.
  readonly trackerOverride?: Tracker;
}

export async function runOrchestrateApplyDecision(
  args: ApplyDecisionArgs,
  deps: ApplyDecisionDeps = {},
): Promise<{ exitCode: number }> {
  const parsed = ApplyDecisionArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;
  const json = opts.json;
  const repoRoot = opts.repoRoot ?? dirname(opts.forgeDir);
  const paths = journalPaths(opts.forgeDir, opts.slug);

  try {
    // 0. Already fully applied? (completed archive present ⇒ idempotent no-op.)
    if (existsSync(paths.completed)) {
      // A crash between the archive write and the active unlink (finalize step 4)
      // can leave a stale active journal; the archive is authoritative, so clean
      // it up here rather than leaving it to linger (Codex impl-review #3).
      if (existsSync(paths.active)) {
        try {
          unlinkSync(paths.active);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      return { exitCode: emit(ok({ slug: opts.slug, already_applied: true }), { json }) };
    }

    // 1. Journal must exist + be payload-complete (the verb does not synthesise
    //    content — FORGE-93 / a fixture authors the journal).
    const journal = readJournal(paths.active);
    if (!journal) {
      return {
        exitCode: emit(
          fail('MISSING_JOURNAL', `no apply journal for '${opts.slug}'`, false, {
            expected: paths.active,
            hint: 'run /update-spec --draft (FORGE-93) or supply a journal',
          }),
          { json },
        ),
      };
    }

    const finalizing = allEntriesApplied(journal);

    // 2. ADR gate. When resuming an all-applied journal into finalize the ADR may
    //    already be deleted — only re-read it if the rationale (commit-msg) is
    //    not yet written (ordering guarantees the ADR still exists then).
    // Gate on acceptance whenever the ADR file EXISTS on disk — never trust the
    // journal's finalize flags to imply a prior gate (a hand-authored journal
    // can set commit_msg_written=true without ever gating; Codex confirmation
    // pass). The only legitimate skip is a genuinely-absent ADR while resuming
    // an all-applied journal (a prior finalize already deleted it).
    let adr: ParsedAdr | null = null;
    let adrPath: string | null = null;
    try {
      adrPath = resolveAdrPath(repoRoot, opts.slug);
    } catch (err) {
      if (err instanceof ApplyError && err.code === 'ADR_NOT_FOUND' && finalizing) {
        adrPath = null; // resume past a prior delete — acceptable
      } else {
        throw err;
      }
    }
    if (adrPath) {
      adr = parseAdr(adrPath);
      assertAccepted(adr);
      if (!finalizing) assertCoverage(adr, journal);
    }

    // 3. Dry-run: report the plan, write nothing.
    if (opts.dryRun) {
      return { exitCode: emit(ok({ slug: opts.slug, dry_run: true, finalizing, plan: buildDryRunPlan(journal) }), { json }) };
    }

    // 4. Preflight: if any tracker entry still needs applying, the tracker must
    //    support body mutation — fail BEFORE any local mutation (no half-apply).
    const needsTracker = journal.tracker_issues.some((e) => e.status !== 'applied');
    let tracker: Tracker | null = null;
    let closeTracker: (() => Promise<void>) | undefined;
    if (needsTracker) {
      if (deps.trackerOverride) {
        tracker = deps.trackerOverride;
      } else {
        const settings = loadSettings(join(opts.forgeDir, 'settings.yaml'));
        const handle = createTracker(settings, noopLogger());
        tracker = handle.tracker;
        closeTracker = handle.close;
      }
      if (!trackerSupportsBodyMutation(tracker)) {
        if (closeTracker) await closeTracker().catch(() => {});
        return {
          exitCode: emit(
            fail('TRACKER_INCAPABLE', `tracker '${tracker.type}' cannot update issue bodies (see FORGE-117)`, false, {
              tracker: tracker.type,
            }),
            { json },
          ),
        };
      }
    }

    try {
      // 5. Apply pending/failed entries in order. Stop at the first failure so
      //    the user fixes the cause and re-runs --resume (AC: fail on entry 4 of
      //    7 → resume completes the rest). Entries are persisted after each
      //    transition; the entry was already 'pending' on disk (write-ahead).
      if (!finalizing) {
        const fail4 = await applyAllEntries(journal, paths.active, repoRoot, tracker);
        if (fail4) {
          return {
            exitCode: emit(
              fail('APPLY_FAILED', fail4.message, true, {
                applied: countApplied(journal),
                failed: fail4.ref,
                hint: 're-run with --resume',
              }),
              { json },
            ),
          };
        }
      }

      // 6. Finalize (world-state-idempotent, journaled). rationale is guaranteed
      //    available whenever a step that needs it has not yet run (ordering).
      const rationale = adr ? extractRationale(adr) : null;
      const date = adr?.frontmatter.date ?? new Date().toISOString().slice(0, 10);
      finalize(journal, paths, repoRoot, opts.slug, date, rationale);

      return { exitCode: emit(ok({ slug: opts.slug, applied: true, journal: paths.completed }), { json }) };
    } finally {
      if (closeTracker) await closeTracker().catch(() => {});
    }
  } catch (err) {
    if (err instanceof ApplyError) {
      return { exitCode: emit(fail(err.code, err.message, err.retriable, err.details), { json }) };
    }
    return { exitCode: emit(fail('IO_ERROR', err instanceof Error ? err.message : String(err), false), { json }) };
  }
}

function countApplied(j: ApplyJournal): number {
  const lists = [j.spec_sections, j.prd_sections, j.phases_tasks, j.tracker_issues];
  return lists.reduce((n, l) => n + l.filter((e) => e.status === 'applied').length, 0);
}

// Apply every non-applied entry in [spec, prd, phases, tracker] order. Returns
// a descriptor of the first failure (and records it in the journal) or null if
// all applied.
async function applyAllEntries(
  journal: ApplyJournal,
  journalPath: string,
  repoRoot: string,
  tracker: Tracker | null,
): Promise<{ ref: string; message: string } | null> {
  for (const e of journal.spec_sections) {
    if (e.status === 'applied') continue;
    const r = runEntry(() => applyMarkdownEntry(repoRoot, e), e, journal, journalPath, `spec:${e.ref}`);
    if (r) return r;
  }
  for (const e of journal.prd_sections) {
    if (e.status === 'applied') continue;
    const r = runEntry(() => applyMarkdownEntry(repoRoot, e), e, journal, journalPath, `prd:${e.ref}`);
    if (r) return r;
  }
  for (const e of journal.phases_tasks) {
    if (e.status === 'applied') continue;
    const r = runEntry(() => applyPhasesEntry(repoRoot, e), e, journal, journalPath, `phases:${e.id}`);
    if (r) return r;
  }
  for (const e of journal.tracker_issues) {
    if (e.status === 'applied') continue;
    if (!tracker) {
      e.status = 'failed';
      e.error = 'tracker not initialised';
      persistJournal(journalPath, journal);
      return { ref: `tracker:${e.id}`, message: 'tracker not initialised' };
    }
    try {
      await tracker.updateIssueBody(e.id, e.new_body);
      e.status = 'applied';
      e.applied_at = new Date().toISOString();
      delete e.error;
      persistJournal(journalPath, journal);
    } catch (err) {
      e.status = 'failed';
      e.retries += 1;
      e.error = err instanceof Error ? err.message : String(err);
      persistJournal(journalPath, journal);
      return { ref: `tracker:${e.id}`, message: e.error };
    }
  }
  return null;
}

function runEntry(
  mutate: () => void,
  entry: { status: 'pending' | 'applied' | 'failed'; applied_at?: string; error?: string },
  journal: ApplyJournal,
  journalPath: string,
  ref: string,
): { ref: string; message: string } | null {
  try {
    mutate();
    entry.status = 'applied';
    entry.applied_at = new Date().toISOString();
    delete entry.error;
    persistJournal(journalPath, journal);
    return null;
  } catch (err) {
    entry.status = 'failed';
    entry.error = err instanceof Error ? err.message : String(err);
    persistJournal(journalPath, journal);
    return { ref, message: entry.error };
  }
}

function finalize(
  journal: ApplyJournal,
  paths: JournalPaths,
  repoRoot: string,
  slug: string,
  date: string,
  rationale: string | null,
): void {
  // (1) commit-message body — overwrite is idempotent.
  if (!journal.finalize.commit_msg_written || !existsSync(paths.commitMsg)) {
    if (rationale === null) {
      throw new ApplyError('IO_ERROR', 'cannot write commit message: ADR rationale unavailable', { slug });
    }
    writeAtomic(paths.commitMsg, `${rationale}\n`);
    journal.finalize.commit_msg_written = true;
    persistJournal(paths.active, journal);
  }
  // (2) INDEX upsert — idempotent by slug.
  if (!journal.finalize.index_appended) {
    upsertDecisionIndex(repoRoot, slug, date);
    journal.finalize.index_appended = true;
    persistJournal(paths.active, journal);
  }
  // (3) delete ADR — only after rationale is durable; idempotent (ENOENT ok).
  if (!journal.finalize.adr_deleted) {
    deleteAdr(resolveAdrPathSafe(repoRoot, slug));
    journal.finalize.adr_deleted = true;
    persistJournal(paths.active, journal);
  }
  // (4) archive — last, so the active journal stays recoverable until now.
  journal.finalize.archived = true;
  journal.completed_at = new Date().toISOString();
  writeAtomic(paths.completed, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    unlinkSync(paths.active);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Resolve the ADR path for deletion without throwing when it's already gone —
// returns a best-effort path (deleteAdr then no-ops on ENOENT).
function resolveAdrPathSafe(repoRoot: string, slug: string): string {
  try {
    return resolveAdrPath(repoRoot, slug);
  } catch {
    // Already deleted (a prior --resume): hand deleteAdr a path it will ENOENT on.
    return join(repoRoot, 'spec/decisions', `${slug}.md`);
  }
}

export const applyDecisionHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Apply an accepted ephemeral ADR across SPEC/PRD/phases/tracker via a resumable journal.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const slug = parseFlag(rest, 'adr') ?? firstPositional(rest) ?? '';
    const repoRoot = parseFlag(rest, 'repo-root');
    return runOrchestrateApplyDecision({
      slug,
      yesAll: hasFlag(rest, 'yes-all'),
      resume: hasFlag(rest, 'resume'),
      dryRun: hasFlag(rest, 'dry-run'),
      ...(repoRoot ? { repoRoot } : {}),
      forgeDir,
      json: hasFlag(rest, 'json'),
    });
  },
};
