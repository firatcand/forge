// FORGE-234: the SHIP operation core (spec/ORCHESTRATOR.md:877 steps 1-7;
// plan v1-v3 + R3 deltas in .forge/loop-notes/). VERB-ONLY by owner decision —
// every step is deterministic git/gh/CLI work; no model worker exists for the
// ship phase (billing invariant by construction).
//
// The operation ends at merge_pending via the runOrchestrateComplete choke
// point (single owner of the state CAS, lease release, and notification).
// The merge itself — mergeAtomic on merge_pending ticks — is FORGE-235.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { OrchestratorError } from '../core/errors.ts';
import type { Settings } from '../schemas/settings.ts';
import { AttemptManifestSchema, type AttemptManifest } from '../schemas/attempt.ts';
import { ShipReceiptSchema, type ShipReceipt } from '../schemas/ship-receipt.ts';
import type { Lease } from '../schemas/lease.ts';
import type { PullRequestRef } from '../schemas/ship-record.ts';
import type { RepoHost } from '../repo-hosts/base.ts';
import { RepoHostError } from '../repo-hosts/errors.ts';
import { evaluateProbeBar, type Exec, type ExecResult } from '../repo-hosts/github.ts';
import { backoffMs, DEFAULT_RETRY_POLICY } from './retry.ts';
import { readShipRecord, upsertPullRequestBinding } from './ship-record.ts';
import type { ShipRecord } from '../schemas/ship-record.ts';
import { readTaskState } from './state-machine.ts';
import { readMarkerTaskId, readFrozenBaseBranch } from './worktree-base.ts';
import { manifestFilePath, attemptDir } from './questions/paths.ts';
import { runVerify, type RunCommand, type VerifyResult } from './verify-runner.ts';

// ─── Outcome model ───────────────────────────────────────────────────────────

export type ShipOpOutcome =
  | { kind: 'success'; receiptPath: string; verdictInputPath: string; targetSha: string; pr: PullRequestRef }
  | { kind: 'failure'; reason: ShipFailureReason; detail: string; verdictInputPath: string; targetSha: string }
  | { kind: 'drift'; detail: string; targetSha: string }
  | { kind: 'park'; reason: ShipParkReason; detail: string; fingerprint: string }
  | { kind: 'refused'; code: string; detail: string };

export type ShipFailureReason =
  | 'verify_failed'
  | 'secrets_scan_failed'
  | 'push_failed'
  | 'tracker_failed'
  | 'pr_binding_failed';

export type ShipParkReason =
  | 'unsupported_host'
  | 'fork_topology'
  | 'pr_conflict'
  | 'probe_bar_failed'
  | 'probe_unavailable';

export interface TrackerPort {
  /** Marks the tracker issue in_review; retriable errors surface as { retriable: true }. */
  updateState: (state: 'in_review') => Promise<{ ok: true } | { ok: false; retriable: boolean; detail: string }>;
}

export interface ShipOpDeps {
  git: Exec;
  runCommand?: RunCommand;
  /** RepoHost for the task (resolveBase/probe/createOrGetPullRequest/headSha). Null = unsupported host. */
  repoHost: RepoHost | null;
  tracker: TrackerPort;
  /** gitleaks runner; undefined = binary missing (fail closed). */
  gitleaks?: (opts: { cwd: string; baseSha: string; headSha: string }) => Promise<{ clean: boolean; detail: string }>;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ShipOpArgs {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  settings: Settings;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Admission + fence ───────────────────────────────────────────────────────

interface Admitted {
  manifest: AttemptManifest;
  lease: Lease;
  record: ShipRecord;
  worktreePath: string;
  targetSha: string;
  admittedStateVersion: number;
}

function refuse(code: string, detail: string): never {
  throw new OrchestratorError(code as never, detail, {});
}

function readManifest(forgeDir: string, taskId: string, attemptId: string): AttemptManifest {
  let raw: string;
  const p = manifestFilePath(forgeDir, taskId, attemptId);
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    refuse('STALE_ATTEMPT', `no manifest for attempt ${attemptId} — re-dispatch required`);
  }
  const parsed = AttemptManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) refuse('SCHEMA_INVALID', `manifest for attempt ${attemptId} failed schema validation`);
  return parsed.data;
}

export interface ShipFenceContext {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  admittedStateVersion: number;
  manifest: AttemptManifest;
  readLease: () => Lease;
}

