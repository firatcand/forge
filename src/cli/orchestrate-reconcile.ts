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
import { writeAtomic } from '../core/fs-atomic.ts';
import { loadSettings } from '../core/settings.ts';
import { validateUnderRoot } from '../core/workspace.ts';
import { PhasesSchema, type Phases } from '../schemas/phases.ts';
import type { Logger, Tracker } from '../trackers/base.ts';
import { GitHubTracker } from '../trackers/github.ts';
import { LinearTracker } from '../trackers/linear.ts';
import { NotionTracker } from '../trackers/notion.ts';
import { createStdioMcpCall, type StdioMcpHandle } from '../trackers/notion-mcp-transport.ts';
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

// Allowlist for the Notion MCP launch command. settings.yaml is read into a
// trusted-config context, but `mcp_command[0]` becomes the binary spawned by
// StdioClientTransport — an attacker with write access to .forge/settings.yaml
// (e.g. a malicious PR in CI) could otherwise achieve arbitrary command
// execution. We pin the launcher to the two binaries that produce all real
// MCP server invocations in practice.
const MCP_COMMAND_ALLOWLIST = new Set<string>(['npx', 'node']);

interface TrackerHandle {
  readonly tracker: Tracker;
  readonly close?: () => Promise<void>;
}

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
      if (!MCP_COMMAND_ALLOWLIST.has(command)) {
        throw new Error(
          `notion tracker: mcp_command[0] '${command}' not in allowlist (${[...MCP_COMMAND_ALLOWLIST].join(',')})`,
        );
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

function loadPhasesWithDocument(absPath: string): { phases: Phases; doc: ReturnType<typeof parseDocument>; raw: string } {
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
  return { phases: result.data, doc, raw };
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
      return await runPull(parsed, loaded, phasesPath, tracker, out, err);
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
    // Signal PRUNE_PENDING with ok:false so JSON consumers don't have to
    // inspect data.pull.removed.length to decide. The plan is still
    // attached for the skill to render the orphan list.
    writeJson(out, {
      ok: false,
      error: {
        code: 'PRUNE_PENDING',
        message: `${plan.removed.length} orphan task(s) — re-run with --confirm-prune or --no-prune`,
      },
    });
    writeJson(err, {
      ok: true,
      data: { direction: 'pull', dry_run: false, pull: plan, applied: false },
    });
    return { exitCode: 1 };
  }

  const applyOpts = { confirmPrune: args.confirmPrune };
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
