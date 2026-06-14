// `forge orchestrate complete` — finalize an attempt.
//
// Reads --verdict-file, validates against VerdictSchema, writes both
// verdict.json (worker-reported) and verdict.verified.json (CLI-recomputed
// is deferred to a follow-up; v0.4 stores the verified copy = the reported
// copy plus a `verified_by: 'cli'` envelope). Transitions task state per
// (verdict, phase):
//   implement + ready_for_review → ready_for_review
//   review    + ready_for_review → reviewed
//   ship      + ready_for_review → shipped (terminal)
//   _         + changes_needed   → running (loop back)
//   _         + blocked          → running (then worker writes a question)

import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CompleteArgsSchema, type CompleteArgs } from '../../schemas/cli-args.ts';
import { VerdictSchema } from '../../schemas/verdict.ts';
import { readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import type { Lease } from '../../schemas/lease.ts';
import { attemptDir, manifestFilePath } from '../../orchestrator/questions/paths.ts';
import { OrchestratorError, SettingsError } from '../../core/errors.ts';
import type { TaskState } from '../../schemas/task-state.ts';
import { loadSettings } from '../../core/settings.ts';
import { sanitizeIssueId, TASK_MARKER_RELPATH } from '../../core/workspace.ts';
import { isSymlinkAt, firstSymlinkedParent } from '../../core/symlink-guard.ts';
import {
  runVerify,
  type RunCommand,
  type VerifyResult,
} from '../../orchestrator/verify-runner.ts';
import {
  DEFAULT_RETRY_POLICY,
  nextRetryState,
  type RetryPolicy,
} from '../../orchestrator/retry.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { resolveLogRotateMaxBytes } from './log-rotate-settings.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import type { VerbHandler } from './index.ts';

export async function runOrchestrateComplete(
  args: CompleteArgs,
  deps: { run?: RunCommand } = {},
): Promise<{ exitCode: number }> {
  const parsed = CompleteArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // 1. Read verdict file.
  let verdictRaw: string;
  try {
    verdictRaw = readFileSync(opts.verdictFile, 'utf8');
  } catch (err) {
    return {
      exitCode: emit(
        fail('VERDICT_FILE_READ_FAILED', err instanceof Error ? err.message : String(err), false),
        { json: opts.json },
      ),
    };
  }
  let verdictParsed: unknown;
  try {
    verdictParsed = JSON.parse(verdictRaw);
  } catch (err) {
    return {
      exitCode: emit(
        fail('INVALID_VERDICT_FILE', `not valid JSON: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }
  const verdict = VerdictSchema.safeParse(verdictParsed);
  if (!verdict.success) {
    return {
      exitCode: emit(
        fail('INVALID_VERDICT', verdict.error.message, false),
        { json: opts.json },
      ),
    };
  }

  // 1b. FORGE-188 (F1): bind the supplied attempt to the task's CURRENT attempt.
  //     A complete for any attempt that is not state.current_attempt_id is always
  //     wrong (a stale/forged --attempt could otherwise resolve a worktree that
  //     passes verification and advance the task on behalf of a superseded run).
  //     This runs BEFORE verification AND before any verdict/verified/state write,
  //     for ALL verdicts and phases, so a mismatch leaves nothing on disk and the
  //     task untouched. STALE_ATTEMPT is non-retriable: the caller must re-derive
  //     the current attempt, never re-submit the stale one.
  let preState;
  try {
    preState = readTaskState(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }
  if (preState.current_attempt_id !== opts.attemptId) {
    return {
      exitCode: emit(
        fail(
          'STALE_ATTEMPT',
          `attempt '${opts.attemptId}' is not the task's current attempt` +
            ` (current: ${preState.current_attempt_id ?? 'none'}); refusing to complete a non-current attempt.`,
          false,
          {
            current_attempt_id: preState.current_attempt_id,
            supplied_attempt_id: opts.attemptId,
          },
        ),
        { json: opts.json },
      ),
    };
  }

  // 2a. Pre-check: each phase has a required prior state. Refuse loudly here
  //     with INVALID_STATE_FOR_PHASE rather than letting writeTaskState throw
  //     a generic ILLEGAL_TRANSITION later (Codex 2nd-pass). The state
  //     machine table is: implement+ready_for_review fires from 'running',
  //     review+ready_for_review fires from 'ready_for_review',
  //     ship+ready_for_review fires from 'reviewed'.
  if (verdict.data.verdict === 'ready_for_review') {
    const requiredByPhase: Record<typeof opts.phase, string> = {
      implement: 'running',
      review: 'ready_for_review',
      ship: 'reviewed',
    };
    let currentState;
    try {
      currentState = readTaskState(opts.forgeDir, opts.taskId).state;
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            err instanceof OrchestratorError ? err.code : 'IO_ERROR',
            err instanceof Error ? err.message : String(err),
            false,
          ),
          { json: opts.json },
        ),
      };
    }
    const required = requiredByPhase[opts.phase];
    if (currentState !== required) {
      return {
        exitCode: emit(
          fail(
            'INVALID_STATE_FOR_PHASE',
            `cannot complete --phase ${opts.phase} from state '${currentState}'; expected '${required}'.`,
            false,
            { current_state: currentState, required_state: required, phase: opts.phase },
          ),
          { json: opts.json },
        ),
      };
    }
  }

  // 2b. Read lease for caller identity.
  let lease: Lease;
  try {
    lease = readLease(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  // 2c. FORGE-188: INDEPENDENT CLI re-verification. The implement-phase
  //     "ready_for_review" claim is the only one that produces code to re-run;
  //     for it we re-run `settings.verify` OURSELVES in the task worktree rather
  //     than trusting the worker's self-reported tests/lint. This happens BEFORE
  //     any verdict/verified file is written, so a verification failure leaves
  //     NOTHING on disk and the task stays in 'running' for a clean retry.
  //
  //     Fail-closed (R1): when verification is REQUIRED (settings.verify present)
  //     and we cannot run it (missing worktree, unreadable settings other than
  //     "not configured"), we FAIL — never silently advance via self-attest.
  //     Skip is reserved for the genuinely-unconfigured cases (no settings.verify
  //     / settings.yaml absent).
  let vr: VerifyResult = { ran: false, passed: false, results: [], skippedReason: 'verification not applicable' };
  if (verdict.data.verdict === 'ready_for_review' && opts.phase === 'implement') {
    // Load settings. Mirror loadRetryPolicy's SettingsError handling, but per R2
    // ONLY FILE_NOT_FOUND means "verify unconfigured → skip"; any other
    // SettingsError (YAML_PARSE_ERROR / VALIDATION_ERROR / IO_ERROR) is a real
    // configuration fault and must fail cleanly here, before any write.
    let verify;
    try {
      verify = loadSettings(path.join(opts.forgeDir, 'settings.yaml')).verify;
    } catch (err) {
      if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
        verify = undefined; // unconfigured → legitimate skip
      } else if (err instanceof SettingsError) {
        return {
          exitCode: emit(fail(err.code, err.message, false), { json: opts.json }),
        };
      } else {
        return {
          exitCode: emit(
            fail('IO_ERROR', err instanceof Error ? err.message : String(err), false),
            { json: opts.json },
          ),
        };
      }
    }

    if (!verify) {
      // Nothing configured to verify — record the skip, advance as before.
      vr = { ran: false, passed: false, results: [], skippedReason: 'no settings.verify configured' };
    } else {
      // Verification is REQUIRED. Resolve the worktree STRICTLY from the
      // attempt's dispatch manifest (the path dispatch actually used). There is
      // NO canonical fallback: a dispatched current attempt always has a manifest
      // with a worktree_path, so any deviation (absent / unreadable / corrupt /
      // missing / empty / wrong-type) returns 'invalid' → fail closed.
      const resolved = resolveWorktreePath(opts.forgeDir, opts.taskId, opts.attemptId);
      if (resolved.kind === 'invalid') {
        return {
          exitCode: emit(
            fail(
              'VERIFICATION_FAILED',
              'cannot verify: dispatch manifest is present but corrupt (unparseable or invalid worktree_path)',
              false,
              { reason: 'manifest_invalid' },
            ),
            { json: opts.json },
          ),
        };
      }
      const worktreePath = resolved.kind === 'resolved' ? resolved.path : null;
      if (!worktreePath || !existsSync(worktreePath)) {
        // REQUIRED but cannot run → fail closed. The gate is never bypassable.
        return {
          exitCode: emit(
            fail(
              'VERIFICATION_FAILED',
              `cannot verify: worktree not found at ${worktreePath ?? '(unresolved)'}`,
              false,
              { reason: 'worktree_missing', path: worktreePath ?? null },
            ),
            { json: opts.json },
          ),
        };
      }
      // F2: prove the resolved worktree is bound to THIS task (no symlink escape,
      // marker present, marker taskId matches) BEFORE running any command in it.
      const bindingFailure = proveWorktreeBinding(worktreePath, opts.taskId);
      if (bindingFailure) {
        return {
          exitCode: emit(
            fail(
              'VERIFICATION_FAILED',
              `cannot verify: worktree at ${worktreePath} is not provably bound to task ${opts.taskId} (${bindingFailure})`,
              false,
              { reason: bindingFailure, path: worktreePath },
            ),
            { json: opts.json },
          ),
        };
      }
      vr = await runVerify(verify, { cwd: worktreePath, run: deps.run });
      if (vr.ran && !vr.passed) {
        const failed_commands = vr.results.filter((r) => r.exitCode !== 0).map((r) => r.command);
        return {
          exitCode: emit(
            fail(
              'VERIFICATION_FAILED',
              `independent verification failed: ${failed_commands.length} command(s) did not pass`,
              false,
              { reason: 'commands_failed', failed_commands },
            ),
            { json: opts.json },
          ),
        };
      }
    }
  }

  // 3. Write the verdict + verified files atomically. FORGE-187 (R1): the
  //    filenames are phase-scoped so implement, review, and ship can each write
  //    a verdict on the SAME attempt without colliding (the `flag:'wx'` write
  //    refuses to overwrite). The implement phase keeps the historical
  //    `verdict.json` / `verdict.verified.json` names for back-compat — every
  //    reader (gc reverify_verdict / row 8, dashboard, etc.) reads the
  //    implement-phase file, which is unchanged.
  const dir = attemptDir(opts.forgeDir, opts.taskId, opts.attemptId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `failed to ensure attempt dir: ${err instanceof Error ? err.message : String(err)}`, true),
        { json: opts.json },
      ),
    };
  }
  const { verdictFile, verifiedFile } = verdictFileNames(opts.phase);
  const verdictPath = path.join(dir, verdictFile);
  const verifiedPath = path.join(dir, verifiedFile);
  try {
    writeFileSync(verdictPath, `${JSON.stringify(verdict.data, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `${verdictFile} write failed: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }
  // verdict.verified.json: FORGE-188 — when settings.verify is configured and
  // this is the implement/ready_for_review claim, the `verification` block holds
  // the REAL re-run result computed above (vr.ran === true). Otherwise it records
  // a skip (vr.ran === false + skipped_reason) and the stamp falls back to
  // self-attest. The block is additive — every existing reader (gc
  // reverify_verdict / row 8, dashboard) only checks file presence, not these
  // fields, so back-compat holds.
  const verified = {
    ...verdict.data,
    verified_by: vr.ran ? 'cli@live' : 'cli@self-attest',
    verified_at: new Date().toISOString(),
    verification: {
      ran: vr.ran,
      passed: vr.passed,
      results: vr.results,
      ...(vr.skippedReason ? { skipped_reason: vr.skippedReason } : {}),
    },
  };
  try {
    writeFileSync(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    // The verdict file was just created with `wx`; if the verified-file write
    // fails we'd leave an orphan verdict that collides (wx) on every retry of
    // this phase. Roll it back so the phase can be re-attempted cleanly.
    try {
      rmSync(verdictPath, { force: true });
    } catch {
      // best-effort cleanup; the original IO_ERROR is the authoritative failure.
    }
    return {
      exitCode: emit(
        fail('IO_ERROR', `${verifiedFile} write failed: ${err instanceof Error ? err.message : String(err)}`, false),
        { json: opts.json },
      ),
    };
  }

  // 4. Append the 'attempt_completed' event.
  try {
    appendAttemptEvent(
      {
        type: 'attempt_completed',
        ts: new Date().toISOString(),
        verdict: verdict.data.verdict,
      },
      {
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        attemptId: opts.attemptId,
        caller: callerFromLease(lease),
        logRotateMaxBytes: resolveLogRotateMaxBytes(opts.forgeDir),
      },
    );
  } catch {
    // best-effort
  }

  // 5. State transition.
  let nextState: TaskState | null = null;
  let failureReason: 'decision_key_budget' | 'retries_exhausted' | 'fatal' | undefined;
  let lastFailedAt: string | undefined;
  if (verdict.data.verdict === 'ready_for_review') {
    if (opts.phase === 'implement') nextState = 'ready_for_review';
    else if (opts.phase === 'review') nextState = 'reviewed';
    else if (opts.phase === 'ship') nextState = 'shipped';
  } else if (verdict.data.verdict === 'changes_needed' || verdict.data.verdict === 'blocked') {
    // Failed attempt. Use the retry policy to decide whether to loop back or
    // mark terminal failure; phases --ready enforces the backoff via last_failed_at.
    lastFailedAt = new Date().toISOString();
    try {
      const state = readTaskState(opts.forgeDir, opts.taskId);
      const decision = nextRetryState(
        state.attempt_count,
        'transient',
        loadRetryPolicy(opts.forgeDir),
      );
      if (decision.state === 'retry') {
        nextState = 'running';
      } else {
        nextState = 'failed';
        failureReason = decision.failure_reason;
      }
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            err instanceof OrchestratorError ? err.code : 'IO_ERROR',
            err instanceof Error ? err.message : String(err),
            true,
            { hint: 'verdict written; retry classification failed — run forge orchestrate gc' },
          ),
          { json: opts.json },
        ),
      };
    }
  }
  if (nextState) {
    try {
      const state = readTaskState(opts.forgeDir, opts.taskId);
      writeTaskState(
        opts.forgeDir,
        {
          ...state,
          state: nextState,
          state_version: state.state_version + 1,
          ...(failureReason ? { failure_reason: failureReason } : {}),
          ...(lastFailedAt ? { last_failed_at: lastFailedAt } : {}),
          updated_at: new Date().toISOString(),
          updated_by: {
            run_id: lease.owner_run_id,
            claim_id: lease.claim_id,
            generation: lease.generation,
          },
        },
        callerFromLease(lease),
      );
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            err instanceof OrchestratorError ? err.code : 'IO_ERROR',
            err instanceof Error ? err.message : String(err),
            true,
            { hint: 'verdict written; state transition failed — run forge orchestrate gc' },
          ),
          { json: opts.json },
        ),
      };
    }
  }

  return {
    exitCode: emit(
      ok({
        verdict: verdict.data.verdict,
        next_state: nextState,
        verdict_path: verdictPath,
      }),
      { json: opts.json },
    ),
  };
}

