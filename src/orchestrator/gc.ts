// Pure gc planner — implements the 14-row divergence table from
// spec/ORCHESTRATOR.md §"gc reconciliation rules". No I/O. Consumed by:
//   - src/cli/orchestrate/gc.ts (explicit gc verb; runs the executor against
//     the full plan)
//   - src/cli/orchestrate/phases.ts and status.ts (auto-gc detect-and-warn;
//     filters to cheapRows and emits warnings to stderr, no mutation)
//
// The planner is the lake-boiling part: it considers every snapshotted
// divergence and emits a deterministic, executable plan. The executor lives
// outside this file because it is I/O-heavy (writeTaskState, lease ops,
// branch prune, attempt archival). Per FORGE-22 Q2 + Codex 2nd-pass #7, this
// split keeps the planner unit-testable in isolation and the executor's
// switch(action) over a discriminated union exhaustive.

import { STEAL_GRACE_MS_DEFAULT } from '../schemas/lease.ts';
import type { Lease } from '../schemas/lease.ts';
import {
  TERMINAL_TASK_STATES,
  type TaskState,
  type TaskStateRecord,
  type TerminalTaskState,
} from '../schemas/task-state.ts';
import type { Issue } from '../trackers/types.ts';
import type { Phases } from '../schemas/phases.ts';

// ---- GcPlanRow discriminated union (FORGE-22 plan §"GcPlanRow schema") ----

export type GcRowId =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 15
  | 16
  | 14;

export interface LeaseIdentity {
  readonly claimId: string;
  readonly generation: number;
  readonly ownerRunId: string;
}

interface GcPlanRowBase {
  readonly rowId: GcRowId;
  readonly taskId: string;
  readonly severity: 'info' | 'warn' | 'error';
}

