// `forge orchestrate reconcile --pull|--push [--dry-run] [--json] [--confirm-prune] [--no-prune]`
//
// Bidirectional sync between plans/phases.yaml and the tracker. See
// plans/tasks/FORGE-100.plan.md for the canonical design + decisions.
//
// Per spec/ORCHESTRATOR.md §CLI surface: read-only verbs emit `{ ok, data }`
// JSON on stdout; mutating verbs do the same after applying. This verb is
// mutating in both directions (--pull writes phases.yaml; --push calls
// updateIssueBody on the tracker), so the skill is responsible for confirming
// destructive operations (orphan prune).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { computeFreshnessLine } from '../../core/freshness.ts';
import { loadSettings } from '../../core/settings.ts';
import { computeSpecRevision } from '../../core/spec-revision.ts';
import { validateUnderRoot } from '../../core/workspace.ts';
import { PhasesSchema, type Phases, type Source } from '../../schemas/phases.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import {
  TrackerError,
  type TrackerErrorCode,
} from '../../trackers/errors.ts';
import { createTracker } from './tracker-factory.ts';
import {
  applyPlanToDocument,
  diffPull,
  diffPush,
  insertTaskIntoDocument,
  type PullPlan,
  type PushPlan,
  type StagedAddition,
} from '../../orchestrator/reconcile.ts';

const PHASES_PATH_DEFAULT = 'plans/phases.yaml';
const SETTINGS_PATH_DEFAULT = '.forge/settings.yaml';
const PHASES_FILE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

// ---- phases.yaml write lock ------------------------------------------------
//
// --pull is a read-modify-write over phases.yaml. Two concurrent writers
// (two amends staging into different phases, or an amend racing a plain
// reconcile) each read the same snapshot and writeAtomic in sequence — the
// later write silently drops the earlier one's mutation (Codex impl-review,
// FORGE-101). An exclusive advisory lock around the whole pull serializes
// every phases.yaml writer. O_EXCL create is the acquire; staleness =
// holder-pid dead OR lock older than LOCK_STALE_MS (crash recovery).
//
// Ownership discipline (Codex impl-review round 3): pathname-only unlink is
// unsafe — a stale-steal contender could nuke a SUCCESSOR's fresh lock, and a
// timed-out original holder could late-release its successor's lock. Two
// mechanisms close both holes:
//   1. Every unlink is RAW-BYTE compare-before-unlink: the deleter re-reads
//      the lock file and removes it only if its content is byte-identical to
//      what it owns (release) or what it inspected (steal). A lock that
//      changed hands since inspection is never touched.
//   2. Stale takeover is SERIALIZED through a steal-mutex (`<lock>.steal`,
//      O_EXCL): only one contender at a time may run the re-inspect → unlink
//      sequence, so two stealers can never interleave around the same stale
//      lock. While the steal-mutex is held, the only way the main lock can
//      reappear is a fresh O_EXCL acquire — which the stealer then loses to,
//      correctly, on its next acquire attempt.
const PHASES_LOCK_SUBPATH = ['.forge', 'orchestrator', 'global', 'phases-write.lock'];
const LOCK_STALE_MS = 5 * 60_000;
const STEAL_LOCK_STALE_MS = 30_000; // steal critical section is microseconds
const LOCK_RETRIES = 25;
const LOCK_RETRY_DELAY_MS = 200;
// A holder may release (unlink) its lock only while the lock is provably NOT
// stealable — strictly inside the staleness horizon. Past this window the
// holder must leave the file for age-steal and abort any pending write. This
// disjointness is what makes the pathname unlink race-free; see the proof
// sketch on unlinkIfUnchanged.
const LOCK_RELEASE_SAFE_FRACTION = 0.8;