// FORGE-187 (R1): map the completion phase to its verdict filenames. The
// implement phase keeps the historical names (`verdict.json` /
// `verdict.verified.json`) — these are what every existing reader consumes,
// so back-compat is preserved. review and ship get distinct, phase-scoped
// names so a review/ship completion on the same attempt as implement does not
// collide with the `flag:'wx'` (exclusive-create) write.
function verdictFileNames(phase: CompleteArgs['phase']): {
  verdictFile: string;
  verifiedFile: string;
} {
  switch (phase) {
    case 'review':
      return { verdictFile: 'verdict.review.json', verifiedFile: 'verdict.review.verified.json' };
    case 'ship':
      return { verdictFile: 'verdict.ship.json', verifiedFile: 'verdict.ship.verified.json' };
    case 'implement':
    default:
      return { verdictFile: 'verdict.json', verifiedFile: 'verdict.verified.json' };
  }
}

// FORGE-188 (R1 + F3): resolve the worktree the attempt was dispatched into. The
// dispatch manifest (attempts/<attemptId>/manifest.json) records the exact
// `worktree_path` that dispatch used — prefer it over guessing.
//
// F3 (manifest strictness — don't mask tampering): a manifest that is ABSENT or
// has NO `worktree_path` field is a legacy/pre-dispatch record → we fall back to
// the canonical gc/ensure-worktree layout. But a manifest that EXISTS yet is
// unparseable, or whose `worktree_path` is the wrong type, is a CORRUPT dispatch
// record — categorically different from a legacy-absent one — and must fail
// closed when verification is required rather than silently guessing a path.
//
// SECURITY: there is NO canonical-worktree fallback. A verification-required
// CURRENT attempt (current_attempt_id, enforced upstream) was necessarily
// dispatched, and dispatch ALWAYS writes a manifest carrying a non-empty
// worktree_path. So any deviation — manifest absent (ENOENT), unreadable
// (EACCES/EISDIR/…), unparseable, or lacking a valid worktree_path — is
// untrustworthy and MUST fail closed. Falling back to `.forge/worktrees/<task>`
// would let a deleted/`{}` manifest redirect verification to a different tree
// that happens to carry a matching marker and pass (third-pass review bypass).
//
// Outcomes:
//   { kind: 'resolved', path }   — manifest present with a valid worktree_path
//   { kind: 'invalid' }          — anything else → fail closed
type ResolvedWorktree = { kind: 'resolved'; path: string } | { kind: 'invalid' };