export type GcPlanRow =
  | (GcPlanRowBase & {
      readonly action: 'mark_terminal';
      readonly payload: {
        readonly targetState: TerminalTaskState;
        readonly leaseIdentity: LeaseIdentity;
        readonly trackerState?: string;
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'mark_abandoned';
      readonly payload: {
        readonly leaseIdentity: LeaseIdentity;
        readonly expiredAt: string;
        readonly expiredAgeMs: number;
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'mark_unclaimed';
      readonly payload: {
        readonly leaseIdentity: LeaseIdentity;
        readonly reason: 'tracker-not-claimed' | 'tracker-not-found';
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'archive_question';
      readonly payload: {
        readonly questionPath: string;
        readonly attemptId: string;
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'reverify_verdict';
      readonly payload: {
        readonly attemptId: string;
        readonly verdictPath: string;
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'release_lease_admin';
      readonly payload: {
        readonly expectedClaimId: string;
        readonly expectedGeneration: number;
        readonly expectedOwnerRunId: string;
        // Lease expires_at at SNAPSHOT TIME — caller passes this so the
        // executor can detect a heartbeat-renewal that preserved the 3
        // identity fields but advanced expires_at. (Codex 3rd-pass BLOCK 1.)
        readonly expectedExpiresAt: string;
        readonly expectedPath: string;
        readonly requireTerminalState: boolean;
        readonly reason: 'gc:row-13:duplicate' | 'gc:row-14:terminal-state' | 'gc:row-15:merge-pending-lease';
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'prune_branch';
      readonly payload: {
        readonly branchRef: string;
        readonly reason: 'shipped' | 'orphan-prompted';
      };
    })
  | (GcPlanRowBase & {
      readonly action: 'report_orphan';
      readonly payload: {
        readonly kind:
          | 'worktree'
          | 'tracker_claimed_no_local'
          | 'answer_no_question'
          | 'shipped_not_closed'
          // FORGE-231: tracker-done divergence (row 6 — never auto-shipped)
          // and stuck CAS transition markers (report + manual remediation).
          | 'tracker_done_not_shipped'
          // FORGE-233: row-1 report-only replacement for tracker done/closed
          | 'tracker_claims_shipped'
          | 'stuck_cas_marker';
        readonly description: string;
      };
    });

export type GcPlanAction = GcPlanRow['action'];

export interface GcPlan {
  readonly rows: readonly GcPlanRow[];
  readonly cheapRows: ReadonlySet<GcRowId>;
}

// Rows that run in auto-gc (detect-and-warn from phases --ready and status).
// All cheap rows are local-only: no tracker fetch, no git scan, no directory
// walk of worktrees/. Per FORGE-22 plan + Codex 2nd-pass #5.
//
// Row 2 is "partial": only the lease-expiry sub-case is cheap (purely local
// lease.json read). The full row-2 (compare tracker claim) needs the tracker
// fetch and runs only in expensive gc.
export const CHEAP_ROW_IDS: ReadonlySet<GcRowId> = new Set([2, 5, 8, 11, 12, 13, 14] as const);

// ---- Snapshot shape (built by executor; consumed by planner) ----

export interface TaskSnapshot {
  readonly state: TaskStateRecord | null;
  // Usually 0 or 1 lease. >1 triggers row 13.
  readonly leases: readonly LeaseAtPath[];
  // attempts known via directory scan; populated only if row 5/8/11/12 may fire.
  readonly attempts: readonly AttemptSnapshot[];
  // FORGE-231: incomplete CAS transition markers found next to this task's
  // guarded files (state.json / lease.json / ship-record.json). Collected by
  // the CLI snapshot builder; row 16 reports them (never removes).
  readonly stuckCasMarkers?: readonly {
    readonly guardedFile: string;
    readonly markerPath: string;
    readonly domain: string;
    readonly owner: {
      readonly run_id?: string;
      readonly claim_id?: string;
      readonly generation?: number;
      readonly pid?: number;
      readonly created_at?: string;
    } | null;
    readonly pidAlive: boolean | null;
    readonly holderLeaseState?: string | null;
    readonly runManifestPresent?: boolean | null;
  }[];
}

export interface LeaseAtPath {
  readonly lease: Lease;
  readonly path: string;
  readonly isCanonical: boolean;
}

export interface AttemptSnapshot {
  readonly attemptId: string;
  readonly isTerminal: boolean;
  readonly verdictPresent: boolean;
  readonly verdictVerifiedPresent: boolean;
  // Open question files (canonical path) — for row 11
  readonly questionFiles: readonly string[];
  // Answer files where no matching question file exists — for row 12
  readonly orphanAnswerFiles: readonly string[];
  // For row 5: blocked_on_question + answer ready OR timeout elapsed
  readonly blockedOnQuestion?: {
    readonly attemptStartedAt: string;
    readonly answerReady: boolean;
  };
}

export interface WorktreeSnapshot {
  readonly path: string;
  readonly taskIdFromMarker: string | null;
}

export interface BranchSnapshot {
  readonly ref: string;
  readonly taskIdFromRef: string | null;
}

export interface OrchestratorSnapshot {
  // Per-task collation. Key: taskId.
  readonly tasks: ReadonlyMap<string, TaskSnapshot>;
  // Tracker active issues (keyed by tracker_issue_id). Empty in auto-gc mode.
  readonly trackerIssues: ReadonlyMap<string, Issue>;
  readonly worktrees: readonly WorktreeSnapshot[];
  readonly branches: readonly BranchSnapshot[];
  readonly phases: Phases;
  readonly now: Date;
  // 'cheap' selects only CHEAP_ROW_IDS; 'full' considers all rows.
  readonly mode: 'cheap' | 'full';
  // Used by row 2 lease-expiry detector.
  readonly stealGraceMs?: number;
  // For row 5 timeout check. spec/ORCHESTRATOR.md §"Question channel" governs.
  readonly questionTimeoutMs?: number;
}

// ---- Helpers ----

function isTerminalTaskState(state: TaskState | undefined): state is TerminalTaskState {
  if (state === undefined) return false;
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

function leaseIdentityFrom(lease: Lease): LeaseIdentity {
  return {
    claimId: lease.claim_id,
    generation: lease.generation,
    ownerRunId: lease.owner_run_id,
  };
}

// ---- Row detectors (one per spec row) ----

// Row 1: running | done/cancelled/closed → mark local terminal, release lease
// Requires tracker state — full mode only.
function detectRow1(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'running') continue;
    const issue = findTrackerIssueForTask(s, taskId, task.state);
    if (!issue) continue;
    const lower = issue.state.toLowerCase();
    // FORGE-233: tracker done/closed is NEVER merge proof — the divergence is
    // REPORT-ONLY (surfaced for the operator; proof-backed promotion is
    // FORGE-235). Only cancellation remains an actionable terminal mapping.
    if (lower.includes('done') || lower.includes('closed')) {
      rows.push({
        rowId: 1,
        taskId,
        severity: 'warn',
        action: 'report_orphan',
        payload: {
          kind: 'tracker_claims_shipped',
          description: `tracker says '${issue.state}' while the task is running locally — tracker status is not merge proof; resolve manually (never auto-shipped)`,
        },
      });
      continue;
    }
    const targetState = mapTrackerToTerminal(issue.state);
    if (!targetState) continue;
    const lease = task.leases.find((l) => l.isCanonical);
    if (!lease) continue;
    rows.push({
      rowId: 1,
      taskId,
      severity: 'warn',
      action: 'mark_terminal',
      payload: {
        targetState,
        leaseIdentity: leaseIdentityFrom(lease.lease),
        trackerState: issue.state,
      },
    });
  }
  return rows;
}

// Row 2: running | no claim or claim by different run_id
// Cheap variant (this PR): only fires on lease expired beyond steal_grace_ms.
// Full variant (DEFERRED): also fires on tracker-side stale-claim divergence
// (tracker shows no claim, or claim by different run_id while local lease is
// still active). The CLI snapshot currently passes an empty trackerIssues map
// (see buildSnapshot in src/cli/orchestrate/gc.ts), so this sub-case is
// dormant — tracker integration follow-up activates it. (Codex 3rd-pass
// CONSIDER 6.)
function detectRow2(s: OrchestratorSnapshot): GcPlanRow[] {
  const graceMs = s.stealGraceMs ?? STEAL_GRACE_MS_DEFAULT;
  const nowMs = s.now.getTime();
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'running') continue;
    const canonical = task.leases.find((l) => l.isCanonical);
    if (!canonical) continue;
    const expiresAtMs = new Date(canonical.lease.expires_at).getTime();
    const ageMs = nowMs - (expiresAtMs + graceMs);
    if (ageMs <= 0) continue;
    rows.push({
      rowId: 2,
      taskId,
      severity: 'warn',
      action: 'mark_abandoned',
      payload: {
        leaseIdentity: leaseIdentityFrom(canonical.lease),
        expiredAt: canonical.lease.expires_at,
        expiredAgeMs: ageMs,
      },
    });
  }
  return rows;
}

// Row 3: claimed (local) | not claimed (tracker)
// Full mode only — requires tracker fetch.
function detectRow3(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'claimed') continue;
    const issue = findTrackerIssueForTask(s, taskId, task.state);
    // We can't see tracker-side claim from listActiveIssues() (Codex-2 #1).
    // Treat absent tracker entry as "not claimed" for v0.4. False positives are
    // possible for in-progress-state issues that just aren't surfaced; the
    // executor's per-row dry-run output lets the operator review before apply.
    if (issue && issue.state.toLowerCase().includes('progress')) continue;
    const canonical = task.leases.find((l) => l.isCanonical);
    if (!canonical) continue;
    rows.push({
      rowId: 3,
      taskId,
      severity: 'warn',
      action: 'mark_unclaimed',
      payload: {
        leaseIdentity: leaseIdentityFrom(canonical.lease),
        reason: issue ? 'tracker-not-claimed' : 'tracker-not-found',
      },
    });
  }
  return rows;
}

// Row 4: no local state | tracker claimed by us
// Auto-recovery DEFERRED — emits report_orphan only (detect-only this PR).
// Codex 2nd-pass #1: Issue lacks claim metadata; auto-recovery needs a tracker
// schema extension, filed as follow-up.
function detectRow4(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const issue of s.trackerIssues.values()) {
    if (!issue.forgeTaskId) continue;
    if (s.tasks.has(issue.forgeTaskId)) continue;
    // Issue is registered to a forge task that has no local state. Detection
    // only — the spec's "recover from tracker metadata" requires fields not
    // present on the current Issue type.
    rows.push({
      rowId: 4,
      taskId: issue.forgeTaskId,
      severity: 'warn',
      action: 'report_orphan',
      payload: {
        kind: 'tracker_claimed_no_local',
        description: `Tracker issue ${issue.identifier} maps to forge task ${issue.forgeTaskId} but no local state.json exists. Recover manually (auto-recovery follow-up).`,
      },
    });
  }
  return rows;
}