// Bounded env overrides (FORGE_PHASES_LOCK_RETRIES / _RETRY_DELAY_MS) for
// operators with unusually long pulls — and for tests, where the default 5s
// worst-case wait interferes with the node:test child-process reporter.
function lockTuning(): { retries: number; delayMs: number; staleMs: number } {
  const retries = Number.parseInt(process.env.FORGE_PHASES_LOCK_RETRIES ?? '', 10);
  const delayMs = Number.parseInt(process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS ?? '', 10);
  const staleMs = Number.parseInt(process.env.FORGE_PHASES_LOCK_STALE_MS ?? '', 10);
  return {
    retries: Number.isInteger(retries) && retries > 0 && retries <= 1_000 ? retries : LOCK_RETRIES,
    delayMs: Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 10_000 ? delayMs : LOCK_RETRY_DELAY_MS,
    staleMs:
      Number.isInteger(staleMs) && staleMs >= 50 && staleMs <= 3_600_000 ? staleMs : LOCK_STALE_MS,
  };
}

// Read a lock file's raw bytes; null = missing. (Corrupt is indistinguishable
// from tampered — both compare unequal and are handled by staleness.)
function readLockRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Staleness of a lock file's content: unparseable → stale; holder pid dead →
// stale; older than staleMs → stale (NaN-safe: unparseable acquired_at is
// NOT (age < staleMs) → stale).
function lockContentIsStale(raw: string, staleMs: number): boolean {
  let holder: { pid?: number; acquired_at?: string };
  try {
    holder = JSON.parse(raw) as { pid?: number; acquired_at?: string };
  } catch {
    return true;
  }
  const age = Date.now() - Date.parse(holder.acquired_at ?? '');
  let alive = false;
  if (typeof holder.pid === 'number') {
    try {
      process.kill(holder.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return !alive || !(age < staleMs);
}

// Unlink `path` only if its content is still byte-identical to `expectedRaw`.
// ENOENT at any point is fine (someone else legitimately removed it).
//
// The read→unlink pair is not atomic, but every caller's PRECONDITION makes
// the residual interleaving impossible rather than merely unlikely:
//   - release() runs only while age(myBody) < staleMs × 0.8 — strictly inside
//     the staleness horizon, so no stealer's re-inspection can judge those
//     same bytes stale (one clock, same content). The only other principals
//     who could replace the path are the owner (us) and fresh acquirers, who
//     need the path FREE first (O_EXCL).
//   - the steal path runs under the steal-mutex AND re-verified the bytes as
//     stale; the only principal who could remove/replace a stale lock's path
//     is its owner releasing — excluded above, because release refuses past
//     the safe window. Other stealers hold no mutex; acquirers need a free
//     path.
// So between any caller's read and unlink, no legal writer of this path
// exists. (FORGE-87's flock would make this kernel-enforced; until then this
// condition-disjointness argument is the contract — keep both sides in sync.)
function unlinkIfUnchanged(path: string, expectedRaw: string): void {
  const current = readLockRaw(path);
  if (current === null || current !== expectedRaw) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// One serialized stale-takeover attempt. Returns without acquiring anything —
// on success the main lock is gone and the caller's next O_EXCL attempt
// competes fairly with every other waiter.
function attemptStealUnderMutex(lockPath: string, inspectedRaw: string): void {
  const stealPath = `${lockPath}.steal`;
  const stealBody = JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() });
  try {
    writeFileSync(stealPath, stealBody, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another contender is mid-takeover. If ITS mutex is stale (stealer
    // crashed in the microsecond critical section), clear it the same
    // compare-before-unlink way; either way, retry on the next loop pass.
    const currentSteal = readLockRaw(stealPath);
    if (currentSteal !== null && lockContentIsStale(currentSteal, STEAL_LOCK_STALE_MS)) {
      unlinkIfUnchanged(stealPath, currentSteal);
    }
    return;
  }
  try {
    // Under the mutex: remove the stale main lock ONLY if it is still exactly
    // the content we judged stale. If it changed (released + freshly
    // re-acquired by someone else), it is a live lock — leave it.
    unlinkIfUnchanged(lockPath, inspectedRaw);
  } finally {
    unlinkIfUnchanged(stealPath, stealBody);
  }
}

// Handle returned by acquirePhasesWriteLock. assertFresh() is the holder-side
// half of the disjointness contract: a writer must prove its lock is still
// inside the safe window IMMEDIATELY before mutating phases.yaml — a pull
// that outlived the staleness horizon may have been age-stolen, and writing
// anyway would reintroduce the lost update the lock exists to prevent.
export interface PhasesWriteLock {
  release(): void;
  assertFresh(): void;
}

// Exported for amend-roadmap, apply-decision, and the lock-discipline unit
// tests; within this file runOrchestrateReconcile is the caller.
export async function acquirePhasesWriteLock(cwd: string): Promise<PhasesWriteLock> {
  const lockPath = join(cwd, ...PHASES_LOCK_SUBPATH);
  mkdirSync(dirname(lockPath), { recursive: true });
  const tuning = lockTuning();
  const safeWindowMs = Math.floor(tuning.staleMs * LOCK_RELEASE_SAFE_FRACTION);
  const token = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < tuning.retries; attempt++) {
    // The body (with its unique ownership token) is regenerated PER ATTEMPT so
    // the on-disk acquired_at and the holder-side validity window derive from
    // the same instant. Stamping it once before the retry loop let a slow
    // acquisition write already-aged bytes: instantly stealable on disk while
    // assertFresh() still passed — breaking the disjointness contract (Codex
    // impl-review round 5).
    const acquiredAtMs = Date.now();
    const myBody = JSON.stringify({
      pid: process.pid,
      acquired_at: new Date(acquiredAtMs).toISOString(),
      token,
    });
    try {
      writeFileSync(lockPath, myBody, { encoding: 'utf8', flag: 'wx' });
      return {
        release: () => {
          // Disjointness contract: unlink only strictly inside the safe
          // window. Past it the lock is (or may imminently be judged)
          // stealable — leave the file for age-steal; touching the pathname
          // could remove a successor's lock.
          if (Date.now() - acquiredAtMs >= safeWindowMs) return;
          unlinkIfUnchanged(lockPath, myBody);
        },
        assertFresh: () => {
          if (Date.now() - acquiredAtMs >= safeWindowMs) {
            throw new Error(
              `phases.yaml write lock validity window (${safeWindowMs}ms) expired before the write — aborting to avoid a lost update; re-run`,
            );
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const inspectedRaw = readLockRaw(lockPath);
      if (inspectedRaw === null) continue; // released between our attempts — retry now
      if (lockContentIsStale(inspectedRaw, tuning.staleMs)) {
        attemptStealUnderMutex(lockPath, inspectedRaw);
        continue;
      }
      await new Promise((r) => setTimeout(r, tuning.delayMs));
    }
  }
  throw new Error(
    `phases.yaml write lock is held (${lockPath}) — another reconcile/amend is in flight; retry shortly`,
  );
}

export type ReconcileDirection = 'pull' | 'push';

export interface OrchestrateReconcileOptions {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injection point for tests — bypasses the settings → adapter resolution.
  readonly trackerOverride?: Tracker;
  readonly loggerOverride?: Logger;
  // Programmatic-only (no CLI flag): complete tasks staged for insertion by
  // `forge orchestrate amend-roadmap`. The pull path inserts them via
  // insertTaskIntoDocument and re-validates the whole document against
  // PhasesSchema BEFORE writing — an invalid staged task (unknown dep, dup id,
  // cycle) aborts the write entirely. See FORGE-101.
  readonly stagedAdditions?: readonly StagedAddition[];
}

export interface OrchestrateReconcileResult {
  readonly exitCode: number;
}

interface ParsedArgs {
  readonly direction: ReconcileDirection;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly confirmPrune: boolean;
  readonly noPrune: boolean;
}

interface JsonOk {
  readonly ok: true;
  readonly data: ReconcileData;
}
interface JsonErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

interface ReconcileData {
  readonly direction: ReconcileDirection;
  readonly dry_run: boolean;
  readonly pull?: PullPlan;
  readonly push?: PushAttemptResult;
  readonly applied?: boolean;
  readonly mutations?: number;
  // Task ids inserted from stagedAdditions this run (absent when none staged).
  readonly staged_added?: readonly string[];
}

interface PushAttemptResult {
  readonly plan: PushPlan;
  readonly succeeded: readonly string[];
  readonly failed: readonly { task_id: string; tracker_issue_id: string; code: string; message: string }[];
}

function writeJson(stream: NodeJS.WritableStream, payload: JsonOk | JsonErr): void {
  stream.write(JSON.stringify(payload) + '\n');
}

export function parseReconcileArgv(argv: readonly string[]): ParsedArgs | { error: string } {
  let direction: ReconcileDirection | null = null;
  let dryRun = false;
  let json = false;
  let confirmPrune = false;
  let noPrune = false;

  for (const arg of argv) {
    switch (arg) {
      case '--pull':
        if (direction) return { error: '--pull and --push are mutually exclusive' };
        direction = 'pull';
        break;
      case '--push':
        if (direction) return { error: '--pull and --push are mutually exclusive' };
        direction = 'push';
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '--confirm-prune':
        confirmPrune = true;
        break;
      case '--no-prune':
        noPrune = true;
        break;
      default:
        return { error: `unknown flag: ${arg}` };
    }
  }

  if (!direction) {
    return { error: 'one of --pull or --push is required' };
  }
  if (confirmPrune && noPrune) {
    return { error: '--confirm-prune and --no-prune are mutually exclusive' };
  }
  return { direction, dryRun, json, confirmPrune, noPrune };
}

function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Exported for reuse by amend-roadmap.ts (same size-guard + parse + validate
// + freshness pipeline; one loader, one set of failure modes).
export function loadPhasesWithDocument(absPath: string): {
  phases: Phases;
  doc: ReturnType<typeof parseDocument>;
  raw: string;
  freshnessLine: string;
} {
  // Size guard via stat BEFORE read — otherwise a 4 MiB+ adversarial file is
  // already in memory by the time we throw. Matches the pattern in
  // [[toctou-between-stat-and-read-leaks-raw-fs-errors]].
  const st = statSync(absPath);
  if (st.size > PHASES_FILE_MAX_BYTES) {
    throw new TrackerError(
      'VALIDATION' as TrackerErrorCode,
      `phases.yaml exceeds ${PHASES_FILE_MAX_BYTES} bytes`,
      { path: absPath, bytes: st.size },
    );
  }
  const raw = readFileSync(absPath, 'utf8');
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new TrackerError(
      'VALIDATION' as TrackerErrorCode,
      `phases.yaml YAML parse error: ${doc.errors[0]!.message}`,
      { path: absPath },
    );
  }
  const parsed = doc.toJS();
  const result = PhasesSchema.safeParse(parsed);
  if (!result.success) {
    throw new TrackerError(
      'VALIDATION' as TrackerErrorCode,
      `phases.yaml failed schema validation: ${result.error.issues[0]?.message ?? 'unknown'}`,
      { path: absPath },
    );
  }
  return {
    phases: result.data,
    doc,
    raw,
    freshnessLine: computeFreshnessLine(result.data.source),
  };
}

export async function runOrchestrateReconcile(
  opts: OrchestrateReconcileOptions,
): Promise<OrchestrateReconcileResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  const parsed = parseReconcileArgv(opts.argv);
  if ('error' in parsed) {
    // Exit code 3 (hard error) — NOT 1, which is reserved for PRUNE_PENDING.
    // The skill distinguishes "user must answer prune" (1) from "verb refused
    // due to malformed call" (3); collapsing both to 1 misroutes callers.
    writeJson(err, { ok: false, error: { code: 'INVALID_ARGS', message: parsed.error } });
    return { exitCode: 3 };
  }

  let phasesPath: string;
  let settingsPath: string;
  try {
    // Symlink-escape guard on both read and write targets — matches the
    // pattern used by every other path-touching verb in this codebase.
    phasesPath = validateUnderRoot(resolve(opts.cwd, PHASES_PATH_DEFAULT), opts.cwd);
    settingsPath = validateUnderRoot(
      resolve(opts.cwd, SETTINGS_PATH_DEFAULT),
      opts.cwd,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, { ok: false, error: { code: 'INVALID_CONFIG', message } });
    return { exitCode: 3 };
  }

  // Serialize phases.yaml writers BEFORE the read: a non-dry-run --pull is a
  // read-modify-write, and the lock must cover the read or the lost-update
  // window just moves. Dry-run and --push never write phases.yaml — no lock.
  let lock: PhasesWriteLock | undefined;
  if (parsed.direction === 'pull' && !parsed.dryRun) {
    try {
      lock = await acquirePhasesWriteLock(opts.cwd);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, { ok: false, error: { code: 'PHASES_LOCKED', message } });
      return { exitCode: 4 };
    }
  }

  let loaded;
  try {
    loaded = loadPhasesWithDocument(phasesPath);
  } catch (e) {
    if (lock) lock.release();
    const code = e instanceof TrackerError ? e.code : 'PHASES_NOT_FOUND';
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, { ok: false, error: { code, message } });
    return { exitCode: 3 };
  }
  // Freshness summary on stderr ahead of main output (FORGE-113 plan §0 Q1).
  err.write(loaded.freshnessLine + '\n');

  let tracker: Tracker;
  let closeTracker: (() => Promise<void>) | undefined;
  if (opts.trackerOverride) {
    tracker = opts.trackerOverride;
  } else {
    try {
      const settings = loadSettings(settingsPath);
      const handle = createTracker(settings, opts.loggerOverride ?? noopLogger());
      tracker = handle.tracker;
      closeTracker = handle.close;
    } catch (e) {
      if (lock) lock.release();
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, { ok: false, error: { code: 'INVALID_CONFIG', message } });
      return { exitCode: 3 };
    }
  }

  try {
    if (parsed.direction === 'pull') {
      return await runPull(
        parsed,
        loaded,
        phasesPath,
        tracker,
        opts.cwd,
        out,
        err,
        opts.stagedAdditions,
        lock,
      );
    }
    if (opts.stagedAdditions && opts.stagedAdditions.length > 0) {
      writeJson(err, {
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          message: 'stagedAdditions are only supported with --pull',
        },
      });
      return { exitCode: 3 };
    }
    return await runPush(parsed, loaded, tracker, out, err);
  } finally {
    if (lock) lock.release();
    // Optional tracker teardown. Since FORGE-117 (Notion → `ntn` CLI) no
    // adapter spawns a child process, so closeTracker is always undefined
    // today — kept for TrackerHandle interface stability.
    if (closeTracker) {
      try {
        await closeTracker();
      } catch {
        // Best-effort tear-down — never let a close error mask the verb's
        // primary exit code.
      }
    }
  }
}

async function runPull(
  args: ParsedArgs,
  loaded: { phases: Phases; doc: ReturnType<typeof parseDocument>; raw: string },
  phasesPath: string,
  tracker: Tracker,
  cwd: string,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  stagedAdditions?: readonly StagedAddition[],
  lock?: PhasesWriteLock,
): Promise<OrchestrateReconcileResult> {
  let page;
  try {
    // Pull orphan detection needs the FULL issue set, including done/cancelled:
    // a task may legitimately bind a completed issue, and the active-only view
    // would falsely flag it as removed (FORGE-165).
    page = await tracker.listAllIssues();
  } catch (e) {
    const code = e instanceof TrackerError ? e.code : 'TRACKER_ERROR';
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, { ok: false, error: { code, message } });
    return { exitCode: 4 };
  }

  if (page.truncated) {
    // The tracker view hit its page/limit cap, so the issue set may be
    // incomplete. diffPull fails closed (no orphan detection) — warn the user
    // that pruning was skipped so a true orphan isn't silently retained.
    err.write(
      'warning: tracker issue list was truncated (page limit hit); ' +
        'orphan detection skipped to avoid false prune.\n',
    );
  }

  const plan = diffPull(page.issues, loaded.phases, {
    trackerViewTruncated: page.truncated,
  });

  if (args.dryRun) {
    writeJson(out, {
      ok: true,
      data: { direction: 'pull', dry_run: true, pull: plan, applied: false },
    });
    // If there are orphan removals, exit 1 (PRUNE_PENDING) so the skill knows
    // it must confirm before a real --pull. The skill re-invokes with
    // --confirm-prune (or --no-prune to keep them).
    return { exitCode: plan.removed.length > 0 ? 1 : 0 };
  }

  if (plan.removed.length > 0 && !args.confirmPrune && !args.noPrune) {
    // PRUNE_PENDING: stdout carries the structured plan (ok:true), stderr
    // carries the human-readable error line. Matches orchestrate-spec-diff's
    // convention (data on stdout, diagnostics on stderr). The skill detects
    // the orphan-pending state by checking exitCode === 1 AND
    // data.pull.removed.length > 0 — both signals consistent.
    writeJson(out, {
      ok: true,
      data: { direction: 'pull', dry_run: false, pull: plan, applied: false },
    });
    err.write(
      `forge orchestrate reconcile: ${plan.removed.length} orphan task(s) — re-run with --confirm-prune or --no-prune\n`,
    );
    return { exitCode: 1 };
  }

  const applyOpts = { confirmPrune: args.confirmPrune };
  let mutationsDoc = applyPlanToDocument(loaded.doc, plan, applyOpts);

  // Staged additions (amend-roadmap): insert AFTER the plan mutations so the
  // diff above ran against the on-disk truth, then fail closed — any invalid
  // resulting document (unknown dep, duplicate id, DAG cycle) aborts before
  // the write, leaving phases.yaml untouched.
  const stagedAdded: string[] = [];
  if (stagedAdditions && stagedAdditions.length > 0) {
    try {
      for (const staged of stagedAdditions) {
        if (insertTaskIntoDocument(loaded.doc, staged.phaseId, staged.task)) {
          stagedAdded.push(staged.task.id);
          mutationsDoc++;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, {
        ok: false,
        error: { code: 'STAGED_ADDITION_FAILED', message },
      });
      return { exitCode: 3 };
    }
    const revalidated = PhasesSchema.safeParse(loaded.doc.toJS());
    if (!revalidated.success) {
      const detail = revalidated.error.issues[0]?.message ?? 'unknown';
      writeJson(err, {
        ok: false,
        error: {
          code: 'STAGED_ADDITION_INVALID',
          message: `staged addition produced an invalid phases.yaml (not written): ${detail}`,
        },
      });
      return { exitCode: 3 };
    }
  }

  // Resolve + stamp the source stanza on every successful --pull. synced_at
  // bumps even when the diff is empty: the semantic is "last successful sync
  // attempt", not "last mutation". This means --pull always writes the file
  // (single rewrite — minor thrash, big upside on honest staleness).
  let nextSource: Source;
  try {
    nextSource = resolveSourceForPull(loaded, tracker.type, cwd);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, {
      ok: false,
      error: { code: 'SOURCE_RESOLUTION_FAILED', message },
    });
    return { exitCode: 3 };
  }
  setSourceOnDocument(loaded.doc, nextSource);

  // Holder-side half of the lock's disjointness contract: prove the lock is
  // still inside its validity window IMMEDIATELY before the write. A pull
  // that outlived the staleness horizon may have been age-stolen — writing
  // anyway would reintroduce the lost update the lock prevents.
  if (lock) {
    try {
      lock.assertFresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, { ok: false, error: { code: 'PHASES_LOCK_EXPIRED', message } });
      return { exitCode: 4 };
    }
  }

  // Serialize without re-folding long scalars (lineWidth: 0) or padding flow
  // collections (flowCollectionPadding: false). The yaml lib's defaults rewrap
  // every long description/goal/acceptance string at 80 cols and render
  // `[P1-T01]` as `[ P1-T01 ]`, producing thousands of lines of cosmetic churn
  // on --pull even when only a handful of titles changed (FORGE-121).
  writeAtomic(
    phasesPath,
    loaded.doc.toString({ lineWidth: 0, flowCollectionPadding: false }),
  );

  writeJson(out, {
    ok: true,
    data: {
      direction: 'pull',
      dry_run: false,
      pull: plan,
      applied: mutationsDoc > 0,
      mutations: mutationsDoc,
      ...(stagedAdditions ? { staged_added: stagedAdded } : {}),
    },
  });

  return { exitCode: 0 };
}

