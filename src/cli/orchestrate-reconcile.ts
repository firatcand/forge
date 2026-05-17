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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { writeAtomic } from '../core/fs-atomic.ts';
import { loadSettings } from '../core/settings.ts';
import { PhasesSchema, type Phases } from '../schemas/phases.ts';
import type { Logger, Tracker } from '../trackers/base.ts';
import { GitHubTracker } from '../trackers/github.ts';
import { LinearTracker } from '../trackers/linear.ts';
import { NotionTracker } from '../trackers/notion.ts';
import { createStdioMcpCall } from '../trackers/notion-mcp-transport.ts';
import {
  TrackerError,
  type TrackerErrorCode,
} from '../trackers/errors.ts';
import type { Settings } from '../schemas/settings.ts';
import {
  applyPlanToDocument,
  diffPull,
  diffPush,
  type PullPlan,
  type PushPlan,
} from '../orchestrator/reconcile.ts';

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

function createTracker(settings: Settings, logger: Logger): Tracker {
  const t = settings.tracker;
  switch (t.type) {
    case 'linear':
      return new LinearTracker(t, logger);
    case 'github':
      return new GitHubTracker(t, logger);
    case 'notion': {
      const [command, ...args] = t.config.mcp_command;
      if (!command) {
        throw new Error('notion tracker: mcp_command must be non-empty');
      }
      const handle = createStdioMcpCall({
        command,
        args,
        env: t.config.mcp_env,
      });
      return new NotionTracker(t, logger, { mcp: handle.call });
    }
    default: {
      const exhaustive: never = t;
      throw new Error(`unreachable tracker type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function loadPhasesWithDocument(absPath: string): { phases: Phases; doc: ReturnType<typeof parseDocument>; raw: string } {
  const raw = readFileSync(absPath, 'utf8');
  if (raw.length > PHASES_FILE_MAX_BYTES) {
    throw new TrackerError(
      'VALIDATION' as TrackerErrorCode,
      `phases.yaml exceeds ${PHASES_FILE_MAX_BYTES} bytes`,
      { path: absPath, bytes: raw.length },
    );
  }
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
  return { phases: result.data, doc, raw };
}

export async function runOrchestrateReconcile(
  opts: OrchestrateReconcileOptions,
): Promise<OrchestrateReconcileResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;

  const parsed = parseReconcileArgv(opts.argv);
  if ('error' in parsed) {
    writeJson(err, { ok: false, error: { code: 'INVALID_ARGS', message: parsed.error } });
    return { exitCode: 1 };
  }

  const phasesPath = resolve(opts.cwd, PHASES_PATH_DEFAULT);
  let loaded;
  try {
    loaded = loadPhasesWithDocument(phasesPath);
  } catch (e) {
    const code = e instanceof TrackerError ? e.code : 'PHASES_NOT_FOUND';
    const message = e instanceof Error ? e.message : String(e);
    writeJson(err, { ok: false, error: { code, message } });
    return { exitCode: 3 };
  }

  let tracker: Tracker;
  if (opts.trackerOverride) {
    tracker = opts.trackerOverride;
  } else {
    try {
      const settings = loadSettings(resolve(opts.cwd, SETTINGS_PATH_DEFAULT));
      tracker = createTracker(settings, opts.loggerOverride ?? noopLogger());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      writeJson(err, { ok: false, error: { code: 'INVALID_CONFIG', message } });
      return { exitCode: 3 };
    }
  }

  if (parsed.direction === 'pull') {
    return runPull(parsed, loaded, phasesPath, tracker, out, err);
  }
  return runPush(parsed, loaded, tracker, out, err);
}

async function runPull(
  args: ParsedArgs,
  loaded: { phases: Phases; doc: ReturnType<typeof parseDocument>; raw: string },
  phasesPath: string,
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

  const plan = diffPull(issues, loaded.phases);

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
  const titleAndDepsChanges = plan.updated.length;
  const mutationsDoc = applyPlanToDocument(loaded.doc, plan, applyOpts);

  let wrote = false;
  if (mutationsDoc > 0) {
    writeAtomic(phasesPath, loaded.doc.toString());
    wrote = true;
  }

  writeJson(out, {
    ok: true,
    data: {
      direction: 'pull',
      dry_run: false,
      pull: plan,
      applied: wrote,
      mutations: mutationsDoc,
    },
  });

  // Non-fatal exit if there were `added` issues (tracker has new things) or
  // unmanaged issues — informational only.
  // Mutations is the only real success indicator.
  void titleAndDepsChanges;
  return { exitCode: 0 };
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