// Row 5: blocked_on_question — check answer / timeout
// Local-only — cheap.
function detectRow5(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  const timeoutMs = s.questionTimeoutMs;
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'blocked_on_question') continue;
    for (const att of task.attempts) {
      if (!att.blockedOnQuestion) continue;
      const answerReady = att.blockedOnQuestion.answerReady;
      const startedMs = new Date(att.blockedOnQuestion.attemptStartedAt).getTime();
      const elapsedMs = s.now.getTime() - startedMs;
      const timedOut = timeoutMs !== undefined && elapsedMs > timeoutMs;
      if (!answerReady && !timedOut) continue;
      rows.push({
        rowId: 5,
        taskId,
        severity: 'info',
        action: 'report_orphan',
        payload: {
          kind: 'answer_no_question',
          // FORGE-234 (R3 ΔR3): resolution is DESTINATION-AWARE and owned by
          // the answer verb (ship-origin: retry_ship → reviewed, cancel_task →
          // cancelled; worker-origin: dispatch re-spawn). gc never advances a
          // parked task itself — a blind awaiting_respawn would violate a
          // cancel answer.
          description: answerReady
            ? `Attempt ${att.attemptId}: answer ready — re-run \`forge orchestrate answer\` to apply the phase-aware resolution (ship parks resolve to reviewed/cancelled; worker questions re-dispatch)`
            : `Attempt ${att.attemptId}: question timeout (${elapsedMs}ms > ${timeoutMs}ms) — run gc to mark expired`,
        },
      });
    }
  }
  return rows;
}

