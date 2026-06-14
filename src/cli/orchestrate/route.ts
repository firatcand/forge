// `forge orchestrate route --task <id> [--attempt <id>] --json` (FORGE-210).
//
// The routing KEYSTONE: the integrator that composes the three shipped
// primitives into one decision —
//   • effectiveModelTier (FORGE-211) — the tier ARITHMETIC (floor + escalation);
//   • loadEffectiveCatalog (FORGE-212) — the shared cache→seed→canonicalize→pins
//     catalog (the SAME view `models` read-mode shows — R4, no divergence);
//   • computeAvailability / resolveAvailableModel (FORGE-213) — per-host
//     reachability + warn-downgrade.
// → ok({ host, model, tier_floor, tier_effective, rationale, downgraded,
//        warning? }) or fail(TASK_NOT_FOUND | NO_MODEL_AVAILABLE).
//
// Enforcement scope is HONEST (R3):
//   • This verb is ADVISORY. It RETURNS a routing decision; it does not spawn.
//     The interactive/skill path (forge-orchestrate, /drive) reads this route
//     and passes the model to its own Task-tool (claude) / DispatchOpts (codex)
//     spawn.
//   • The ENFORCED leg for forge-owned spawns is the codex `--model` argv
//     (DispatchOpts.model → CodexHarness). Threading the model through
//     manifest / render-worker-prompt for a fully-forge-owned interactive
//     dispatch is Autopilot I6 (FORGE-192), NOT this ticket.
//
// Determinism (R6): the DECISION is deterministic given (task stamp/state,
// effective catalog, FIXED availability set). computeAvailability reads live
// host state (env / files / `--version` probes), so the verb as a whole is NOT
// replay-deterministic across changing host state — only the resolver downstream
// of a fixed availability set is. Tests inject a fixed availability set.
//
// Read band: no lease, no tracker mutation, no state-machine write. The ONLY
// side effect is a best-effort `model_routed` attempt-event append, and only
// when called WITH --attempt AND a valid lease is held (mirrors
// guardrail-check) — recording the routing decision incl. any downgrade.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { execa } from 'execa';

import { loadPhases, resolvePhasesYaml } from '../../core/phases.ts';
import { PhasesError } from '../../core/errors.ts';
import { OrchestratorError } from '../../core/errors.ts';
import { loadSettings } from '../../core/settings.ts';
import { AgentsSchema, type Settings } from '../../schemas/settings.ts';
import type { Task } from '../../schemas/phases.ts';
import type { ModelTier } from '../../schemas/phases.ts';
import { effectiveModelTier } from '../../orchestrator/model-tier.ts';
import { globsIntersect } from '../../orchestrator/overlap.ts';
import { loadEffectiveCatalog } from '../../orchestrator/catalog-load.ts';
import {
  computeAvailability,
  resolveAvailableModel,
  defaultAvailabilityDeps,
  type AvailabilitySet,
  type AvailabilityDeps,
} from '../../orchestrator/availability.ts';
import { readTaskState } from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { leaseFilePath, validateIdSegment } from '../../orchestrator/questions/paths.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { CATALOG_HOSTS, type CatalogHost } from '../../schemas/models-catalog.ts';
import type { ExecaLike } from '../init/validate.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { resolveLogRotateMaxBytes } from './log-rotate-settings.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface RouteData {
  readonly host: CatalogHost;
  readonly model: string;
  // The task's model_tier stamp (informational floor), if present.
  readonly tier_floor: ModelTier | null;
  // The effective tier after escalation (critical-path / retry).
  readonly tier_effective: ModelTier;
  // Whether the resolver had to downgrade below tier_effective.
  readonly downgraded: boolean;
  // Present only on a downgrade.
  readonly warning?: string;
  // Human-readable explanation of the routing decision.
  readonly rationale: string;
}

