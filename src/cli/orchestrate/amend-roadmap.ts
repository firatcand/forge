// `forge orchestrate amend-roadmap --payload <file.json> [--resume <task-id>] [--json]`
//
// Mid-flight roadmap mutation (FORGE-101 / P2.5-T10). TRACKER-FIRST: the verb
// (1) creates the issue on the tracker, (2) wires blocked-by relations, then
// (3) materializes the task into phases.yaml THROUGH the reconcile --pull
// machinery (staged addition) — preserving the SPEC invariant that phases.yaml
// is written only by the reconcile pull path. Every step is journaled under
// .forge/orchestrator/global/amend-journal/<task-id>.json so a partial failure
// resumes with --resume; the O_EXCL journal create doubles as the task-id
// reservation against concurrent amends.
//
// Per the skill↔verb contract the verb has NO human prompts — /amend-roadmap
// (the skill) collects fields interactively and authors the payload file.
//
// After success the verb prints a lightweight drift warning: the active
// attempts (per ACTIVE_STATES) whose worktrees now run against a roadmap that
// changed under them. Informational only — the worktree-drift-guard verb was
// dropped (FORGE-103 canceled); this inline notice is its v0.4 replacement.

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';

import {
  AmendJournalSchema,
  AmendPayloadSchema,
  amendPayloadHash,
  type AmendJournal,
  type AmendPayload,
} from '../../schemas/amend-journal.ts';
import { TaskStateSchema } from '../../schemas/task-state.ts';
import { type Phase, type Task } from '../../schemas/phases.ts';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { loadSettings } from '../../core/settings.ts';
import { validateUnderRoot } from '../../core/workspace.ts';
import { ACTIVE_STATES } from '../../orchestrator/readiness.ts';
import { renderTaskBody } from '../../orchestrator/reconcile.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import type { Issue } from '../../trackers/types.ts';
import { createTracker } from './tracker-factory.ts';
import { loadPhasesWithDocument, runOrchestrateReconcile } from './reconcile.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

const PHASES_PATH = 'plans/phases.yaml';
const JOURNAL_SUBDIR = ['orchestrator', 'global', 'amend-journal'];
const PAYLOAD_FILE_MAX_BYTES = 256 * 1024; // 256 KiB — payloads are small JSON

interface JournalPaths {
  readonly dir: string;
  readonly active: string;
  readonly completed: string;
}