// Row 6: ready_for_review (local) | done (tracker) — REPORT ONLY (FORGE-231).
// The spec forbids inferring shipping from tracker state (ORCHESTRATOR §gc:
// nothing merges — or is recorded as merged — without the orchestrator's own
// RepoHost merge proof). A tracker marked Done while the task never shipped is
// a divergence for a HUMAN to resolve, never an automatic mark_terminal.
function detectRow6(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'ready_for_review') continue;
    const issue = findTrackerIssueForTask(s, taskId, task.state);
    if (!issue) continue;
    if (!issue.state.toLowerCase().includes('done')) continue;
    rows.push({
      rowId: 6,
      taskId,
      severity: 'warn',
      action: 'report_orphan',
      payload: {
        kind: 'tracker_done_not_shipped',
        description: `tracker says '${issue.state}' but the task is ready_for_review locally — the tracker cannot prove a merge; resolve manually (never auto-shipped)`,
      },
    });
  }
  return rows;
}

// Row 7: shipped | not closed — recheck PR / report
function detectRow7(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'shipped') continue;
    const issue = findTrackerIssueForTask(s, taskId, task.state);
    if (!issue) continue;
    if (issue.state.toLowerCase().includes('done')) continue;
    rows.push({
      rowId: 7,
      taskId,
      severity: 'info',
      action: 'report_orphan',
      payload: {
        kind: 'shipped_not_closed',
        description: `Task ${taskId} is shipped locally but tracker state is '${issue.state}' (not done). PR may be open or tracker may need manual close.`,
      },
    });
  }
  return rows;
}

// Row 8: verdict.json exists, verdict.verified.json missing — re-verify
// Local-only — cheap.
function detectRow8(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    for (const att of task.attempts) {
      if (att.verdictPresent && !att.verdictVerifiedPresent) {
        rows.push({
          rowId: 8,
          taskId,
          severity: 'info',
          action: 'reverify_verdict',
          payload: {
            attemptId: att.attemptId,
            verdictPath: `attempts/${att.attemptId}/verdict.json`,
          },
        });
      }
    }
  }
  return rows;
}

// Row 9: branch exists, worktree missing — full mode (git scan)
function detectRow9(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  const worktreeTaskIds = new Set<string>();
  for (const w of s.worktrees) {
    if (w.taskIdFromMarker) worktreeTaskIds.add(w.taskIdFromMarker);
  }
  for (const b of s.branches) {
    if (!b.taskIdFromRef) continue;
    if (worktreeTaskIds.has(b.taskIdFromRef)) continue;
    const task = s.tasks.get(b.taskIdFromRef);
    const taskState = task?.state?.state;
    if (taskState === 'shipped') {
      rows.push({
        rowId: 9,
        taskId: b.taskIdFromRef,
        severity: 'info',
        action: 'prune_branch',
        payload: { branchRef: b.ref, reason: 'shipped' },
      });
    } else {
      // Unclaimed / terminal / unknown — emit prompt as report_orphan; user
      // confirms via dry-run before any prune.
      rows.push({
        rowId: 9,
        taskId: b.taskIdFromRef,
        severity: 'warn',
        action: 'report_orphan',
        payload: {
          kind: 'worktree',
          description: `Branch ${b.ref} exists but its worktree is missing (task state: ${taskState ?? 'unknown'}). Review dry-run before prune.`,
        },
      });
    }
  }
  return rows;
}