function resolveWorktreePath(
  forgeDir: string,
  taskId: string,
  attemptId: string,
): ResolvedWorktree {
  const manifestPath = manifestFilePath(forgeDir, taskId, attemptId);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    // Absent / unreadable — no trustworthy dispatched path. No fallback.
    return { kind: 'invalid' };
  }
  let parsed: { worktree_path?: unknown };
  try {
    parsed = JSON.parse(raw) as { worktree_path?: unknown };
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof parsed.worktree_path === 'string' && parsed.worktree_path.length > 0) {
    return { kind: 'resolved', path: parsed.worktree_path };
  }
  // Missing / empty / wrong-type worktree_path → fail closed.
  return { kind: 'invalid' };
}

// FORGE-188 (F2): prove a resolved worktree actually belongs to THIS task before
// trusting it as a verify cwd. Three independent gates, any failure → reason:
//   'worktree_symlink' — the path itself, or a parent component, is a symlink, OR
//                        realpath containment can't be established. A symlinked
//                        verify cwd could redirect command execution outside the
//                        task's tree (consistent with the 0.4.2 symlink-class
//                        hardening in symlink-guard.ts).
//   'worktree_unbound' — no `.forge/worktree-task.json` binding marker present.
//   'marker_mismatch'  — the marker's taskId is not this task's sanitized id.
// Returns null when every gate passes; otherwise the failure reason.
function proveWorktreeBinding(
  worktreePath: string,
  taskId: string,
): null | 'worktree_symlink' | 'worktree_unbound' | 'marker_mismatch' {
  // 1. Symlink / escape rejection. The threat is a `worktree_path` whose LEAF
  //    (or a leaf-adjacent component forge itself materializes) is a symlink that
  //    redirects the verify cwd outside the task's real tree. We reject:
  //      - a symlinked leaf (isSymlinkAt), and
  //      - a leaf that, after realpath, does not sit directly under its parent's
  //        realpath (i.e. the leaf component itself crosses a boundary).
  //    Ancestor system symlinks (e.g. macOS /var → /private/var, or a dotfiles
  //    repo symlinked far above) are tolerated: they are not attacker-controlled
  //    relative to the task, and over-rejecting them would break legitimate
  //    worktrees. realpathSync throws on a broken/dangling link → reject.
  if (isSymlinkAt(worktreePath)) return 'worktree_symlink';
  const parentDir = path.dirname(worktreePath);
  const leaf = path.basename(worktreePath);
  // firstSymlinkedParent walks the components of relPath UNDER `parentDir` (it
  // drops the relPath leaf), so passing `<leaf>/_` makes the worktree leaf an
  // intermediate component that IS checked — catching a symlinked leaf even when
  // the lstat above raced. The `parentDir` anchor keeps ancestor symlinks out of
  // scope.
  if (parentDir !== worktreePath && firstSymlinkedParent(parentDir, path.join(leaf, '_')) !== null) {
    return 'worktree_symlink';
  }
  try {
    const realParent = realpathSync(parentDir);
    const realWorktree = realpathSync(worktreePath);
    if (realWorktree !== path.join(realParent, leaf)) {
      // The leaf component itself was rewritten by a symlink → escape.
      return 'worktree_symlink';
    }
  } catch {
    return 'worktree_symlink';
  }

  // 2. Binding marker must exist.
  const markerPath = path.join(worktreePath, TASK_MARKER_RELPATH);
  let markerRaw: string;
  try {
    markerRaw = readFileSync(markerPath, 'utf8');
  } catch {
    return 'worktree_unbound';
  }
  // 3. Marker taskId must equal this task's sanitized id.
  let markerTaskId: unknown;
  try {
    markerTaskId = (JSON.parse(markerRaw) as { taskId?: unknown }).taskId;
  } catch {
    return 'marker_mismatch';
  }
  let expected: string;
  try {
    expected = sanitizeIssueId(taskId);
  } catch {
    return 'marker_mismatch';
  }
  if (typeof markerTaskId !== 'string' || markerTaskId !== expected) {
    return 'marker_mismatch';
  }
  return null;
}

function loadRetryPolicy(forgeDir: string): RetryPolicy {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return {
      retry_attempts: settings.agents.retry_attempts,
      retry_backoff_ms_max: settings.agents.retry_backoff_ms_max,
    };
  } catch (err) {
    if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
      return DEFAULT_RETRY_POLICY;
    }
    throw err;
  }
}

export const completeHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Finalize an attempt: write verdict + transition state per (verdict, phase).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const verdictFile = parseFlag(rest, 'verdict-file') ?? '';
    const phaseFlag = parseFlag(rest, 'phase');
    const phase = (phaseFlag === 'implement' || phaseFlag === 'review' || phaseFlag === 'ship')
      ? phaseFlag
      : 'implement';
    const json = hasFlag(rest, 'json');
    return runOrchestrateComplete({ taskId, attemptId, verdictFile, phase, forgeDir, json });
  },
};