// Plan v2 Δ2 + v3 Δ14: revalidated IMMEDIATELY BEFORE every external mutation
// and before accepting its result. The state-version pin is what invalidates
// an in-flight invocation across a park/answer round-trip that preserves
// every other identity record.
export function shipFence(ctx: ShipFenceContext): void {
  const state = readTaskState(ctx.forgeDir, ctx.taskId);
  if (state.state !== 'reviewed') {
    refuse('STALE_ATTEMPT', `task ${ctx.taskId} is '${state.state}', not reviewed — ship invocation superseded`);
  }
  if (state.current_attempt_id !== ctx.attemptId) {
    refuse('STALE_ATTEMPT', `attempt ${ctx.attemptId} superseded by ${state.current_attempt_id ?? 'none'}`);
  }
  if (state.state_version !== ctx.admittedStateVersion) {
    refuse(
      'STALE_ATTEMPT',
      `state version moved ${ctx.admittedStateVersion} → ${state.state_version} since ship admission — invocation invalidated`,
    );
  }
  const lease = ctx.readLease();
  if (
    lease.claim_id !== ctx.manifest.claim_id ||
    lease.owner_run_id !== ctx.manifest.run_id ||
    lease.generation !== ctx.manifest.generation
  ) {
    refuse('LEASE_STOLEN', `lease identity changed since ship dispatch for ${ctx.taskId}`);
  }
  if (Date.parse(lease.expires_at) <= Date.now()) {
    refuse('LEASE_EXPIRED', `lease expired during ship operation for ${ctx.taskId}`);
  }
  const record = readShipRecord(ctx.forgeDir, ctx.taskId);
  if (record === null || record.task_id !== ctx.taskId) {
    refuse('STATE_NOT_FOUND', `ship record missing or misbound for ${ctx.taskId}`);
  }
  if (record.reviewed_head_sha !== ctx.manifest.ship_target_sha) {
    refuse('STALE_ATTEMPT', `ship record reviewed binding moved off the manifest pin for ${ctx.taskId}`);
  }
}

export function admitShip(args: ShipOpArgs, readLease: () => Lease): Admitted {
  const state = readTaskState(args.forgeDir, args.taskId);
  if (state.state !== 'reviewed') {
    refuse('INVALID_STATE', `cannot ship task ${args.taskId}: state is '${state.state}' (need reviewed)`);
  }
  if (state.current_attempt_id !== args.attemptId) {
    refuse('STALE_ATTEMPT', `attempt ${args.attemptId} is not the current attempt for ${args.taskId}`);
  }
  const manifest = readManifest(args.forgeDir, args.taskId, args.attemptId);
  if (manifest.task_id !== args.taskId || manifest.attempt_id !== args.attemptId || manifest.phase !== 'ship') {
    refuse('STALE_ATTEMPT', `manifest identity mismatch for ship attempt ${args.attemptId}`);
  }
  if (manifest.ship_target_sha === undefined) {
    // Legacy pre-234 ship manifest — typed no-mutation refusal (plan v3 Δ15).
    refuse('STALE_ATTEMPT', `ship manifest for ${args.attemptId} predates the target pin — re-dispatch required`);
  }
  const lease = readLease();
  if (
    lease.claim_id !== manifest.claim_id ||
    lease.owner_run_id !== manifest.run_id ||
    lease.generation !== manifest.generation
  ) {
    refuse('LEASE_STOLEN', `lease identity does not match the ship manifest for ${args.taskId}`);
  }
  if (Date.parse(lease.expires_at) <= Date.now()) {
    refuse('LEASE_EXPIRED', `lease expired before ship admission for ${args.taskId}`);
  }
  const worktreePath = manifest.worktree_path;
  const markerTask = readMarkerTaskId(worktreePath);
  if (markerTask !== args.taskId) {
    refuse('VERIFICATION_FAILED', `worktree at ${worktreePath} is bound to '${markerTask ?? '(no marker)'}', not ${args.taskId}`);
  }
  if (readFrozenBaseBranch(worktreePath) === null) {
    refuse('VERIFICATION_FAILED', `worktree at ${worktreePath} has no frozen base branch`);
  }
  const record = readShipRecord(args.forgeDir, args.taskId);
  if (record === null || record.task_id !== args.taskId) {
    refuse('STATE_NOT_FOUND', `ship record missing or misbound for ${args.taskId}`);
  }
  if (record.reviewed_head_sha !== manifest.ship_target_sha) {
    refuse('STALE_ATTEMPT', `ship record reviewed binding does not match the manifest pin for ${args.taskId}`);
  }
  return {
    manifest,
    lease,
    record,
    worktreePath,
    targetSha: manifest.ship_target_sha,
    admittedStateVersion: state.state_version,
  };
}