// Row 10: worktree exists, no task in phases.yaml
function detectRow10(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const knownTaskIds = new Set<string>();
  for (const phase of s.phases.phases) {
    for (const t of phase.tasks) {
      knownTaskIds.add(t.id);
      if (t.tracker_issue_id) knownTaskIds.add(t.tracker_issue_id);
    }
  }
  const rows: GcPlanRow[] = [];
  for (const w of s.worktrees) {
    if (!w.taskIdFromMarker) continue;
    if (knownTaskIds.has(w.taskIdFromMarker)) continue;
    rows.push({
      rowId: 10,
      taskId: w.taskIdFromMarker,
      severity: 'warn',
      action: 'report_orphan',
      payload: {
        kind: 'worktree',
        description: `Orphan worktree at ${w.path} (task ${w.taskIdFromMarker} not in phases.yaml).`,
      },
    });
  }
  return rows;
}

// Row 11: question file exists, attempt is terminal — archive
function detectRow11(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    for (const att of task.attempts) {
      if (!att.isTerminal) continue;
      for (const qPath of att.questionFiles) {
        rows.push({
          rowId: 11,
          taskId,
          severity: 'info',
          action: 'archive_question',
          payload: {
            questionPath: qPath,
            attemptId: att.attemptId,
          },
        });
      }
    }
  }
  return rows;
}

// Row 12: answer file exists, question file missing — log + archive
function detectRow12(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    for (const att of task.attempts) {
      for (const aPath of att.orphanAnswerFiles) {
        rows.push({
          rowId: 12,
          taskId,
          severity: 'warn',
          action: 'report_orphan',
          payload: {
            kind: 'answer_no_question',
            description: `Orphan answer file ${aPath} for attempt ${att.attemptId} (question file missing — shouldn't happen).`,
          },
        });
      }
    }
  }
  return rows;
}

// Row 13: multiple leases for same task — release older generations.
// Uses adminReleaseLeaseByIdentity at the executor side (planner emits one row
// per non-canonical / older-generation lease file).
//
// Tie-breaker: when two leases share a generation (corruption — shouldn't
// happen given the monotonic-generation claim flow), prefer the CANONICAL file
// as authoritative. Without this, readdirSync's order could put the canonical
// lease in the "to release" set. (Codex 3rd-pass BLOCK 2.)
// Row 15 (FORGE-231): merge_pending + canonical lease expired-beyond-grace →
// identity-checked lease release. complete releases the worker lease right
// after entering merge_pending; a crash in that window leaves a lease with no
// heartbeat source. The task STATE is untouched (merge_pending is legitimate
// until the platform merge is confirmed).
//
// FORGE-235 division of labour: gc stays OFFLINE and deterministic — it never
// probes a platform and never promotes. `forge orchestrate merge-tick` owns
// live observation, promotion on exact proof, and typed reports for every
// non-terminal outcome. Releasing this lease is a precondition for that
// promotion: commitMergePromotion refuses while a live lease exists, so a
// crashed worker's leftover lease is exactly what this row clears.
function detectRow15(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  const graceMs = s.stealGraceMs ?? STEAL_GRACE_MS_DEFAULT;
  for (const [taskId, task] of s.tasks) {
    if (task.state?.state !== 'merge_pending') continue;
    const lease = task.leases.find((l) => l.isCanonical);
    if (!lease) continue;
    const expiresAt = Date.parse(lease.lease.expires_at);
    if (Number.isNaN(expiresAt) || s.now.getTime() <= expiresAt + graceMs) continue;
    rows.push({
      rowId: 15,
      taskId,
      severity: 'warn',
      action: 'release_lease_admin',
      payload: {
        expectedClaimId: lease.lease.claim_id,
        expectedGeneration: lease.lease.generation,
        expectedOwnerRunId: lease.lease.owner_run_id,
        expectedExpiresAt: lease.lease.expires_at,
        expectedPath: lease.path,
        requireTerminalState: false,
        reason: 'gc:row-15:merge-pending-lease',
      },
    });
  }
  return rows;
}

