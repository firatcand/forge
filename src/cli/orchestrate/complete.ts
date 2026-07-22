// `forge orchestrate complete` — finalize an attempt.
//
// Reads --verdict-file, validates against VerdictSchema, writes phase-scoped
// verdict + verified files, and transitions task state through the table
// (applyTransition). FORGE-231 semantics:
//   implement + ready_for_review → ready_for_review (dual-host)
//                                → reviewed          (single-host direct path;
//                                  CLI-verified HEAD becomes the reviewed
//                                  binding — ship-record write-ahead first)
//   review    + ready_for_review → reviewed (the PINNED-REVIEW GATE: the raw
//                                  witness at attempts/<id>/review_verdict.json
//                                  is re-composed through the trusted gateway;
//                                  the supplied composed artifact must EQUAL
//                                  the recomputation; ship-record write-ahead)
//   ship      + ready_for_review → merge_pending (ONLY with a complete ship
//                                  record: reviewed binding + base + pr — the
//                                  platform merge is the only proof of shipped)
//   changes_needed               → awaiting_respawn (budget), or failed on
//                                  exhaustion (chained in the same CAS)
//   blocked                      → blocked_on_question from running; budgeted
//                                  failure from review/ship states
// Failure accounting: ONE total budget (failure_count vs agents.retry_attempts)
// with last_failure_key = "<attempt_id>:<phase>" replay idempotency — a
// crash-replayed completion short-circuits BEFORE any transition.