export interface OrchestrateRouteOptions {
  readonly forgeDir: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly json?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // FORGE-213 availability deps seam. Default to the real
  // execa/process.env/existsSync/os.homedir so production needs no wiring;
  // tests inject a FIXED availability set via these (NO real binaries) so the
  // resolver leg is deterministic (R6).
  readonly availability?: AvailabilitySet;
  readonly exec?: ExecaLike;
  readonly getEnv?: (name: string) => string | undefined;
  readonly fileExists?: (path: string) => boolean;
  readonly homeDir?: string;
  readonly timeoutMs?: number;
}

export interface OrchestrateRouteResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

// Index phases tasks by both phases id and tracker id (mirrors review-queue.ts /
// collectActiveAttempts) so `--task` resolves whichever key the caller used.
function indexTasks(flat: ReadonlyArray<{ task: Task }>): Map<string, Task> {
  const byId = new Map<string, Task>();
  for (const { task } of flat) {
    byId.set(task.id, task);
    if (task.tracker_issue_id) byId.set(task.tracker_issue_id, task);
  }
  return byId;
}

// Best-effort settings load — missing/unreadable settings.yaml → schema
// defaults (mirror doctor.ts / models.ts: a read-band verb must not refuse to
// run because the adopter hasn't `forge init`-ed yet).
function loadSettingsBestEffort(forgeDir: string): Settings | undefined {
  try {
    return loadSettings(`${forgeDir}/settings.yaml`);
  } catch {
    return undefined;
  }
}

// R1: effectiveModelTier.attemptCount means PRIOR FAILED attempts, but
// readTaskState().attempt_count is incremented at dispatch (includes the
// CURRENT attempt). So priorFailed = max(0, attempt_count - 1); a missing
// state.json (STATE_NOT_FOUND) → 0 (first attempt, no bump).
function priorFailedAttempts(forgeDir: string, taskId: string): number {
  try {
    const state = readTaskState(forgeDir, taskId);
    return Math.max(0, state.attempt_count - 1);
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'STATE_NOT_FOUND') {
      return 0;
    }
    throw err;
  }
}

