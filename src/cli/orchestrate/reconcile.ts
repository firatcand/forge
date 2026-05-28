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

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { writeAtomic } from '../../core/fs-atomic.ts';
import { computeFreshnessLine } from '../../core/freshness.ts';
import { loadSettings } from '../../core/settings.ts';
import { computeSpecRevision } from '../../core/spec-revision.ts';
import { validateUnderRoot } from '../../core/workspace.ts';
import { PhasesSchema, type Phases, type Source } from '../../schemas/phases.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import { GitHubTracker } from '../../trackers/github.ts';
import { LinearTracker } from '../../trackers/linear.ts';
import { NotionTracker } from '../../trackers/notion.ts';
import { createStdioMcpCall, type StdioMcpHandle } from '../../trackers/notion-mcp-transport.ts';
import {
  TrackerError,
  type TrackerErrorCode,
} from '../../trackers/errors.ts';
import type { Settings } from '../../schemas/settings.ts';
import {
  applyPlanToDocument,
  diffPull,
  diffPush,
  type PullPlan,
  type PushPlan,
} from '../../orchestrator/reconcile.ts';

const PHASES_PATH_DEFAULT = 'plans/phases.yaml';
const SETTINGS_PATH_DEFAULT = '.forge/settings.yaml';
const PHASES_FILE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

export type ReconcileDirection = 'pull' | 'push';

export interface OrchestrateReconcileOptions {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // Injection point for tests — bypasses the settings → adapter resolution.
  readonly trackerOverride?: Tracker;
  readonly loggerOverride?: Logger;
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

interface TrackerHandle {
  readonly tracker: Tracker;
  readonly close?: () => Promise<void>;
}

// Threat model for createTracker:
//
// settings.yaml is treated as TRUSTED EXECUTABLE CONFIG (same trust level as
// package.json scripts or a Makefile). The Notion launcher accepts an
// arbitrary `mcp_command` because that's the customization point for users
// who want a different Notion MCP server build/version. An earlier review
// suggested allowlisting `mcp_command[0]` to {npx, node}, but Codex 2nd-pass
// pointed out that `node -e '...'` or `npx -y <attacker-pkg>` are still
// arbitrary code execution — argv[0] is not a meaningful boundary. So
// allowlisting was security theater.
//
// Honest mitigation: settings.yaml must be repo-tracked and review-gated
// (branch protection, CODEOWNERS). The same applies to package.json, Makefile,
// and any other dev-time config that names a binary forge will run. CI
// systems that allow PR contributors to mutate settings.yaml without review
// have a broader trust-model issue that this allowlist would not have
// resolved either.
function createTracker(settings: Settings, logger: Logger): TrackerHandle {
  const t = settings.tracker;
  switch (t.type) {
    case 'linear':
      return { tracker: new LinearTracker(t, logger) };
    case 'github':
      return { tracker: new GitHubTracker(t, logger) };
    case 'notion': {
      const [command, ...args] = t.config.mcp_command;
      if (!command) {
        throw new Error('notion tracker: mcp_command must be non-empty');
      }
      const handle: StdioMcpHandle = createStdioMcpCall({
        command,
        args,
        env: t.config.mcp_env,
      });
      return {
        tracker: new NotionTracker(t, logger, { mcp: handle.call }),
        close: () => handle.close(),
      };
    }
    default: {
      const exhaustive: never = t;
      throw new Error(`unreachable tracker type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function loadPhasesWithDocument(absPath: string): {
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

  let loaded;
  try {
    loaded = loadPhasesWithDocument(phasesPath);
  } catch (e) {
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
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, { ok: false, error: { code: 'INVALID_CONFIG', message } });
      return { exitCode: 3 };
    }
  }

  try {
    if (parsed.direction === 'pull') {
      return await runPull(parsed, loaded, phasesPath, tracker, opts.cwd, out, err);
    }
    return await runPush(parsed, loaded, tracker, out, err);
  } finally {
    // Tear down the MCP child process spawned for Notion. createStdioMcpCall
    // returns a handle the caller is contractually required to close
    // (notion-mcp-transport.ts:24). For Linear/GitHub closeTracker is
    // undefined.
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
  const mutationsDoc = applyPlanToDocument(loaded.doc, plan, applyOpts);

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

  writeAtomic(phasesPath, loaded.doc.toString());

  writeJson(out, {
    ok: true,
    data: {
      direction: 'pull',
      dry_run: false,
      pull: plan,
      applied: mutationsDoc > 0,
      mutations: mutationsDoc,
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