// ─── The operation ───────────────────────────────────────────────────────────

// impl-R1 CRIT #3: EVERY retry attempt is individually fenced — a lease lost
// during backoff must refuse BEFORE the next remote mutation, not after.
async function withTransientRetry<T>(
  fn: () => Promise<{ ok: true; value: T } | { ok: false; retriable: boolean; detail: string }>,
  sleep: (ms: number) => Promise<void>,
  fence: () => void,
): Promise<{ ok: true; value: T } | { ok: false; detail: string }> {
  let lastDetail = 'no attempts';
  const maxAttempts = DEFAULT_RETRY_POLICY.retry_attempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    fence();
    const res = await fn();
    fence();
    if (res.ok) return res;
    lastDetail = res.detail;
    if (!res.retriable) return { ok: false, detail: res.detail };
    if (attempt < maxAttempts) await sleep(backoffMs(attempt, DEFAULT_RETRY_POLICY));
  }
  return { ok: false, detail: `retries exhausted: ${lastDetail}` };
}

function transientGit(res: ExecResult): boolean {
  return /(could not read|connection|timed? ?out|ECONN|EAI_|ENOTFOUND|early EOF|RPC failed|The remote end hung up|503|502)/i.test(
    res.stderr,
  );
}

export function incidentFingerprint(
  reason: ShipParkReason,
  record: ShipRecord,
  mergePolicy: string,
  probeDetail: string,
): string {
  const base = record.base ? `${record.base.repo}@${record.base.branch}` : 'unresolved';
  // Deterministic, human-readable, bounded — identifies the CURRENT incident.
  return `${reason}|${base}|${mergePolicy}|${probeDetail}`.slice(0, 200);
}

