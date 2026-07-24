// FORGE-234: `forge orchestrate ship` — the VERB-ONLY ship operation (owner
// decision: no model worker; every step is deterministic git/gh/CLI work).
// The core sequence lives in src/orchestrator/ship-op.ts; this wrapper wires
// production deps, routes the outcome, and NEVER double-emits: on success and
// budgeted failure the internally-invoked complete path owns the envelope.

import * as path from 'node:path';
import { execa } from 'execa';
import { OrchestratorError } from '../../core/errors.ts';
import { loadSettings } from '../../core/settings.ts';
import { SettingsError } from '../../core/errors.ts';
import type { Settings } from '../../schemas/settings.ts';
import { ShipArgsSchema, type ShipArgs } from '../../schemas/cli-args.ts';
import { v7 as uuidv7 } from 'uuid';
import {
  applyTransition,
  readTaskState,
  writeTaskState,
} from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import {
  runShipOperation,
  type ShipOpDeps,
  type ShipOpOutcome,
  type ShipParkReason,
} from '../../orchestrator/ship-op.ts';
import { readShipRecord } from '../../orchestrator/ship-record.ts';
import { readFileSync } from 'node:fs';
import { AttemptManifestSchema } from '../../schemas/attempt.ts';
import { manifestFilePath } from '../../orchestrator/questions/paths.ts';
import { readFrozenBaseBranch } from '../../orchestrator/worktree-base.ts';
import { writeQuestionAtomic } from '../../orchestrator/questions/writer.ts';
import { findQuestionFile, listOpenQuestionsAcrossTree } from '../../orchestrator/questions/lookup.ts';
import { createGitHubRepoHost } from '../../repo-hosts/detect.ts';
import type { Exec } from '../../repo-hosts/github.ts';
import { createTracker } from './tracker-factory.ts';
import { TrackerError, isRetriableTrackerErrorCode } from '../../trackers/errors.ts';
import { emit, fail } from '../envelope.ts';
import { ghExec } from './gh-exec.ts';
import { runOrchestrateComplete } from './complete.ts';
import { callerFromLease, readLease } from './lease-io.ts';

const gitExec: Exec = async (args) => {
  const res = await execa('git', [...args], { reject: false });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.exitCode ?? 1 };
};

const gitleaksRunner = async (opts: { cwd: string; baseSha: string; headSha: string }): Promise<{ clean: boolean; detail: string }> => {
  const probe = await execa('gitleaks', ['version'], { reject: false });
  if (probe.exitCode !== 0) {
    throw new Error('gitleaks is not installed');
  }
  const res = await execa(
    'gitleaks',
    ['detect', '--no-banner', '--redact', `--log-opts=${opts.baseSha}..${opts.headSha}`],
    { cwd: opts.cwd, reject: false },
  );
  if (res.exitCode === 0) return { clean: true, detail: 'no leaks found' };
  return { clean: false, detail: (res.stderr || res.stdout || 'gitleaks reported findings').slice(0, 500) };
};

export interface ShipVerbDeps {
  shipOpDeps?: Partial<ShipOpDeps>;
  runComplete?: typeof runOrchestrateComplete;
}