// Row 16 (FORGE-231): stuck CAS transition markers — REPORT ONLY. Conservative
// no-takeover recovery: gc NEVER removes an incomplete marker; the report
// carries the manual remediation contract (operator confirms the owning run/
// process is dead — PID liveness is a HINT, PID reuse is possible — then
// removes the marker file by hand).
function detectRow16(s: OrchestratorSnapshot): GcPlanRow[] {
  if (s.mode === 'cheap') return [];
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    for (const marker of task.stuckCasMarkers ?? []) {
      const owner = marker.owner
        ? `owner run=${marker.owner.run_id ?? '?'} claim=${marker.owner.claim_id ?? '?'} gen=${marker.owner.generation ?? '?'} pid=${marker.owner.pid ?? '?'}${marker.pidAlive === null ? '' : marker.pidAlive ? ' (pid APPEARS ALIVE — do not remove)' : ' (pid appears dead; reuse possible — confirm via the run, not the pid)'} created=${marker.owner.created_at ?? '?'}; ${marker.holderLeaseState ?? 'holder lease: unknown'}; owner run dir ${marker.runManifestPresent === null ? 'unknown' : marker.runManifestPresent ? 'present (a trace — NOT liveness proof)' : 'absent'}`
        : 'owner tuple unreadable — treat as ALIVE and investigate before touching';
      rows.push({
        rowId: 16,
        taskId,
        severity: 'warn',
        action: 'report_orphan',
        payload: {
          kind: 'stuck_cas_marker',
          description:
            `incomplete CAS marker ${marker.markerPath} (transition ${marker.domain} on ${marker.guardedFile}); ${owner}. ` +
            'A writer crashed mid-commit or is paused; confirm the owning RUN is dead, then remove the marker file manually. gc never removes an incomplete marker.',
        },
      });
    }
  }
  return rows;
}

function detectRow13(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (task.leases.length < 2) continue;
    const sorted = [...task.leases].sort((a, b) => {
      if (b.lease.generation !== a.lease.generation) {
        return b.lease.generation - a.lease.generation;
      }
      // Tie on generation: canonical lease wins (kept), non-canonical released.
      if (a.isCanonical && !b.isCanonical) return -1;
      if (!a.isCanonical && b.isCanonical) return 1;
      // Both canonical or both non-canonical on tie — fall back to path order
      // (deterministic). The executor's identity check protects against
      // unlinking the wrong file under all-same-generation pathologies.
      return a.path.localeCompare(b.path);
    });
    // FORGE-231 (impl R2 MAJ-3): the CANONICAL path is the only lease normal
    // readers consume — row 13 must NEVER release it in favor of a
    // non-canonical artifact. Duplicate cleanup releases NON-canonical
    // artifacts only; a non-canonical artifact carrying a HIGHER generation
    // than the canonical lease is corruption a human must resolve — report,
    // never auto-pick a winner that readers cannot see.
    const canonical = task.leases.find((l) => l.isCanonical);
    // impl R3 MAJ-3: with NO active canonical lease (absent or tombstoned),
    // nothing can be verified authoritative — releasing the artifacts would
    // destroy the only remaining ownership evidence. Report for a human.
    if (!canonical) {
      rows.push({
        rowId: 13,
        taskId,
        severity: 'warn',
        action: 'report_orphan',
        payload: {
          kind: 'tracker_claimed_no_local',
          description: `${task.leases.length} non-canonical lease artifact(s) exist with NO active canonical lease — cannot determine the authoritative owner; resolve manually (gc never deletes ownership evidence in this topology)`,
        },
      });
      continue;
    }
    const highest = sorted[0];
    if (highest && !highest.isCanonical && highest.lease.generation > canonical.lease.generation) {
      rows.push({
        rowId: 13,
        taskId,
        severity: 'warn',
        action: 'report_orphan',
        payload: {
          kind: 'tracker_claimed_no_local',
          description: `non-canonical lease artifact ${highest.path} carries generation ${highest.lease.generation} ABOVE the canonical lease (generation ${canonical.lease.generation}) — corrupted duplicate topology; resolve manually (gc never promotes or releases the canonical lease over an invisible artifact)`,
        },
      });
      continue;
    }
    for (const stale of sorted) {
      if (stale.isCanonical) continue; // canonical is released only by rows 14/15 with full identity gates
      rows.push({
        rowId: 13,
        taskId,
        severity: 'warn',
        action: 'release_lease_admin',
        payload: {
          expectedClaimId: stale.lease.claim_id,
          expectedGeneration: stale.lease.generation,
          expectedOwnerRunId: stale.lease.owner_run_id,
          expectedExpiresAt: stale.lease.expires_at,
          expectedPath: stale.path,
          requireTerminalState: false,
          reason: 'gc:row-13:duplicate',
        },
      });
    }
  }
  return rows;
}