export async function runShipOperation(args: ShipOpArgs, deps: ShipOpDeps, readLease: () => Lease): Promise<ShipOpOutcome> {
  const sleep = deps.sleepMs ?? sleepDefault;
  const now = deps.now ?? (() => new Date());

  let adm: Admitted;
  try {
    adm = admitShip(args, readLease);
  } catch (err) {
    if (err instanceof OrchestratorError) return { kind: 'refused', code: err.code, detail: err.message };
    throw err;
  }
  const fenceCtx: ShipFenceContext = {
    forgeDir: args.forgeDir,
    taskId: args.taskId,
    attemptId: args.attemptId,
    admittedStateVersion: adm.admittedStateVersion,
    manifest: adm.manifest,
    readLease,
  };
  const fence = (): void => shipFence(fenceCtx);
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    fence();
    const out = await fn();
    fence();
    return out;
  };
  const mergePolicy = args.settings.ship.merge_policy;

  try {
    // 1. Base resolution (persisted-first; fenced write-ahead inside).
    if (deps.repoHost === null) {
      return {
        kind: 'park',
        reason: 'unsupported_host',
        detail: 'no RepoHost for this repository — orchestrator SHIP is unavailable',
        fingerprint: incidentFingerprint('unsupported_host', adm.record, mergePolicy, 'no-repo-host'),
      };
    }
    const host = deps.repoHost;
    try {
      await guarded(() => host.resolveBase());
    } catch (err) {
      if (err instanceof RepoHostError && (err.code === 'fork_topology' || err.code === 'unsupported_host')) {
        return {
          kind: 'park',
          reason: err.code,
          detail: err.message,
          fingerprint: incidentFingerprint(err.code, adm.record, mergePolicy, err.code),
        };
      }
      throw err;
    }
    const record1 = readShipRecord(args.forgeDir, args.taskId);
    if (record1 === null || record1.base === null) {
      return { kind: 'refused', code: 'STATE_NOT_FOUND', detail: 'base resolution did not persist' };
    }

    // 2. Honesty probe — auto policy only (approval has no bar).
    let probeDisposition: ShipReceipt['probe'] = 'skipped_approval';
    if (mergePolicy === 'auto') {
      const report = await guarded(() => host.probe());
      if (!report.ok) {
        return {
          kind: 'park',
          reason: 'probe_unavailable',
          detail: `honesty probe failed (${report.reason}): ${report.detail}`,
          fingerprint: incidentFingerprint('probe_unavailable', record1, mergePolicy, report.reason),
        };
      }
      const bar = evaluateProbeBar(report);
      if (bar !== null) {
        return {
          kind: 'park',
          reason: 'probe_bar_failed',
          detail: bar,
          fingerprint: incidentFingerprint('probe_bar_failed', record1, mergePolicy, bar),
        };
      }
      probeDisposition = 'passed';
    }

    // 3. Verify gate (can run for minutes — fences bracket the mutations, not this).
    const verify: VerifyResult = await runVerify(args.settings.verify, {
      cwd: adm.worktreePath,
      run: deps.runCommand,
    });
    if (args.settings.verify && !verify.passed) {
      return {
        kind: 'failure',
        reason: 'verify_failed',
        detail: `settings.verify failed in the ship worktree`,
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'verify_failed'),
        targetSha: adm.targetSha,
      };
    }

    // 4. Final-SHA binding: worktree HEAD must equal the pin.
    const head = await deps.git(['-C', adm.worktreePath, 'rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return { kind: 'refused', code: 'IO_ERROR', detail: `cannot resolve worktree HEAD: ${head.stderr.slice(0, 300)}` };
    }
    const headSha = head.stdout.trim().toLowerCase();
    if (headSha !== adm.targetSha) {
      return { kind: 'drift', detail: `worktree HEAD ${headSha} != reviewed ${adm.targetSha}`, targetSha: adm.targetSha };
    }

    // 5. Secrets scan — fail closed on missing scanner, execution error,
    //    findings, OR an unresolvable scan base (impl-R1 CRIT #2: an empty
    //    target..target range silently skips the branch's commits).
    let scanBase: string | null = null;
    for (const baseRef of [
      `refs/remotes/${record1.base.push_remote}/${record1.base.branch}`,
      `refs/remotes/origin/${record1.base.branch}`,
      record1.base.branch,
    ]) {
      const mb = await deps.git(['-C', adm.worktreePath, 'merge-base', 'HEAD', baseRef]);
      if (mb.exitCode === 0 && mb.stdout.trim().length > 0) {
        scanBase = mb.stdout.trim();
        break;
      }
    }
    if (scanBase === null) {
      return {
        kind: 'failure',
        reason: 'secrets_scan_failed',
        detail: 'cannot resolve the scan base (merge-base with the recorded base branch failed) — fail closed',
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'secrets_scan_base_unresolvable'),
        targetSha: adm.targetSha,
      };
    }
    if (deps.gitleaks === undefined) {
      return {
        kind: 'failure',
        reason: 'secrets_scan_failed',
        detail: 'gitleaks is not available — the final secrets gate cannot run (fail closed)',
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'secrets_scan_unavailable'),
        targetSha: adm.targetSha,
      };
    }
    let scan;
    try {
      scan = await deps.gitleaks({ cwd: adm.worktreePath, baseSha: scanBase, headSha: adm.targetSha });
    } catch (err) {
      scan = { clean: false, detail: `scanner error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!scan.clean) {
      return {
        kind: 'failure',
        reason: 'secrets_scan_failed',
        detail: scan.detail.slice(0, 500),
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'secrets_scan_failed'),
        targetSha: adm.targetSha,
      };
    }

    // 6. SHA-bound push (plan v2 Δ1): push the immutable object, never the ref.
    const branch = await deps.git(['-C', adm.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = branch.stdout.trim();
    if (branch.exitCode !== 0 || headBranch.length === 0 || headBranch === 'HEAD') {
      return { kind: 'refused', code: 'VERIFICATION_FAILED', detail: 'worktree is not on a named branch' };
    }
    const pushBase = record1.base;
    const pushRes = await guarded(() =>
      withTransientRetry(async () => {
        const res = await deps.git([
          '-C', adm.worktreePath,
          'push', pushBase.push_remote,
          `${adm.targetSha}:refs/heads/${headBranch}`,
        ]);
        if (res.exitCode === 0) return { ok: true as const, value: res };
        return { ok: false as const, retriable: transientGit(res), detail: res.stderr.slice(0, 400) };
      }, sleep, fence),
    );
    if (!pushRes.ok) {
      return {
        kind: 'failure',
        reason: 'push_failed',
        detail: pushRes.detail,
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'push_failed'),
        targetSha: adm.targetSha,
      };
    }

    // 7. PR create-or-get (idempotent, marker-led) + live head equality.
    let pr: PullRequestRef;
    try {
      pr = await guarded(() => host.createOrGetPullRequest(headBranch, record1.base!.branch));
    } catch (err) {
      if (err instanceof RepoHostError && err.code === 'pr_conflict') {
        return {
          kind: 'park',
          reason: 'pr_conflict',
          detail: err.message,
          fingerprint: incidentFingerprint('pr_conflict', record1, mergePolicy, err.message.slice(0, 80)),
        };
      }
      throw err;
    }
    const liveHead = await guarded(() => host.headSha(pr));
    if (!liveHead.ok || liveHead.sha !== adm.targetSha) {
      return {
        kind: 'drift',
        detail: liveHead.ok
          ? `PR head ${liveHead.sha} != reviewed ${adm.targetSha}`
          : `PR head unreadable (${liveHead.reason})`,
        targetSha: adm.targetSha,
      };
    }

    // 8. Persist the PR identity (fenced; replay-safe).
    try {
      upsertPullRequestBinding(args.forgeDir, args.taskId, {
        pr,
        expectedReviewAttemptId: adm.record.review_attempt_id,
        expectedReviewedHeadSha: adm.targetSha,
        holder: { run_id: adm.lease.owner_run_id, claim_id: adm.lease.claim_id, generation: adm.lease.generation },
        fence,
      });
    } catch (err) {
      return {
        kind: 'failure',
        reason: 'pr_binding_failed',
        detail: err instanceof Error ? err.message : String(err),
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'pr_binding_failed'),
        targetSha: adm.targetSha,
      };
    }

    // 9. Tracker in_review (retriable-only retry; exhaustion = budgeted failure).
    const trackerRes = await guarded(() =>
      withTransientRetry(async () => {
        const res = await deps.tracker.updateState('in_review');
        if (res.ok) return { ok: true as const, value: true };
        return { ok: false as const, retriable: res.retriable, detail: res.detail };
      }, sleep, fence),
    );
    if (!trackerRes.ok) {
      return {
        kind: 'failure',
        reason: 'tracker_failed',
        detail: trackerRes.detail,
        verdictInputPath: writeVerdictInput(args, adm, 'changes_needed', 'tracker_failed'),
        targetSha: adm.targetSha,
      };
    }

    // 10. The fenced receipt — proof for complete that THE VERB RAN (Δ10+ΔR2).
    fence();
    const receipt: ShipReceipt = {
      version: 1,
      task_id: args.taskId,
      attempt_id: args.attemptId,
      target_sha: adm.targetSha,
      admitted_state_version: adm.admittedStateVersion,
      probe: probeDisposition,
      pushed: true,
      pr,
      tracker_updated: true,
      created_at: now().toISOString(),
    };
    const receiptPath = shipReceiptPath(args.forgeDir, args.taskId, args.attemptId);
    mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify(ShipReceiptSchema.parse(receipt), null, 2)}\n`, 'utf8');
    fence();

    return {
      kind: 'success',
      receiptPath,
      verdictInputPath: writeVerdictInput(args, adm, 'ready_for_review', 'shipped'),
      targetSha: adm.targetSha,
      pr,
    };
  } catch (err) {
    if (err instanceof OrchestratorError) return { kind: 'refused', code: err.code, detail: err.message };
    if (err instanceof RepoHostError) {
      return { kind: 'refused', code: 'IO_ERROR', detail: `${err.code}: ${err.message}` };
    }
    throw err;
  }
}

export function shipReceiptPath(forgeDir: string, taskId: string, attemptId: string): string {
  return path.join(attemptDir(forgeDir, taskId, attemptId), 'ship_receipt.json');
}

// Replay-safe INPUT artifact (plan v2 Δ5): complete owns the canonical
// verdict.ship.json; this is the pinned carrier the verb feeds it. Both
// success and failure carriers name the target SHA (R3 ΔR1).
function writeVerdictInput(
  args: ShipOpArgs,
  adm: Admitted,
  verdict: 'ready_for_review' | 'changes_needed',
  summary: string,
): string {
  const p = path.join(attemptDir(args.forgeDir, args.taskId, args.attemptId), 'ship_op_verdict.input.json');
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(
    p,
    `${JSON.stringify(
      {
        version: 1,
        verdict,
        summary: `ship operation: ${summary}`,
        tests: { ran: false, passed: 0, failed: 0, skipped: 0, duration_ms: 0, output_excerpt: '' },
        lint: { ran: false, clean: true, violations: 0, output_excerpt: '' },
        branch: `task:${args.taskId}`,
        save_point: '',
        target_sha: adm.targetSha,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return p;
}