function journalPaths(forgeDir: string, taskId: string): JournalPaths {
  const dir = join(forgeDir, ...JOURNAL_SUBDIR);
  return {
    dir,
    active: join(dir, `${taskId}.json`),
    completed: join(dir, 'completed', `${taskId}.json`),
  };
}

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function persistJournal(path: string, journal: AmendJournal): void {
  writeAtomic(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function readJournal(path: string): AmendJournal | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read amend journal: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`amend journal is not valid JSON: ${(err as Error).message}`);
  }
  const result = AmendJournalSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `amend journal failed schema validation: ${result.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return result.data;
}

// Compute the next free task id in `phase`: max T-number across that phase's
// tasks + 1, then bump past any global collision (suffixed ids like P2-T04a
// count toward the max of their numeric stem). Zero-padded to 2 digits to
// match the house style (P1-T01).
export function computeNextTaskId(
  phases: readonly Phase[],
  phaseId: string,
): string {
  const phaseNum = phaseId.replace(/^phase-/, '');
  const allIds = new Set<string>();
  let maxN = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      allIds.add(task.id);
      if (phase.id !== phaseId) continue;
      const m = /^P\d+(?:\.\d+)?-T(\d+)[a-z]?$/.exec(task.id);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
  }
  let n = maxN + 1;
  let candidate = `P${phaseNum}-T${String(n).padStart(2, '0')}`;
  while (allIds.has(candidate)) {
    n += 1;
    candidate = `P${phaseNum}-T${String(n).padStart(2, '0')}`;
  }
  return candidate;
}

// Resolve each payload depends_on entry (task id OR tracker identifier)
// against phases.yaml. Every dep must exist AND have tracker backing
// (tracker_issue_id) — a local-only dep can't be wired as a tracker relation,
// and an unwirable relation would silently vanish on the next --pull.
interface ResolvedDep {
  readonly taskId: string;
  readonly trackerIssueId: string;
}

function resolveDependencies(
  phases: readonly Phase[],
  dependsOn: readonly string[],
): { resolved: ResolvedDep[] } | { error: string } {
  const byTaskId = new Map<string, Task>();
  const byTrackerId = new Map<string, Task>();
  for (const phase of phases) {
    for (const task of phase.tasks) {
      byTaskId.set(task.id, task);
      if (task.tracker_issue_id) byTrackerId.set(task.tracker_issue_id, task);
    }
  }
  const resolved: ResolvedDep[] = [];
  const seen = new Set<string>();
  for (const dep of dependsOn) {
    const task = byTaskId.get(dep) ?? byTrackerId.get(dep);
    if (!task) {
      return { error: `depends_on references unknown task '${dep}' (not a task id or tracker identifier in phases.yaml)` };
    }
    if (!task.tracker_issue_id) {
      return {
        error: `depends_on task '${task.id}' has no tracker_issue_id — a tracker relation cannot be wired to a local-only task. Run /reconcile or /push-to-tracker first.`,
      };
    }
    if (seen.has(task.id)) continue; // dedupe (id + identifier both naming one task)
    seen.add(task.id);
    resolved.push({ taskId: task.id, trackerIssueId: task.tracker_issue_id });
  }
  resolved.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { resolved };
}

// Map resolved tracker_issue_id values (which phases.yaml may store as either
// internal ids or human identifiers) to the tracker's INTERNAL issue id, which
// is what setBlockedBy requires (GitHub needs the numeric id; Linear the UUID).
function indexIssues(issues: readonly Issue[]): Map<string, Issue> {
  const byAny = new Map<string, Issue>();
  for (const issue of issues) {
    byAny.set(issue.id, issue);
    byAny.set(issue.identifier, issue);
  }
  return byAny;
}

interface DriftWarning {
  readonly task_id: string;
  readonly state: string;
  readonly attempt_id: string | null;
}

// Lightweight inline replacement for the dropped worktree-drift-guard
// (FORGE-103): list every active attempt so the supervisor knows which
// in-flight worktrees now run against a mutated roadmap. Tolerant scan —
// unreadable/corrupt state files are skipped, matching readiness.ts.
function collectDriftWarnings(forgeDir: string): DriftWarning[] {
  const tasksRoot = join(forgeDir, 'orchestrator', 'tasks');
  let entries: string[];
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    return [];
  }
  const out: DriftWarning[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(tasksRoot, entry, 'state.json'), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = TaskStateSchema.safeParse(parsed);
    if (!result.success) continue;
    if (!ACTIVE_STATES.has(result.data.state)) continue;
    out.push({
      task_id: result.data.task_id,
      state: result.data.state,
      attempt_id: result.data.current_attempt_id,
    });
  }
  out.sort((a, b) => a.task_id.localeCompare(b.task_id));
  return out;
}

// Build the complete Task that will be staged into phases.yaml. depends_on
// carries canonical task ids; tracker_issue_id carries the human identifier
// (FORGE-NN) matching the house convention in the live phases.yaml.
function buildStagedTask(
  taskId: string,
  payload: AmendPayload,
  resolvedDeps: readonly ResolvedDep[],
  trackerIdentifier: string,
): Task {
  return {
    id: taskId,
    tracker_issue_id: trackerIdentifier,
    title: payload.title,
    description: payload.description,
    type: payload.type,
    priority: payload.priority,
    depends_on: resolvedDeps.map((d) => d.taskId),
    estimate: payload.estimate,
    owner_type: payload.owner_type,
    acceptance: [...payload.acceptance],
    ...(payload.write_globs ? { write_globs: [...payload.write_globs] } : {}),
  };
}

// Sink for the internal reconcile invocation: we keep its streams out of our
// stdout (single-envelope discipline) but retain the tail for error context.
class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: unknown, _enc: string, cb: () => void): void {
    this.chunks.push(String(chunk));
    if (this.chunks.length > 64) this.chunks.shift();
    cb();
  }
  tail(): string {
    return this.chunks.join('').trim().slice(-2_000);
  }
}

export interface AmendRoadmapOptions {
  readonly payloadPath?: string;
  readonly resumeTaskId?: string;
  readonly forgeDir: string;
  readonly repoRoot?: string;
  readonly json: boolean;
}

export interface AmendRoadmapDeps {
  // Test seam (mirrors reconcile.ts / apply-decision.ts).
  readonly trackerOverride?: Tracker;
}

export async function runOrchestrateAmendRoadmap(
  opts: AmendRoadmapOptions,
  deps: AmendRoadmapDeps = {},
): Promise<{ exitCode: number }> {
  const json = opts.json;
  const repoRoot = opts.repoRoot ?? dirname(opts.forgeDir);

  // ── Load payload ──────────────────────────────────────────────────────────
  if (!opts.payloadPath && !opts.resumeTaskId) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', '--payload <file.json> is required (or --resume <task-id>)', false),
        { json },
      ),
    };
  }
  // --resume feeds journalPaths() directly — validate it as a canonical task
  // id BEFORE any path construction so traversal input ('../../x') can never
  // escape the journal directory (Codex impl-review block #1).
  if (opts.resumeTaskId && !/^P\d+(\.\d+)?-T\d+$/.test(opts.resumeTaskId)) {
    return {
      exitCode: emit(
        fail(
          'INVALID_ARGS',
          `--resume must be a canonical task id (P<phase>-T<nn>); got '${opts.resumeTaskId}'`,
          false,
        ),
        { json },
      ),
    };
  }

  // ── Load + validate phases.yaml ───────────────────────────────────────────
  let phasesPath: string;
  try {
    phasesPath = validateUnderRoot(resolve(repoRoot, PHASES_PATH), repoRoot);
  } catch (e) {
    return {
      exitCode: emit(fail('INVALID_CONFIG', e instanceof Error ? e.message : String(e), false), {
        json,
      }),
    };
  }
  let loaded: ReturnType<typeof loadPhasesWithDocument>;
  try {
    loaded = loadPhasesWithDocument(phasesPath);
  } catch (e) {
    return {
      exitCode: emit(
        fail('PHASES_INVALID', e instanceof Error ? e.message : String(e), false),
        { json },
      ),
    };
  }
  if (!loaded.phases.source) {
    return {
      exitCode: emit(
        fail(
          'NO_TRACKER_BINDING',
          'phases.yaml has no source stanza — amend-roadmap requires a tracker-bound roadmap. Run /push-to-tracker or /reconcile --pull first.',
          false,
        ),
        { json },
      ),
    };
  }

  // ── Resume path: locate + validate the existing journal ──────────────────
  let journal: AmendJournal;
  let paths: JournalPaths;
  // True whenever the journal pre-existed this invocation (--resume OR the
  // implicit same-payload re-run). Any pre-existing journal means a previous
  // run may have reached the tracker — even with create_issue still 'pending',
  // a crash can land between the createIssue round-trip and the journal
  // persist. The adoption scan keys off this, NOT off status === 'failed'
  // (Codex impl-review block #2).
  let journalPreExisted = false;
  if (opts.resumeTaskId) {
    journalPreExisted = true;
    paths = journalPaths(opts.forgeDir, opts.resumeTaskId);
    if (existsSync(paths.completed)) {
      // Crash between archive write and active unlink: archive is
      // authoritative — clean the stale active journal (apply-decision
      // semantics) and report idempotent success.
      if (existsSync(paths.active)) {
        try {
          unlinkSync(paths.active);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      return {
        exitCode: emit(ok({ task_id: opts.resumeTaskId, already_applied: true }), { json }),
      };
    }
    let read: AmendJournal | null;
    try {
      read = readJournal(paths.active);
    } catch (e) {
      return {
        exitCode: emit(
          fail('JOURNAL_INVALID', e instanceof Error ? e.message : String(e), false),
          { json },
        ),
      };
    }
    if (!read) {
      return {
        exitCode: emit(
          fail('MISSING_JOURNAL', `no amend journal for '${opts.resumeTaskId}'`, false, {
            expected: paths.active,
          }),
          { json },
        ),
      };
    }
    journal = read;
    // A payload supplied alongside --resume must hash-match the journal —
    // a mutated payload can never graft onto a half-applied amend.
    if (opts.payloadPath) {
      const reparsed = loadPayloadFile(opts.payloadPath, repoRoot);
      if ('error' in reparsed) {
        return { exitCode: emit(reparsed.error, { json }) };
      }
      if (amendPayloadHash(reparsed.payload) !== journal.payload_hash) {
        return {
          exitCode: emit(
            fail(
              'PAYLOAD_MISMATCH',
              'payload does not match the journaled amend — resume with the original payload or finish/remove the journal',
              false,
              { journal: paths.active },
            ),
            { json },
          ),
        };
      }
    }
  } else {
    // ── Fresh path: validate payload, plan, reserve id via O_EXCL journal ───
    const parsedPayload = loadPayloadFile(opts.payloadPath!, repoRoot);
    if ('error' in parsedPayload) {
      return { exitCode: emit(parsedPayload.error, { json }) };
    }
    const payload = parsedPayload.payload;

    const phase = loaded.phases.phases.find((p) => p.id === payload.phase);
    if (!phase) {
      return {
        exitCode: emit(
          fail('PHASE_NOT_FOUND', `phases.yaml has no phase '${payload.phase}'`, false),
          { json },
        ),
      };
    }
    const depResult = resolveDependencies(loaded.phases.phases, payload.depends_on);
    if ('error' in depResult) {
      return { exitCode: emit(fail('INVALID_DEPENDENCY', depResult.error, false), { json }) };
    }

    const taskId = computeNextTaskId(loaded.phases.phases, payload.phase);
    paths = journalPaths(opts.forgeDir, taskId);

    journal = {
      version: 1,
      task_id: taskId,
      phase: payload.phase,
      payload,
      payload_hash: amendPayloadHash(payload),
      resolved_depends_on: depResult.resolved.map((d) => d.taskId),
      started_at: new Date().toISOString(),
      create_issue: { status: 'pending' },
      relations: depResult.resolved.map((d) => ({
        status: 'pending' as const,
        blocker_task_id: d.taskId,
        blocker_issue_id: d.trackerIssueId,
        retries: 0,
      })),
      reconcile_pull: { status: 'pending' },
    };

    // O_EXCL create = task-id reservation. A concurrent amend that computed
    // the same id loses this race and gets a clear EEXIST error instead of
    // silently sharing (and corrupting) one journal.
    mkdirSync(paths.dir, { recursive: true });
    try {
      writeFileSync(paths.active, `${JSON.stringify(journal, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Same payload re-run without --resume? Treat as implicit resume.
        let existing: AmendJournal | null = null;
        try {
          existing = readJournal(paths.active);
        } catch {
          existing = null;
        }
        if (existing && existing.payload_hash === journal.payload_hash) {
          journal = existing;
          journalPreExisted = true;
        } else {
          return {
            exitCode: emit(
              fail(
                'JOURNAL_EXISTS',
                `an amend journal already reserves '${taskId}' with a different payload — finish it with --resume ${taskId} or remove it`,
                false,
                { journal: paths.active },
              ),
              { json },
            ),
          };
        }
      } else {
        throw err;
      }
    }
  }

  // ── Execute pending steps (tracker-first) ─────────────────────────────────
  const anyTrackerWork =
    journal.create_issue.status !== 'applied' ||
    journal.relations.some((r) => r.status !== 'applied');
  const needsReconcile = journal.reconcile_pull.status !== 'applied';

  let tracker: Tracker | null = null;
  let closeTracker: (() => Promise<void>) | undefined;
  if (anyTrackerWork || needsReconcile) {
    if (deps.trackerOverride) {
      tracker = deps.trackerOverride;
    } else {
      try {
        const settings = loadSettings(join(opts.forgeDir, 'settings.yaml'));
        const handle = createTracker(settings, noopLogger());
        tracker = handle.tracker;
        closeTracker = handle.close;
      } catch (e) {
        return {
          exitCode: emit(
            fail('INVALID_CONFIG', e instanceof Error ? e.message : String(e), false),
            { json },
          ),
        };
      }
    }
    // The roadmap is bound to ONE provider (source.tracker). Mutating a
    // different provider would create the issue in the wrong system and stamp
    // inconsistent source metadata on the next pull — refuse up front (Codex
    // impl-review block #3).
    if (tracker && loaded.phases.source && tracker.type !== loaded.phases.source.tracker) {
      if (closeTracker) await closeTracker().catch(() => {});
      return {
        exitCode: emit(
          fail(
            'SOURCE_TRACKER_MISMATCH',
            `phases.yaml source.tracker is '${loaded.phases.source.tracker}' but the configured tracker is '${tracker.type}' — amend refused`,
            false,
          ),
          { json },
        ),
      };
    }
  }

  try {
    // Step 1: createIssue (with adoption scan on resume).
    if (journal.create_issue.status !== 'applied') {
      const wasAttempted = journal.create_issue.status === 'failed' || journalPreExisted;
      try {
        let adopted: Issue | null = null;
        if (wasAttempted) {
          // The previous run may have created the issue and crashed before
          // journaling it. Adoption requires a PROVABLY complete tracker view:
          // a truncated listing can neither establish exactly-one-match nor
          // prove the previous createIssue didn't succeed off-page, so any
          // truncated view refuses outright (Codex impl-review block #4).
          const page = await tracker!.listAllIssues();
          if (page.truncated) {
            throw new Error(
              'tracker issue list was truncated — cannot establish whether the previous createIssue succeeded. Locate any existing issue for ' +
                `'${journal.task_id}' on the tracker manually, resolve, then --resume`,
            );
          }
          const matches = page.issues.filter((i) => i.forgeTaskId === journal.task_id);
          if (matches.length > 1) {
            throw new Error(
              `adoption scan found ${matches.length} issues carrying forge task id '${journal.task_id}' — resolve the duplicates on the tracker, then --resume`,
            );
          }
          if (matches.length === 1) {
            if (matches[0]!.title !== journal.payload.title) {
              throw new Error(
                `adoption scan found issue '${matches[0]!.identifier}' carrying forge task id '${journal.task_id}' but with a different title — refusing to adopt; resolve manually, then --resume`,
              );
            }
            adopted = matches[0]!;
          }
        }
        const phase = loaded.phases.phases.find((p) => p.id === journal.phase);
        if (!phase) {
          throw new Error(`phases.yaml no longer has phase '${journal.phase}'`);
        }
        const bodyTask = buildStagedTask(
          journal.task_id,
          journal.payload,
          journal.relations.map((r) => ({
            taskId: r.blocker_task_id,
            trackerIssueId: r.blocker_issue_id,
          })),
          journal.create_issue.identifier ?? '',
        );
        const issue =
          adopted ??
          (await tracker!.createIssue({
            title: journal.payload.title,
            body: renderTaskBody(bodyTask, phase),
            forgeTaskId: journal.task_id,
            ownerType: journal.payload.owner_type,
            acceptance: [...journal.payload.acceptance],
            dependsOn: journal.relations.map((r) => r.blocker_issue_id),
          }));
        journal.create_issue = {
          status: 'applied',
          applied_at: new Date().toISOString(),
          issue_id: issue.id,
          identifier: issue.identifier,
          ...(issue.url ? { url: issue.url } : {}),
        };
        persistJournal(paths.active, journal);
      } catch (e) {
        journal.create_issue.status = 'failed';
        journal.create_issue.error = e instanceof Error ? e.message : String(e);
        persistJournal(paths.active, journal);
        return {
          exitCode: emit(
            fail('CREATE_ISSUE_FAILED', journal.create_issue.error, true, {
              hint: `re-run with --resume ${journal.task_id}`,
            }),
            { json },
          ),
        };
      }
    }

    // Step 2: relations — resolve blocker tracker_issue_id values (which may
    // be identifiers) to internal ids, then setBlockedBy per entry.
    const pendingRelations = journal.relations.filter((r) => r.status !== 'applied');
    if (pendingRelations.length > 0) {
      let issueIndex: Map<string, Issue>;
      try {
        const page = await tracker!.listAllIssues();
        issueIndex = indexIssues(page.issues);
      } catch (e) {
        return {
          exitCode: emit(
            fail('TRACKER_ERROR', e instanceof Error ? e.message : String(e), true, {
              hint: `re-run with --resume ${journal.task_id}`,
            }),
            { json },
          ),
        };
      }
      for (const rel of pendingRelations) {
        const blocker = issueIndex.get(rel.blocker_issue_id);
        const newIssueId = journal.create_issue.issue_id!;
        try {
          if (!blocker) {
            throw new Error(
              `blocker '${rel.blocker_issue_id}' (task ${rel.blocker_task_id}) not found on the tracker`,
            );
          }
          await tracker!.setBlockedBy(newIssueId, blocker.id);
          rel.status = 'applied';
          rel.applied_at = new Date().toISOString();
          delete rel.error;
          persistJournal(paths.active, journal);
        } catch (e) {
          rel.status = 'failed';
          rel.retries += 1;
          rel.error = e instanceof Error ? e.message : String(e);
          persistJournal(paths.active, journal);
          return {
            exitCode: emit(
              fail('SET_RELATION_FAILED', rel.error, true, {
                blocker: rel.blocker_task_id,
                hint: `re-run with --resume ${journal.task_id}`,
              }),
              { json },
            ),
          };
        }
      }
    }

    // Step 3: materialize into phases.yaml via reconcile --pull + staged
    // addition. Idempotent: insertTaskIntoDocument skips an existing id.
    if (journal.reconcile_pull.status !== 'applied') {
      const stagedTask = buildStagedTask(
        journal.task_id,
        journal.payload,
        journal.relations.map((r) => ({
          taskId: r.blocker_task_id,
          trackerIssueId: r.blocker_issue_id,
        })),
        journal.create_issue.identifier!,
      );
      const outCap = new CaptureStream();
      const errCap = new CaptureStream();
      let exitCode: number;
      try {
        const result = await runOrchestrateReconcile({
          cwd: repoRoot,
          argv: ['--pull', '--no-prune', '--json'],
          stdout: outCap,
          stderr: errCap,
          ...(tracker ? { trackerOverride: tracker } : {}),
          stagedAdditions: [{ phaseId: journal.phase, task: stagedTask }],
        });
        exitCode = result.exitCode;
      } catch (e) {
        exitCode = -1;
        errCap.chunks.push(e instanceof Error ? e.message : String(e));
      }
      // Verify against the WORLD, not the exit code alone: the task must now
      // exist in phases.yaml (Codex pre-opinion — don't trust `applied`) AND
      // be bound to OUR issue — an unrelated task that took the reserved id
      // while this amend sat half-applied must not count as materialized.
      let materialized = false;
      if (exitCode === 0) {
        try {
          const reloaded = loadPhasesWithDocument(phasesPath);
          materialized = reloaded.phases.phases.some((p) =>
            p.tasks.some(
              (t) =>
                t.id === journal.task_id &&
                t.tracker_issue_id === journal.create_issue.identifier,
            ),
          );
        } catch {
          materialized = false;
        }
      }
      if (!materialized) {
        journal.reconcile_pull.status = 'failed';
        journal.reconcile_pull.error =
          `reconcile --pull did not materialize ${journal.task_id} (exit ${exitCode}): ${errCap.tail()}`;
        persistJournal(paths.active, journal);
        return {
          exitCode: emit(
            fail('RECONCILE_FAILED', journal.reconcile_pull.error, true, {
              hint: `re-run with --resume ${journal.task_id}`,
            }),
            { json },
          ),
        };
      }
      journal.reconcile_pull.status = 'applied';
      journal.reconcile_pull.applied_at = new Date().toISOString();
      delete journal.reconcile_pull.error;
      persistJournal(paths.active, journal);
    }

    // ── Finalize: archive before unlink (apply-decision semantics) ─────────
    journal.completed_at = new Date().toISOString();
    writeAtomic(paths.completed, `${JSON.stringify(journal, null, 2)}\n`);
    try {
      unlinkSync(paths.active);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // ── Drift warning (informational, replaces worktree-drift-guard) ───────
    const drift = collectDriftWarnings(opts.forgeDir);
    if (drift.length > 0 && !json) {
      process.stderr.write(
        `amend-roadmap: roadmap changed under ${drift.length} active attempt(s):\n` +
          drift.map((d) => `  - ${d.task_id} [${d.state}]`).join('\n') +
          '\n  (informational — workers re-read phases.yaml on their next verb call)\n',
      );
    }

    return {
      exitCode: emit(
        ok({
          task_id: journal.task_id,
          tracker_identifier: journal.create_issue.identifier,
          tracker_issue_id: journal.create_issue.issue_id,
          ...(journal.create_issue.url ? { url: journal.create_issue.url } : {}),
          depends_on: journal.resolved_depends_on,
          phases_updated: true,
          journal: paths.completed,
          drift_warnings: drift,
        }),
        { json },
      ),
    };
  } finally {
    if (closeTracker) {
      try {
        await closeTracker();
      } catch {
        // Best-effort tear-down — never mask the verb's primary exit code.
      }
    }
  }
}