export async function runOrchestrateRoute(
  opts: OrchestrateRouteOptions,
): Promise<OrchestrateRouteResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const json = opts.json === true;

  if (!opts.taskId || opts.taskId.length === 0) {
    return { exitCode: writeEnvelope(fail('INVALID_ARGS', '--task is required', false), out) };
  }

  // 1. Load phases + resolve --task → Task. Missing task → TASK_NOT_FOUND.
  const cwd = dirname(opts.forgeDir);
  const phasesPath = resolvePhasesYaml(cwd);
  let flat: { task: Task }[] = [];
  if (phasesPath) {
    try {
      const { phases } = loadPhases(phasesPath);
      flat = phases.phases.flatMap((ph) => ph.tasks.map((task) => ({ task })));
    } catch (e) {
      if (e instanceof PhasesError && e.code === 'FILE_NOT_FOUND') {
        // No phases → no task → TASK_NOT_FOUND below.
      } else if (e instanceof PhasesError && e.code === 'SCHEMA_INVALID') {
        return { exitCode: writeEnvelope(fail('SCHEMA_INVALID', e.message, false), out) };
      } else {
        return {
          exitCode: writeEnvelope(
            fail('IO_ERROR', e instanceof Error ? e.message : String(e), false),
            out,
          ),
        };
      }
    }
  }
  const task = indexTasks(flat).get(opts.taskId);
  if (!task) {
    return {
      exitCode: writeEnvelope(
        fail('TASK_NOT_FOUND', `no task '${opts.taskId}' in phases.yaml`, false),
        out,
      ),
    };
  }
  // R2 (re-review): orchestrator state/lease/events are keyed by
  // `tracker_issue_id ?? id` (see phases.ts / claim path). `--task` may be the
  // ALTERNATE id (we index by both), so derive the canonical state key from the
  // resolved Task — using opts.taskId raw would read the wrong state.json
  // (STATE_NOT_FOUND → priorFailed 0) and miss the held-lease event path.
  const stateTaskId = task.tracker_issue_id ?? task.id;

  // Best-effort settings; when absent/unreadable fall back to the SCHEMA
  // DEFAULTS (not empty) so preflight_globs / default_model_tier match what a
  // freshly-init'd repo would see (AgentsSchema.parse({}) materializes them).
  const settings = loadSettingsBestEffort(opts.forgeDir);
  const agents = settings?.agents ?? AgentsSchema.parse({});
  const defaultTier: ModelTier = agents.default_model_tier;
  const preflightGlobs: readonly string[] = agents.preflight_globs;
  const models = settings?.models ?? { ttl_days: 14 };

  // 2. Effective tier. tier_floor = the stamp (informational).
  //    R2: touchesCriticalPath via GLOB-INTERSECTION (write_globs ∩
  //    preflight_globs) — both sides are GLOBS, so matchPreflight is wrong here.
  //    R1: priorFailed = max(0, attempt_count - 1) (STATE_NOT_FOUND → 0).
  const writeGlobs = task.write_globs ?? [];
  const touchesCriticalPath = globsIntersect(writeGlobs, preflightGlobs);
  let priorFailed: number;
  try {
    priorFailed = priorFailedAttempts(opts.forgeDir, stateTaskId);
  } catch (e) {
    return {
      exitCode: writeEnvelope(
        fail('IO_ERROR', e instanceof Error ? e.message : String(e), false),
        out,
      ),
    };
  }
  const tierEffective = effectiveModelTier({
    ...(task.model_tier ? { taskTier: task.model_tier } : {}),
    attemptCount: priorFailed,
    touchesCriticalPath,
    defaultTier,
  });

  // 3. Load the SHARED effective catalog (R4) — identical to `models` read view.
  let catalog;
  try {
    catalog = loadEffectiveCatalog(opts.forgeDir, { models }).catalog;
  } catch (e) {
    return {
      exitCode: writeEnvelope(
        fail('SEED_NOT_FOUND', e instanceof Error ? e.message : String(e), false),
        out,
      ),
    };
  }

  // 4. Availability set. Tests inject a FIXED set (R6); production probes live.
  let availability: AvailabilitySet;
  if (opts.availability) {
    availability = opts.availability;
  } else {
    const betaOptIn = agents.cursor_host_beta_opt_in === true;
    const deps: AvailabilityDeps = opts.exec || opts.getEnv || opts.fileExists || opts.homeDir
      ? {
          exec: opts.exec ?? (execa as unknown as ExecaLike),
          getEnv: opts.getEnv ?? ((n: string) => process.env[n]),
          fileExists: opts.fileExists ?? ((p: string) => existsSync(p)),
          homeDir: opts.homeDir ?? homedir(),
          betaOptIn,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        }
      : {
          ...defaultAvailabilityDeps(betaOptIn),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        };
    availability = await computeAvailability(CATALOG_HOSTS, deps);
  }

  // 5. Resolve a reachable model for the effective tier (warn-downgrade).
  const resolved = resolveAvailableModel(catalog, availability, tierEffective);
  if ('unavailable' in resolved) {
    return {
      exitCode: writeEnvelope(
        fail('NO_MODEL_AVAILABLE', resolved.reason, false),
        out,
      ),
    };
  }

  // 6. Rationale.
  const floorStr = task.model_tier ?? `(unstamped → default ${defaultTier})`;
  const escalations: string[] = [];
  if (touchesCriticalPath) escalations.push('critical-path');
  if (priorFailed > 0) escalations.push(`retry×${priorFailed}`);
  const escalationStr = escalations.length > 0 ? ` (${escalations.join(', ')})` : '';
  const downgradeStr = resolved.downgraded
    ? ` [downgraded to ${resolved.tier}: ${resolved.warning ?? ''}]`
    : '';
  const rationale =
    `tier floor ${floorStr} → effective ${tierEffective}${escalationStr}; ` +
    `picked ${resolved.host}:${resolved.model}${downgradeStr}`;

  const data: RouteData = {
    host: resolved.host,
    model: resolved.model,
    tier_floor: task.model_tier ?? null,
    tier_effective: tierEffective,
    downgraded: resolved.downgraded,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    rationale,
  };

  // Best-effort model_routed event (R5) — mirrors guardrail-check: only when
  // --attempt is supplied AND a valid lease is held. Validate ids BEFORE any
  // path construction; recover CallerIdentity via the lease; skip silently when
  // no valid lease; WARN to stderr on append failure AFTER identity resolution.
  if (opts.attemptId) {
    appendModelRoutedEvent({
      forgeDir: opts.forgeDir,
      taskId: stateTaskId, // canonical state key, not the raw --task arg (R2 re-review)
      attemptId: opts.attemptId,
      data,
      stderr: err,
    });
  }

  if (json) return { exitCode: writeEnvelope(ok(data), out) };
  out.write(formatRoute(data));
  return { exitCode: 0 };
}