export async function runOrchestrateShip(args: ShipArgs, deps: ShipVerbDeps = {}): Promise<{ exitCode: number }> {
  const parsed = ShipArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  let settings: Settings;
  try {
    settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
  } catch (err) {
    if (err instanceof SettingsError) {
      return { exitCode: emit(fail(err.code, err.message, false), { json: opts.json }) };
    }
    return {
      exitCode: emit(fail('IO_ERROR', err instanceof Error ? err.message : String(err), false), { json: opts.json }),
    };
  }

  const leaseReader = (): ReturnType<typeof readLease> => readLease(opts.forgeDir, opts.taskId);

  // Parked-incident replay (plan v3 Δ12): re-invoking ship on a task whose
  // CURRENT unresolved park is still open returns the durable park — never a
  // duplicate question, never a confusing admission refusal.
  try {
    const currentState = readTaskState(opts.forgeDir, opts.taskId);
    if (currentState.state === 'blocked_on_question' && currentState.current_attempt_id === opts.attemptId) {
      const openParks = listOpenQuestionsAcrossTree({ forgeDir: opts.forgeDir }).filter((q) => {
        if (q.task_id !== opts.taskId || q.origin?.phase !== 'ship' || q.status !== 'open') return false;
        const loc = findQuestionFile(q.question_id, { forgeDir: opts.forgeDir });
        return loc !== null && loc.attemptId === opts.attemptId;
      });
      if (openParks.length > 0) {
        const q = openParks[0]!;
        return {
          exitCode: emit(
            fail('SHIP_PARKED' as never, `ship parked (${q.origin!.park_reason}): awaiting operator resolution`, false, {
              taskId: opts.taskId,
              park_reason: q.origin!.park_reason,
              question_id: q.question_id,
              replayed: true,
            }),
            { json: opts.json },
          ),
        };
      }
    }
    // impl-R1 MAJ #3: a crash BETWEEN question publication and the park
    // transition leaves state 'reviewed' with an open ship question — the
    // mandatory park must be REPAIRED, never silently deduped away.
    if (currentState.state === 'reviewed' && currentState.current_attempt_id === opts.attemptId) {
      // impl-R2 MAJ #2: repair ONLY a park owned by THIS attempt — attempt
      // B must never block itself on A's orphaned question (answering A's
      // question would then refuse against B's pointer, wedging the task).
      const orphanParks = listOpenQuestionsAcrossTree({ forgeDir: opts.forgeDir }).filter((q) => {
        if (q.task_id !== opts.taskId || q.origin?.phase !== 'ship' || q.status !== 'open') return false;
        const loc = findQuestionFile(q.question_id, { forgeDir: opts.forgeDir });
        return loc !== null && loc.attemptId === opts.attemptId;
      });
      if (orphanParks.length > 0) {
        const q = orphanParks[0]!;
        const lease = leaseReader();
        const next = applyTransition(currentState.state, 'question_written');
        writeTaskState(
          opts.forgeDir,
          {
            ...currentState,
            state: next,
            state_version: currentState.state_version + 1,
            updated_at: new Date().toISOString(),
            updated_by: callerFromLease(lease),
          },
          callerFromLease(lease),
          { requireActiveLease: true, expectedCurrentAttemptId: opts.attemptId },
        );
        return {
          exitCode: emit(
            fail('SHIP_PARKED' as never, `ship parked (${q.origin!.park_reason}): park transition repaired`, false, {
              taskId: opts.taskId,
              park_reason: q.origin!.park_reason,
              question_id: q.question_id,
              replayed: true,
              repaired: true,
            }),
            { json: opts.json },
          ),
        };
      }
    }
  } catch {
    // state unreadable → fall through; the operation's admission reports it
  }

  // Production dep wiring (tests inject via deps.shipOpDeps).
  const record = (() => {
    try {
      return readShipRecord(opts.forgeDir, opts.taskId);
    } catch {
      return null;
    }
  })();
  let repoHost = deps.shipOpDeps?.repoHost;
  if (repoHost === undefined) {
    // impl-R1 CRIT #1: production wiring derives EVERY identity from the
    // MANIFEST — worktree path, frozen base branch (worktree marker), and the
    // live head branch. Empty sentinels would break the first real
    // resolveBase() (branch '' fails the record schema) and topology
    // detection (wrong cwd).
    const manifestReviewBinding = record
      ? { attemptId: record.review_attempt_id, headSha: record.reviewed_head_sha }
      : { attemptId: 'unresolved', headSha: '0'.repeat(40) };
    let lease;
    let manifestForWiring;
    try {
      lease = leaseReader();
      const raw = readFileSync(manifestFilePath(opts.forgeDir, opts.taskId, opts.attemptId), 'utf8');
      const parsedManifest = AttemptManifestSchema.safeParse(JSON.parse(raw));
      if (!parsedManifest.success) {
        return {
          exitCode: emit(fail('SCHEMA_INVALID', `ship manifest for ${opts.attemptId} failed schema validation`, false), {
            json: opts.json,
          }),
        };
      }
      manifestForWiring = parsedManifest.data;
    } catch (err) {
      const e = err as unknown;
      return {
        exitCode: emit(
          fail(e instanceof OrchestratorError ? e.code : 'IO_ERROR', e instanceof Error ? e.message : String(e), false),
          { json: opts.json },
        ),
      };
    }
    const worktreePath = manifestForWiring.worktree_path;
    const frozenBase = readFrozenBaseBranch(worktreePath);
    if (frozenBase === null) {
      return {
        exitCode: emit(
          fail('VERIFICATION_FAILED', `worktree at ${worktreePath} has no frozen base branch marker`, false),
          { json: opts.json },
        ),
      };
    }
    // Worktree-scoped git: the adapter's topology/config reads must run IN
    // the task worktree, never the invoking cwd.
    const worktreeGit: Exec = async (args) => gitExec(['-C', worktreePath, ...args]);
    const headBranchRes = await worktreeGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = headBranchRes.stdout.trim();
    if (headBranchRes.exitCode !== 0 || headBranch.length === 0 || headBranch === 'HEAD') {
      return {
        exitCode: emit(fail('VERIFICATION_FAILED', `worktree at ${worktreePath} is not on a named branch`, false), {
          json: opts.json,
        }),
      };
    }
    repoHost = await createGitHubRepoHost({
      gh: ghExec,
      git: worktreeGit,
      worktreePath,
      taskId: opts.taskId,
      forgeDir: opts.forgeDir,
      baseBranch: frozenBase,
      headBranch,
      reviewBinding: manifestReviewBinding,
      holder: { run_id: lease.owner_run_id, claim_id: lease.claim_id, generation: lease.generation },
      pollDelayMs: 2000,
    });
  }

  const trackerPort = deps.shipOpDeps?.tracker ?? {
    updateState: async (state: 'in_review') => {
      try {
        const handle = createTracker(settings, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
        await handle.tracker.updateState(opts.taskId, state);
        return { ok: true as const };
      } catch (err) {
        if (err instanceof TrackerError) {
          return { ok: false as const, retriable: isRetriableTrackerErrorCode(err.code), detail: err.message.slice(0, 300) };
        }
        return { ok: false as const, retriable: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
      }
    },
  };

  const shipOpDeps: ShipOpDeps = {
    git: deps.shipOpDeps?.git ?? gitExec,
    runCommand: deps.shipOpDeps?.runCommand,
    repoHost,
    tracker: trackerPort,
    gitleaks: 'gitleaks' in (deps.shipOpDeps ?? {}) ? deps.shipOpDeps!.gitleaks : gitleaksRunner,
    sleepMs: deps.shipOpDeps?.sleepMs,
    now: deps.shipOpDeps?.now,
  };

  let outcome: ShipOpOutcome;
  try {
    outcome = await runShipOperation(
      { forgeDir: opts.forgeDir, taskId: opts.taskId, attemptId: opts.attemptId, settings },
      shipOpDeps,
      leaseReader,
    );
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `ship operation failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }

  const runComplete = deps.runComplete ?? runOrchestrateComplete;

  switch (outcome.kind) {
    case 'success':
    case 'failure': {
      // The complete choke point owns the state CAS, budget, lease release,
      // notification, AND the output envelope (plan v2 Δ5 single-envelope).
      // The verb's OWN RepoHost serves complete's fresh live-head read — the
      // observer seam must not fall back to a second production wiring.
      const hostForComplete = repoHost;
      return runComplete(
        {
          taskId: opts.taskId,
          attemptId: opts.attemptId,
          verdictFile: outcome.verdictInputPath,
          phase: 'ship',
          forgeDir: opts.forgeDir,
          json: opts.json,
        },
        {
          observerFor:
            hostForComplete === null
              ? undefined
              : async () => ({
                  mergeResult: (pr: Parameters<typeof hostForComplete.mergeResult>[0]) => hostForComplete.mergeResult(pr),
                  headSha: (pr: Parameters<typeof hostForComplete.headSha>[0]) => hostForComplete.headSha(pr),
                }),
          // impl-R3 MAJ #1: BOTH outcomes bind the completion CAS to the
          // admitted state version — a round-trip between the operation's
          // last fence and complete's commit refuses instead of consuming
          // budget (failure) or double-committing (success re-check).
          ...(outcome.kind === 'failure' ? { expectedStateVersion: outcome.admittedStateVersion } : {}),
        },
      );
    }
    case 'drift': {
      // No-fault regression (plan v2 Δ6): reviewed → ready_for_review, no
      // budget consumption; drift attempt event for the audit trail.
      try {
        const lease = leaseReader();
        const state = readTaskState(opts.forgeDir, opts.taskId);
        if (state.state === 'reviewed' && state.current_attempt_id === opts.attemptId) {
          const next = applyTransition(state.state, 'head_drift');
          writeTaskState(
            opts.forgeDir,
            {
              ...state,
              state: next,
              state_version: state.state_version + 1,
              updated_at: new Date().toISOString(),
              updated_by: callerFromLease(lease),
            },
            callerFromLease(lease),
            {
              requireActiveLease: true,
              expectedCurrentAttemptId: opts.attemptId,
              expectedStateVersion: outcome.admittedStateVersion,
            },
          );
          try {
            appendAttemptEvent(
              { type: 'ship_drift', ts: new Date().toISOString(), detail: outcome.detail.slice(0, 500) },
              { forgeDir: opts.forgeDir, taskId: opts.taskId, attemptId: opts.attemptId, caller: callerFromLease(lease) },
            );
          } catch {
            // audit-trail append is best-effort; the regression already committed
          }
        }
      } catch (err) {
        return {
          exitCode: emit(
            fail(err instanceof OrchestratorError ? err.code : 'IO_ERROR', err instanceof Error ? err.message : String(err), false),
            { json: opts.json },
          ),
        };
      }
      return {
        exitCode: emit(
          fail('VERIFICATION_FAILED', `ship head drift: ${outcome.detail} — task regressed to ready_for_review (no fault)`, false, {
            taskId: opts.taskId,
            drift: outcome.detail,
          }),
          { json: opts.json },
        ),
      };
    }
    case 'park':
      return parkShip(opts, outcome.reason, outcome.detail, outcome.fingerprint);
    case 'refused':
      return {
        exitCode: emit(fail(outcome.code as never, outcome.detail, false, { taskId: opts.taskId }), { json: opts.json }),
      };
  }
}

// ─── parkShip (plan v3 Δ12) ──────────────────────────────────────────────────

// Mandatory SHIP policy parks NEVER route through the generic decision
// classifier: no hard-cap forced_autonomous, no prior-answer reuse. Dedupe is
// scoped to the CURRENT unresolved incident (fingerprint match on an OPEN
// ship-origin question); a resolved incident is consumed — recurrence parks
// fresh.
async function parkShip(
  opts: ShipArgs,
  reason: ShipParkReason,
  detail: string,
  fingerprint: string,
): Promise<{ exitCode: number }> {
  try {
    // impl-R2 MAJ #2: incident dedupe is ATTEMPT-BOUND — a superseded
    // attempt's open question never satisfies the current attempt's park.
    const open = listOpenQuestionsAcrossTree({ forgeDir: opts.forgeDir }).filter((q) => {
      if (q.task_id !== opts.taskId || q.origin?.incident_fingerprint !== fingerprint || q.status !== 'open') return false;
      const loc = findQuestionFile(q.question_id, { forgeDir: opts.forgeDir });
      return loc !== null && loc.attemptId === opts.attemptId;
    });
    if (open.length > 0) {
      // Replay of the SAME unresolved incident — the durable park already exists.
      return {
        exitCode: emit(
          fail('SHIP_PARKED' as never, `ship parked (${reason}): ${detail}`, false, {
            taskId: opts.taskId,
            park_reason: reason,
            question_id: open[0]!.question_id,
            replayed: true,
          }),
          { json: opts.json },
        ),
      };
    }

    const lease = readLease(opts.forgeDir, opts.taskId);
    const state = readTaskState(opts.forgeDir, opts.taskId);
    if (state.state !== 'reviewed' || state.current_attempt_id !== opts.attemptId) {
      return {
        exitCode: emit(
          fail('STALE_ATTEMPT', `cannot park ship for ${opts.taskId}: state moved (${state.state})`, false),
          { json: opts.json },
        ),
      };
    }

    const questionId = uuidv7();
    const nowIso = new Date().toISOString();
    writeQuestionAtomic(
      {
        version: 1,
        question_id: questionId,
        run_id: lease.owner_run_id,
        task_id: opts.taskId,
        agent_id: 'ship-verb',
        decision_key: `ship-park:${fingerprint}`.slice(0, 200),
        attempt: 1,
        max_attempts: 1,
        created_at: nowIso,
        expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        status: 'open',
        question: `SHIP parked (${reason}): ${detail.slice(0, 2000)}`,
        context: `The orchestrator cannot ship task ${opts.taskId} under the current repository policy/topology. Resolve the underlying condition, then answer retry_ship — or cancel the task.`,
        options: [
          { id: 'retry_ship', label: 'Retry ship (condition resolved)' },
          { id: 'cancel_task', label: 'Cancel the task' },
        ],
        recommended_option_id: 'retry_ship',
        classification: {
          decision_type: 'architectural',
          category: 'enforcement_mode',
          reversibility: 'medium',
          blast_radius: 'external',
          default_action: 'ask',
          reason: 'mandatory fail-closed SHIP policy park — never autonomous',
        },
        origin: { phase: 'ship', park_reason: reason, incident_fingerprint: fingerprint },
      },
      { forgeDir: opts.forgeDir, taskId: opts.taskId, attemptId: opts.attemptId },
    );

    const next = applyTransition(state.state, 'question_written');
    writeTaskState(
      opts.forgeDir,
      {
        ...state,
        state: next,
        state_version: state.state_version + 1,
        updated_at: nowIso,
        updated_by: callerFromLease(lease),
      },
      callerFromLease(lease),
      { requireActiveLease: true, expectedCurrentAttemptId: opts.attemptId },
    );

    return {
      exitCode: emit(
        fail('SHIP_PARKED' as never, `ship parked (${reason}): ${detail}`, false, {
          taskId: opts.taskId,
          park_reason: reason,
          question_id: questionId,
          incident_fingerprint: fingerprint,
        }),
        { json: opts.json },
      ),
    };
  } catch (err) {
    return {
      exitCode: emit(
        fail(err instanceof OrchestratorError ? err.code : 'IO_ERROR', err instanceof Error ? err.message : String(err), false),
        { json: opts.json },
      ),
    };
  }
}