// Pick a project_id for the source stanza, preferring (in order):
//   1. The existing source.project_id (preserved across --pull runs)
//   2. The legacy top-level `tracker_project_id` in the raw Document
//      (v0.3.x migration path — schema-stripped but still present in YAML)
// Throws if neither is found — fail loudly rather than fabricate an ID.
function resolveSourceForPull(
  loaded: { phases: Phases; doc: ReturnType<typeof parseDocument> },
  trackerType: Source['tracker'],
  cwd: string,
): Source {
  let project_id: string | undefined = loaded.phases.source?.project_id;
  if (!project_id) {
    const legacy = loaded.doc.get('tracker_project_id', true);
    if (legacy && typeof legacy.toJSON === 'function') {
      const value = legacy.toJSON() as unknown;
      if (typeof value === 'string' && value.length > 0) project_id = value;
    } else if (typeof legacy === 'string' && legacy.length > 0) {
      project_id = legacy;
    }
  }
  if (!project_id) {
    throw new Error(
      'phases.yaml has no source.project_id and no legacy tracker_project_id ' +
        'to migrate from. Set source.project_id manually OR run /push-to-tracker ' +
        'to bootstrap the upstream project binding.',
    );
  }
  return {
    tracker: trackerType,
    project_id,
    synced_at: new Date().toISOString(),
    spec_revision: computeSpecRevision(cwd),
  };
}