function loadPayloadFile(
  payloadPath: string,
  repoRoot: string,
): { payload: AmendPayload } | { error: ReturnType<typeof fail> } {
  let abs: string;
  try {
    // Operator-supplied input file (typically /tmp, skill-authored) — read
    // as-is with a size cap, matching `complete.ts --verdict-file`. The
    // under-root guard applies to paths the verb WRITES, not inputs the
    // operator explicitly hands it.
    abs = resolve(repoRoot, payloadPath);
    const st = statSync(abs);
    if (st.size > PAYLOAD_FILE_MAX_BYTES) {
      return {
        error: fail('PAYLOAD_TOO_LARGE', `payload exceeds ${PAYLOAD_FILE_MAX_BYTES} bytes`, false),
      };
    }
  } catch (e) {
    return {
      error: fail('PAYLOAD_NOT_FOUND', e instanceof Error ? e.message : String(e), false),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return {
      error: fail('PAYLOAD_PARSE_ERROR', e instanceof Error ? e.message : String(e), false),
    };
  }
  const result = AmendPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      error: fail(
        'PAYLOAD_INVALID',
        `payload failed validation: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'unknown'}`,
        false,
      ),
    };
  }
  return { payload: result.data };
}

export const amendRoadmapHandler: VerbHandler = {
  band: 'mutate',
  synopsis:
    'Create a new task mid-flight: tracker-first issue + relations, then materialize into phases.yaml via reconcile (resumable journal).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const payloadPath = parseFlag(rest, 'payload');
    const resumeTaskId = parseFlag(rest, 'resume');
    const repoRoot = parseFlag(rest, 'repo-root');
    return runOrchestrateAmendRoadmap({
      ...(payloadPath ? { payloadPath } : {}),
      ...(resumeTaskId ? { resumeTaskId } : {}),
      ...(repoRoot ? { repoRoot } : {}),
      forgeDir,
      json: hasFlag(rest, 'json'),
    });
  },
};