import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CompleteArgsSchema, type CompleteArgs } from '../../schemas/cli-args.ts';
import { VerdictSchema } from '../../schemas/verdict.ts';
import { AttemptManifestSchema, type AttemptManifest } from '../../schemas/attempt.ts';
import { applyTransition, readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { composeTrustedReviewOutcome } from '../../orchestrator/review-compose.ts';
import { upsertReviewedBinding, readShipRecord } from '../../orchestrator/ship-record.ts';
import { release as releaseLease } from '../../orchestrator/leases.ts';
import { appendNotificationEvent } from '../../orchestrator/events.ts';
import { resolveShaChecked } from '../../orchestrator/worktree-base.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import type { Lease } from '../../schemas/lease.ts';
import { attemptDir, manifestFilePath } from '../../orchestrator/questions/paths.ts';
import { CasError, OrchestratorError, SettingsError } from '../../core/errors.ts';
import type { TaskState } from '../../schemas/task-state.ts';
import { loadSettings } from '../../core/settings.ts';
import { sanitizeIssueId, TASK_MARKER_RELPATH } from '../../core/workspace.ts';
import { isSymlinkAt, firstSymlinkedParent } from '../../core/symlink-guard.ts';
import {
  runVerify,
  type RunCommand,
  type VerifyResult,
} from '../../orchestrator/verify-runner.ts';
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

  // 1c. FORGE-231: bind the completion to the attempt's dispatched PHASE. A
  //     review/ship completion against an implement attempt (or vice versa)
  //     is a phase-confusion attack surface — refuse for ALL phases. A
  //     manifest that is absent is a legacy pre-FORGE-231 record: legal only
  //     for implement.
  let manifest: AttemptManifest | null = null;
  {
    const manifestPath = manifestFilePath(opts.forgeDir, opts.taskId, opts.attemptId);
    let manifestRaw: string | null = null;
    try {
      manifestRaw = readFileSync(manifestPath, 'utf8');
    } catch {
      manifestRaw = null; // legacy-absent — gated below
    }
    if (manifestRaw !== null) {
      let parsedManifest: unknown;
      try {
        parsedManifest = JSON.parse(manifestRaw);
      } catch {
        return {
          exitCode: emit(
            fail('SCHEMA_INVALID', `attempt manifest at ${manifestPath} is unparseable`, false),
            { json: opts.json },
          ),
        };
      }
      const validated = AttemptManifestSchema.safeParse(parsedManifest);
      if (!validated.success) {
        return {
          exitCode: emit(
            fail('SCHEMA_INVALID', `attempt manifest failed schema validation: ${validated.error.message}`, false),
            { json: opts.json },
          ),
        };
      }
      manifest = validated.data;
    }
    const manifestPhase = manifest?.phase ?? 'implement';
    if (manifestPhase !== opts.phase) {
      return {
        exitCode: emit(
          fail(
            'PHASE_MISMATCH',
            `attempt '${opts.attemptId}' was dispatched for phase '${manifestPhase}' but completion claims phase '${opts.phase}'`,
            false,
            { manifest_phase: manifestPhase, supplied_phase: opts.phase },
          ),
          { json: opts.json },
        ),
      };
    }
    if (manifest === null && opts.phase !== 'implement') {
      return {
        exitCode: emit(
          fail(
            'PHASE_MISMATCH',
            `attempt '${opts.attemptId}' has no dispatch manifest — only legacy implement completions may proceed without one`,
            false,
            { supplied_phase: opts.phase },
          ),
          { json: opts.json },
        ),
      };
    }
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

  // 2b1a. FORGE-231 (impl R2 CRIT-1): bind the completion to the ATTEMPT's
  //       dispatched lease identity. In the documented steal crash window
  //       (successor lease published, best-effort state reset failed) the
  //       stale attempt is still current_attempt_id while the CANONICAL lease
  //       belongs to the successor — a completion must never borrow that
  //       authority. The manifest records the identity the attempt was
  //       dispatched under; the current lease must BE that identity.
  if (manifest !== null) {
    if (manifest.task_id !== opts.taskId) {
      return {
        exitCode: emit(
          fail(
            'STALE_ATTEMPT',
            `attempt manifest belongs to task '${manifest.task_id}', not '${opts.taskId}'`,
            false,
            { manifest_task_id: manifest.task_id },
          ),
          { json: opts.json },
        ),
      };
    }
    if (
      lease.claim_id !== manifest.claim_id ||
      lease.owner_run_id !== manifest.run_id ||
      lease.generation !== manifest.generation
    ) {
      return {
        exitCode: emit(
          fail(
            'LEASE_STOLEN',
            `the current lease (run=${lease.owner_run_id} gen=${lease.generation}) is not the identity attempt '${opts.attemptId}' was dispatched under (run=${manifest.run_id} gen=${manifest.generation}) — the lease changed hands; a stale attempt must never complete under a successor's authority`,
            false,
            {
              lease_run_id: lease.owner_run_id,
              lease_generation: lease.generation,
              manifest_run_id: manifest.run_id,
              manifest_generation: manifest.generation,
            },
          ),
          { json: opts.json },
        ),
      };
    }
  }

  // 2b1b. FORGE-231 (impl R1 MAJ-3): completion is a state-advancing commit —
  //       it requires an ACTIVE lease. Identity alone is not enough: a stale
  //       worker whose lease expired hours ago must not advance state or
  //       overwrite the ship-record write-ahead ahead of a successor.
  if (Date.parse(lease.expires_at) <= Date.now()) {
    return {
      exitCode: emit(
        fail(
          'LEASE_EXPIRED',
          `lease for task ${opts.taskId} expired at ${lease.expires_at} — the attempt is stale; a successor may own the task`,
          false,
          { expires_at: lease.expires_at },
        ),
        { json: opts.json },
      ),
    };
  }

  // 2b2. FORGE-231: one settings load feeds the verification block, the
  //      review gate (trusted review host) and the failure budget.
  let verify;
  let reviewHostCli: string | null;
  let retryAttempts: number;
  let mergePolicy: 'approval' | 'auto';
  try {
    const settings = loadSettings(path.join(opts.forgeDir, 'settings.yaml'));
    verify = settings.verify;
    reviewHostCli = settings.agents.review_host_cli;
    retryAttempts = settings.agents.retry_attempts;
    mergePolicy = settings.ship.merge_policy;
  } catch (err) {
    if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
      verify = undefined; // unconfigured → schema defaults
      reviewHostCli = 'codex';
      retryAttempts = 10;
      mergePolicy = 'approval';
    } else if (err instanceof SettingsError) {
      return { exitCode: emit(fail(err.code, err.message, false), { json: opts.json }) };
    } else {
      return {
        exitCode: emit(
          fail('IO_ERROR', err instanceof Error ? err.message : String(err), false),
          { json: opts.json },
        ),
      };
    }
  }

  // 2b3. FORGE-231 — THE PINNED-REVIEW GATE (--phase review only). The
  //      supplied --verdict-file is only the composed OUTCOME CARRIER; the
  //      RAW witness at attempts/<id>/review_verdict.json is the provenance +
  //      pin evidence. complete re-composes through the trusted gateway
  //      (host provenance, dual lineage, DERIVED criticality over the pinned
  //      SHAs) and requires the supplied artifact to EQUAL the recomputation.
  if (opts.phase === 'review') {
    if (reviewHostCli === null) {
      return {
        exitCode: emit(
          fail(
            'INVALID_STATE_FOR_PHASE',
            'review completions are unreachable in single-host mode (agents.review_host_cli is null); the single-host direct path verifies at implement.',
            false,
          ),
          { json: opts.json },
        ),
      };
    }
    // The schema refinement guarantees both SHAs on a review manifest.
    const reviewTargetSha = manifest?.review_target_sha;
    const reviewBaseSha = manifest?.review_base_sha;
    if (!manifest || !reviewTargetSha || !reviewBaseSha) {
      return {
        exitCode: emit(
          fail('SCHEMA_INVALID', 'review completion requires a manifest with pinned review SHAs', false),
          { json: opts.json },
        ),
      };
    }

    // FORGE-231 (impl R1 MAJ-4): prove the manifest's worktree is bound to
    // THIS task (marker + symlink-escape gates — the same F2 proof implement
    // verification uses) BEFORE trusting its HEAD or deriving criticality in it.
    const reviewBindingFailure = proveWorktreeBinding(manifest.worktree_path, opts.taskId);
    if (reviewBindingFailure) {
      return {
        exitCode: emit(
          fail(
            'VERIFICATION_FAILED',
            `cannot complete review: worktree at ${manifest.worktree_path} is not provably bound to task ${opts.taskId} (${reviewBindingFailure})`,
            false,
            { reason: reviewBindingFailure, path: manifest.worktree_path },
          ),
          { json: opts.json },
        ),
      };
    }

    // Live-head equality: the worktree must still BE the reviewed commit.
    let liveHead: string;
    try {
      liveHead = await resolveShaChecked(manifest.worktree_path, 'HEAD');
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            'VERIFICATION_FAILED',
            `cannot resolve the live worktree HEAD: ${err instanceof Error ? err.message : String(err)}`,
            false,
            { reason: 'head_unresolvable' },
          ),
          { json: opts.json },
        ),
      };
    }
    if (liveHead !== reviewTargetSha) {
      return {
        exitCode: emit(
          fail(
            'VERIFICATION_FAILED',
            `worktree HEAD ${liveHead} no longer matches the reviewed commit ${reviewTargetSha} (head drift)`,
            false,
            { reason: 'head_drift', live_head: liveHead, review_target_sha: reviewTargetSha },
          ),
          { json: opts.json },
        ),
      };
    }

    // Raw witness (REQUIRED) + optional raw second opinion.
    const attemptDirPath = attemptDir(opts.forgeDir, opts.taskId, opts.attemptId);
    const witnessPath = path.join(attemptDirPath, 'review_verdict.json');
    let witnessRaw: unknown;
    try {
      witnessRaw = JSON.parse(readFileSync(witnessPath, 'utf8'));
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            'REVIEW_WITNESS_MISSING',
            `the raw review witness at ${witnessPath} is required for a review completion: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
          { json: opts.json },
        ),
      };
    }
    let secondRaw: unknown | undefined;
    try {
      secondRaw = JSON.parse(readFileSync(path.join(attemptDirPath, 'second_opinion_verdict.json'), 'utf8'));
    } catch {
      secondRaw = undefined; // optional
    }

    let recomputed;
    try {
      recomputed = await composeTrustedReviewOutcome({
        primaryRaw: witnessRaw,
        secondOpinionRaw: secondRaw,
        expectedPrimaryHost: reviewHostCli as 'codex' | 'gemini' | 'claude',
        expectedTargetSha: reviewTargetSha,
        criticality: {
          derive: { gitDir: manifest.worktree_path, baseSha: reviewBaseSha, targetSha: reviewTargetSha },
          flag: false,
        },
        branch: verdict.data.branch,
        summary: verdict.data.summary,
        secondOpinionAvailable: secondRaw !== undefined,
      });
    } catch (err) {
      // Fail-closed derivation/composition failure.
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
    if (recomputed.kind === 'invalid') {
      return {
        exitCode: emit(
          fail('INVALID_VERDICT', `pinned-review gate rejected the raw witness: ${recomputed.reason}`, false, recomputed.detail),
          { json: opts.json },
        ),
      };
    }
    if (recomputed.kind !== 'verdict' || recomputed.result.kind !== 'verdict') {
      const reason = recomputed.result.kind === 'verdict' ? '' : recomputed.result.reason;
      return {
        exitCode: emit(
          fail(
            'REVIEW_NOT_COMPOSABLE',
            `the trusted gateway did not produce a machine verdict (${recomputed.kind}): ${reason} — a composed artifact cannot stand in for a human decision`,
            false,
            { gateway_kind: recomputed.kind },
          ),
          { json: opts.json },
        ),
      };
    }
    // The supplied composed artifact must EQUAL the recomputation on its
    // identity fields — outcome and pin. A substituted carrier (e.g. a
    // ready_for_review wrapper over a changes_requested witness) dies here.
    if (verdict.data.verdict !== recomputed.result.verdict.verdict) {
      return {
        exitCode: emit(
          fail(
            'INVALID_VERDICT',
            `supplied composed verdict '${verdict.data.verdict}' does not match the trusted recomposition '${recomputed.result.verdict.verdict}'`,
            false,
            { supplied: verdict.data.verdict, recomputed: recomputed.result.verdict.verdict },
          ),
          { json: opts.json },
        ),
      };
    }
    if (verdict.data.target_sha !== reviewTargetSha) {
      return {
        exitCode: emit(
          fail(
            'INVALID_VERDICT',
            `supplied composed verdict is pinned to '${verdict.data.target_sha ?? '<none>'}' but the manifest pins ${reviewTargetSha}`,
            false,
            { supplied: verdict.data.target_sha ?? null, expected: reviewTargetSha },
          ),
          { json: opts.json },
        ),
      };
    }
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
    // Settings were loaded once in 2b2; `verify` carries the hoisted value.
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
  // FORGE-231 (§C3 semantic replay): wx EEXIST is legal when the existing
  // artifact is SEMANTICALLY identical (verdict value + pin; timestamps and
  // captured output excluded) — a crash-replayed completion reuses the
  // existing canonical file instead of failing. Different content is a real
  // collision and still fails.
  const verdictIdentity = (v: unknown): string =>
    JSON.stringify({
      verdict: (v as { verdict?: unknown }).verdict ?? null,
      target_sha: (v as { target_sha?: unknown }).target_sha ?? null,
    });
  const writeIdempotent = (filePath: string, content: string): 'written' | 'replayed' | Error => {
    try {
      writeFileSync(filePath, content, { flag: 'wx' });
      return 'written';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return err as Error;
      try {
        const existing = JSON.parse(readFileSync(filePath, 'utf8'));
        if (verdictIdentity(existing) === verdictIdentity(JSON.parse(content))) return 'replayed';
      } catch {
        // unreadable existing file — fall through to the collision error
      }
      return new Error(`${filePath} already exists with DIFFERENT content (real collision)`);
    }
  };
  const verdictWrite = writeIdempotent(verdictPath, `${JSON.stringify(verdict.data, null, 2)}\n`);
  if (verdictWrite instanceof Error) {
    return {
      exitCode: emit(
        fail('IO_ERROR', `${verdictFile} write failed: ${verdictWrite.message}`, false),
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
  const verifiedWrite = writeIdempotent(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`);
  if (verifiedWrite instanceof Error) {
    // The verdict file was just created with `wx` (unless this is itself a
    // replay); roll back a FRESH orphan so the phase can be re-attempted.
    if (verdictWrite === 'written') {
      try {
        rmSync(verdictPath, { force: true });
      } catch {
        // best-effort cleanup; the original IO_ERROR is the authoritative failure.
      }
    }
    return {
      exitCode: emit(
        fail('IO_ERROR', `${verifiedFile} write failed: ${verifiedWrite.message}`, false),
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

  // 5. State transition (FORGE-231): table-driven, budget-accounted, replay-
  //    idempotent, with the ship-record write-ahead ordering (§C3).
  let nextState: TaskState | null = null;
  let failureReason: 'decision_key_budget' | 'retries_exhausted' | 'fatal' | undefined;
  let lastFailedAt: string | undefined;
  let budgetDelta = 0;
  let failureKey: string | null = null;
  const singleHost = reviewHostCli === null;

  let stateNow;
  try {
    stateNow = readTaskState(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          true,
          { hint: 'verdict written; state read failed — run forge orchestrate gc' },
        ),
        { json: opts.json },
      ),
    };
  }

  if (verdict.data.verdict === 'ready_for_review') {
    if (opts.phase === 'implement') {
      if (singleHost) {
        // Single-host DIRECT PATH (owner decision SH): the CLI-verified
        // implement head becomes the reviewed binding — no review hop, no
        // ready_for_review notification. Ship-record write-ahead runs BEFORE
        // the state CAS.
        const resolved = resolveWorktreePath(opts.forgeDir, opts.taskId, opts.attemptId);
        if (resolved.kind === 'invalid') {
          return {
            exitCode: emit(
              fail('VERIFICATION_FAILED', 'single-host direct path: dispatch manifest is missing or corrupt', false, {
                reason: 'manifest_invalid',
              }),
              { json: opts.json },
            ),
          };
        }
        let reviewedHeadSha: string;
        try {
          reviewedHeadSha = await resolveShaChecked(resolved.path, 'HEAD');
        } catch (err) {
          return {
            exitCode: emit(
              fail(
                'VERIFICATION_FAILED',
                `single-host direct path: cannot resolve the worktree HEAD: ${err instanceof Error ? err.message : String(err)}`,
                false,
                { reason: 'head_unresolvable' },
              ),
              { json: opts.json },
            ),
          };
        }
        try {
          upsertReviewedBinding(opts.forgeDir, opts.taskId, {
            reviewedHeadSha,
            reviewAttemptId: opts.attemptId,
            holder: callerFromLease(lease),
            fence: shipRecordFence(opts.forgeDir, opts.taskId, lease),
          });
        } catch (err) {
          return {
            exitCode: emit(
              fail(
                err instanceof OrchestratorError ? err.code : 'IO_ERROR',
                err instanceof Error ? err.message : String(err),
                true,
                { hint: 'verdict written; ship-record write-ahead failed — retry complete' },
              ),
              { json: opts.json },
            ),
          };
        }
        nextState = applyTransition(stateNow.state, 'implement_verified_single_host');
      } else {
        nextState = applyTransition(stateNow.state, 'complete_ready_for_review');
      }
    } else if (opts.phase === 'review') {
      // Ship-record write-ahead: mint the reviewed binding from the PINNED
      // manifest SHA (already proven equal to the live HEAD in 2b3), THEN the
      // state CAS. Crash between the two replays idempotently.
      try {
        upsertReviewedBinding(opts.forgeDir, opts.taskId, {
          // The 2b3 gate guarantees manifest + review_target_sha for review.
          reviewedHeadSha: manifest!.review_target_sha!,
          reviewAttemptId: opts.attemptId,
          holder: callerFromLease(lease),
          fence: shipRecordFence(opts.forgeDir, opts.taskId, lease),
        });
      } catch (err) {
        return {
          exitCode: emit(
            fail(
              err instanceof OrchestratorError ? err.code : 'IO_ERROR',
              err instanceof Error ? err.message : String(err),
              true,
              { hint: 'verdict written; ship-record write-ahead failed — retry complete' },
            ),
            { json: opts.json },
          ),
        };
      }
      nextState = applyTransition(stateNow.state, 'review_passed');
    } else {
      // ship: merge_pending is legal ONLY behind a COMPLETE ship record —
      // reviewed binding + base + pr (the write-ahead proves the external
      // side effects were recorded before the state advertises them).
      let record;
      try {
        record = readShipRecord(opts.forgeDir, opts.taskId);
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
      if (record === null || record.base === null || record.pr === null) {
        return {
          exitCode: emit(
            fail(
              'SHIP_RECORD_INCOMPLETE',
              `cannot enter merge_pending for task ${opts.taskId}: the ship record must carry the reviewed binding, base, and pr before completion (write-ahead ordering)`,
              false,
              {
                record_present: record !== null,
                base_present: record?.base !== null && record !== null,
                pr_present: record?.pr !== null && record !== null,
              },
            ),
            { json: opts.json },
          ),
        };
      }
      nextState = applyTransition(stateNow.state, 'ship_op_completed');
    }
  } else {
    // changes_needed | blocked. `blocked` from running keeps its question
    // semantics (no budget); every other failure consumes the SINGLE total
    // budget with last_failure_key replay idempotency.
    lastFailedAt = new Date().toISOString();
    const isQuestionBlock = verdict.data.verdict === 'blocked' && stateNow.state === 'running' && opts.phase === 'implement';
    if (isQuestionBlock) {
      nextState = applyTransition(stateNow.state, 'blocked');
    } else {
      failureKey = `${opts.attemptId}:${opts.phase}`;
      // REPLAY SHORT-CIRCUIT (runs BEFORE any transition application): the
      // same failure was already accounted and the state already reflects it.
      const reflectsFailure =
        stateNow.state === 'failed' ||
        (opts.phase === 'ship' ? stateNow.state === 'reviewed' : stateNow.state === 'awaiting_respawn' || stateNow.state === 'blocked_on_question');
      if (stateNow.last_failure_key === failureKey && reflectsFailure) {
        // impl R2 MAJ-4: the fatal notification keeps DURABLE semantics — a
        // replay of a terminal exhaustion RE-ATTEMPTS the append (its id is a
        // deterministic natural key, so readers dedup; a crash between the
        // state CAS and the original append is repaired here).
        if (stateNow.state === 'failed' && stateNow.failure_reason === 'retries_exhausted') {
          try {
            appendNotificationEvent(opts.forgeDir, lease.owner_run_id, {
              type: 'fatal',
              ts: new Date().toISOString(),
              run_id: lease.owner_run_id,
              reason: `task ${opts.taskId} failed: retry budget exhausted (${stateNow.failure_count}/${retryAttempts})`,
              details: { task_id: opts.taskId, failure_count: stateNow.failure_count, failure_key: failureKey },
            });
          } catch (fatalErr) {
            process.stderr.write(
              `warn: complete — replay could not repair the fatal notification: ${fatalErr instanceof Error ? fatalErr.message : String(fatalErr)}\n`,
            );
          }
        }
        return {
          exitCode: emit(
            ok({
              verdict: verdict.data.verdict,
              next_state: stateNow.state,
              verdict_path: verdictPath,
              replayed: true,
            }),
            { json: opts.json },
          ),
        };
      }
      const failTrigger =
        opts.phase === 'ship' ? 'ship_failed' : verdict.data.verdict === 'blocked' ? 'changes_needed' : 'changes_needed';
      let failState: TaskState;
      try {
        failState = applyTransition(stateNow.state, failTrigger);
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
      budgetDelta = 1;
      const newCount = stateNow.failure_count + 1;
      if (newCount >= retryAttempts) {
        // Exhaustion is CHAINED by complete and committed in the SAME CAS —
        // no dangling dispatchable state past the budget.
        nextState = applyTransition(failState, 'retries_exhausted');
        failureReason = 'retries_exhausted';
      } else {
        nextState = failState;
      }
    }
  }

  if (nextState) {
    try {
      writeTaskState(
        opts.forgeDir,
        {
          ...stateNow,
          state: nextState,
          state_version: stateNow.state_version + 1,
          failure_count: stateNow.failure_count + budgetDelta,
          ...(failureKey !== null ? { last_failure_key: failureKey } : {}),
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
        { requireActiveLease: true },
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

    // FORGE-231 (owner decision NL): the ready_for_review PROGRESS event is
    // ADVISORY — emitted strictly AFTER the state CAS, best-effort (a crash in
    // this window loses it; review-queue's state-derived listing is the
    // authoritative discovery). Dual-host implement-pass only: the single-host
    // direct path goes straight to reviewed with no review hop to announce.
    if (nextState === 'ready_for_review' && opts.phase === 'implement' && !singleHost) {
      try {
        appendNotificationEvent(opts.forgeDir, lease.owner_run_id, {
          type: 'ready_for_review',
          ts: new Date().toISOString(),
          run_id: lease.owner_run_id,
          task_id: opts.taskId,
          state_version: stateNow.state_version + 1,
        });
      } catch {
        // advisory — never fail the completion over a lost announcement
      }
    }

    // FORGE-231 (impl R1 MAJ-5/MAJ-6): on entering merge_pending —
    //   1. emit the ADVISORY merge_pending event (after the state CAS);
    //   2. RELEASE the worker lease (state-before-release per §D5: the worker
    //      is done; no heartbeat source exists while the platform merges).
    //      Best-effort with a loud hint — gc row 15 is the recovery.
    if (nextState === 'merge_pending') {
      try {
        const recordNow = readShipRecord(opts.forgeDir, opts.taskId);
        if (recordNow?.pr) {
          appendNotificationEvent(opts.forgeDir, lease.owner_run_id, {
            type: 'merge_pending',
            ts: new Date().toISOString(),
            run_id: lease.owner_run_id,
            task_id: opts.taskId,
            state_version: stateNow.state_version + 1,
            pr_url: recordNow.pr.url,
            auto_merge: mergePolicy === 'auto',
          });
        }
      } catch {
        // advisory
      }
      try {
        releaseLease({
          forgeDir: opts.forgeDir,
          taskId: opts.taskId,
          caller: callerFromLease(lease),
        });
      } catch (releaseErr) {
        process.stderr.write(
          `warn: complete — merge_pending entered but the worker lease release failed (${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}); forge orchestrate gc row 15 will reconcile\n`,
        );
      }
    }

    // FORGE-231 (impl R1 MAJ-6): terminal failure via retries_exhausted keeps
    // the DURABLE fatal-notification obligation — surface loudly on append
    // failure instead of swallowing.
    if (nextState === 'failed' && failureReason === 'retries_exhausted') {
      try {
        appendNotificationEvent(opts.forgeDir, lease.owner_run_id, {
          type: 'fatal',
          ts: new Date().toISOString(),
          run_id: lease.owner_run_id,
          reason: `task ${opts.taskId} failed: retry budget exhausted (${stateNow.failure_count + budgetDelta}/${retryAttempts})`,
          details: {
            task_id: opts.taskId,
            failure_count: stateNow.failure_count + budgetDelta,
            // natural key → deterministic event id → replay-safe re-emission
            failure_key: failureKey ?? `${opts.attemptId}:${opts.phase}`,
          },
        });
      } catch (fatalErr) {
        process.stderr.write(
          `warn: complete — task ${opts.taskId} marked failed but the fatal notification append failed: ${fatalErr instanceof Error ? fatalErr.message : String(fatalErr)}\n`,
        );
      }
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

// FORGE-231 (impl R1 MAJ-3): the ship-record write-ahead fence — re-read the
// lease UNDER the record's CAS marker and require the caller's exact identity
// AND an unexpired lease. A stale completion that lost its lease to a steal
// between reading state and committing the record dies here instead of
// leaving a stale write-ahead for the successor.
function shipRecordFence(forgeDir: string, taskId: string, lease: Lease): () => void {
  return () => {
    let current: Lease;
    try {
      current = readLease(forgeDir, taskId);
    } catch (err) {
      throw new CasError('lease_lost', `lease unreadable during ship-record write for ${taskId}`, {}, { cause: err });
    }
    if (
      current.claim_id !== lease.claim_id ||
      current.generation !== lease.generation ||
      current.owner_run_id !== lease.owner_run_id ||
      Date.parse(current.expires_at) <= Date.now()
    ) {
      throw new CasError('lease_lost', `lease for ${taskId} changed hands or expired during ship-record write`);
    }
  };
}