// Mutate `doc` to install (or replace) the `source` map node with the
// supplied values. Preserves surrounding ordering/comments because we set
// the keys individually via `setIn` rather than replacing the parent.
function setSourceOnDocument(
  doc: ReturnType<typeof parseDocument>,
  source: Source,
): void {
  doc.setIn(['source', 'tracker'], source.tracker);
  doc.setIn(['source', 'project_id'], source.project_id);
  doc.setIn(['source', 'synced_at'], source.synced_at);
  doc.setIn(['source', 'spec_revision'], source.spec_revision);
  // Migration: remove the legacy top-level tracker_project_id once we've
  // recorded the value inside source. Idempotent — `deleteIn` returns false
  // when the path is already gone.
  doc.deleteIn(['tracker_project_id']);
}

async function runPush(
  args: ParsedArgs,
  loaded: { phases: Phases },
  tracker: Tracker,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): Promise<OrchestrateReconcileResult> {
  let issues;
  try {
    issues = await tracker.listActiveIssues();
  } catch (e) {
    const code = e instanceof TrackerError ? e.code : 'TRACKER_ERROR';
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, { ok: false, error: { code, message } });
    return { exitCode: 4 };
  }

  const plan = diffPush(loaded.phases, issues);

  if (args.dryRun) {
    writeJson(out, {
      ok: true,
      data: {
        direction: 'push',
        dry_run: true,
        push: { plan, succeeded: [], failed: [] },
        applied: false,
      },
    });
    return { exitCode: 0 };
  }

  const succeeded: string[] = [];
  const failed: { task_id: string; tracker_issue_id: string; code: string; message: string }[] = [];
  for (const body of plan.bodies) {
    try {
      await tracker.updateIssueBody(body.tracker_issue_id, body.body);
      succeeded.push(body.task_id);
    } catch (e) {
      const code = e instanceof TrackerError ? e.code : 'TRACKER_ERROR';
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ task_id: body.task_id, tracker_issue_id: body.tracker_issue_id, code, message });
    }
  }

  writeJson(out, {
    ok: true,
    data: {
      direction: 'push',
      dry_run: false,
      push: { plan, succeeded, failed },
      applied: succeeded.length > 0,
    },
  });

  if (failed.length > 0) {
    err.write(
      `forge orchestrate reconcile: ${failed.length}/${plan.bodies.length} push(es) failed\n`,
    );
    return { exitCode: 2 };
  }
  return { exitCode: 0 };
}