// Row 14: lease present, task state is terminal — release lease admin
function detectRow14(s: OrchestratorSnapshot): GcPlanRow[] {
  const rows: GcPlanRow[] = [];
  for (const [taskId, task] of s.tasks) {
    if (!isTerminalTaskState(task.state?.state)) continue;
    const canonical = task.leases.find((l) => l.isCanonical);
    if (!canonical) continue;
    rows.push({
      rowId: 14,
      taskId,
      severity: 'info',
      action: 'release_lease_admin',
      payload: {
        expectedClaimId: canonical.lease.claim_id,
        expectedGeneration: canonical.lease.generation,
        expectedOwnerRunId: canonical.lease.owner_run_id,
        expectedExpiresAt: canonical.lease.expires_at,
        expectedPath: canonical.path,
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      },
    });
  }
  return rows;
}

// ---- Tracker lookup helper ----

function findTrackerIssueForTask(
  s: OrchestratorSnapshot,
  taskId: string,
  _state: TaskStateRecord | null,
): Issue | undefined {
  // Direct map lookup — tracker_issue_id might match either tracker.id or
  // tracker.identifier depending on adapter. Search both.
  if (s.trackerIssues.has(taskId)) return s.trackerIssues.get(taskId);
  for (const issue of s.trackerIssues.values()) {
    if (issue.identifier === taskId || issue.forgeTaskId === taskId) {
      return issue;
    }
  }
  return undefined;
}

// FORGE-233: tracker done/closed is NEVER merge proof (ORCHESTRATOR:880) —
// row 1 no longer maps it to 'shipped'; only cancellation remains actionable.
// A tracker-done divergence is REPORT-ONLY (row-6 family); the proof-backed
// merge_pending→shipped promotion arrives with FORGE-235's reconciliation.
function mapTrackerToTerminal(trackerState: string): TerminalTaskState | null {
  const lower = trackerState.toLowerCase();
  if (lower.includes('cancel')) return 'cancelled';
  return null;
}

// ---- planGc — compose detectors, sort, return GcPlan ----

const ROW_DETECTORS: readonly ((s: OrchestratorSnapshot) => GcPlanRow[])[] = [
  detectRow1,
  detectRow2,
  detectRow3,
  detectRow4,
  detectRow5,
  detectRow6,
  detectRow7,
  detectRow8,
  detectRow9,
  detectRow10,
  detectRow11,
  detectRow12,
  detectRow15,
  detectRow16,
  detectRow13,
  detectRow14,
];

export function planGc(snapshot: OrchestratorSnapshot): GcPlan {
  const collected: GcPlanRow[] = [];
  for (const detector of ROW_DETECTORS) {
    for (const row of detector(snapshot)) {
      if (snapshot.mode === 'cheap' && !CHEAP_ROW_IDS.has(row.rowId)) continue;
      collected.push(row);
    }
  }
  // Deterministic ordering: by (rowId, taskId). Stable across runs.
  collected.sort((a, b) => {
    if (a.rowId !== b.rowId) return a.rowId - b.rowId;
    return a.taskId.localeCompare(b.taskId);
  });
  return { rows: collected, cheapRows: CHEAP_ROW_IDS };
}

// Exhaustiveness check helper — call this at the executor's switch default
// branch to make the union exhaustive at compile time.
export function assertNeverGcRow(row: never): never {
  throw new Error(`Unhandled GcPlanRow: ${JSON.stringify(row)}`);
}