function appendModelRoutedEvent(args: {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  data: RouteData;
  stderr: NodeJS.WritableStream;
}): void {
  // Validate taskId + attemptId BEFORE constructing any filesystem path
  // (security-auditor pattern from guardrail-check / FORGE-97).
  try {
    validateIdSegment(args.taskId, 'taskId');
    validateIdSegment(args.attemptId, 'attemptId');
  } catch {
    return;
  }

  // Recover caller identity from the lease. Missing/invalid lease → silently
  // skip the event (advisory callers may route outside an active attempt). The
  // verb still emits the route.
  let leasePath: string;
  try {
    leasePath = leaseFilePath(args.forgeDir, args.taskId);
  } catch {
    return;
  }
  if (!existsSync(leasePath)) return;
  let lease: Lease;
  try {
    const parsed = LeaseSchema.safeParse(JSON.parse(readFileSync(leasePath, 'utf8')));
    if (!parsed.success) return;
    lease = parsed.data;
  } catch {
    return;
  }

  try {
    appendAttemptEvent(
      {
        type: 'model_routed',
        ts: new Date().toISOString(),
        host: args.data.host,
        model: args.data.model,
        ...(args.data.tier_floor ? { tier_floor: args.data.tier_floor } : {}),
        tier_effective: args.data.tier_effective,
        downgraded: args.data.downgraded,
        ...(args.data.warning ? { warning: args.data.warning } : {}),
      },
      {
        forgeDir: args.forgeDir,
        taskId: args.taskId,
        attemptId: args.attemptId,
        caller: {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
        logRotateMaxBytes: resolveLogRotateMaxBytes(args.forgeDir),
      },
    );
  } catch (e) {
    // Audit append is best-effort, but a failure AFTER identity resolution
    // deserves a stderr warning (CLAUDE.md "no silent catches"). The route
    // itself already succeeded; exit code is unchanged.
    const msg = e instanceof Error ? e.message : String(e);
    args.stderr.write(
      `route: failed to append model_routed event for task ${args.taskId}: ${msg}\n`,
    );
  }
}

function formatRoute(d: RouteData): string {
  const lines: string[] = [
    `→ ${d.host}:${d.model}  [tier ${d.tier_effective}${d.downgraded ? ', DOWNGRADED' : ''}]`,
    `  ${d.rationale}`,
  ];
  if (d.warning) lines.push(`  ⚠ ${d.warning}`);
  return lines.join('\n') + '\n';
}

export const routeHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Route a task to a concrete host:model (tier floor + escalation → availability → warn-downgrade). Advisory: returns the decision; the enforced leg is codex --model on forge-owned spawns.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? '';
    const attemptId = parseFlag(rest, 'attempt');
    const json = hasFlag(rest, 'json');
    const result = await runOrchestrateRoute({
      forgeDir,
      cwd: opts.cwd,
      taskId,
      ...(attemptId ? { attemptId } : {}),
      json,
    });
    return { exitCode: result.exitCode };
  },
};
