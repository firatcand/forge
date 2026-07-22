# forge — ORCHESTRATOR architecture (v2)

> Drafted: 2026-05-13 (v1 — daemon design)
> Revised: 2026-05-14 (v2 — CLI-as-control-plane + skill-as-dispatch)
> **Re-amended 2026-05-17 PM (team-mode minimum architecture — partially supersedes morning's uncommitted CLI surface rewrite)**
> Scope: contract for the orchestrator subsystem (Phase 2 + Phase 2.5 tasks).
> Status: amendment header below is authoritative for v0.4; body below contains uncommitted morning-redesign content that needs surgical trimming per the amendment.
>
> **v2 changes:** The daemon process and `execa`-based subprocess workers are deleted. Workers are now host-native subagents (Claude Code's Task tool / Codex's native subagent dispatch). State lives in a stateless CLI control plane plus durable on-disk state. See "Changes from v1" at the end for the rationale and a point-by-point mapping.

## Amendment 2026-05-17 PM — team-mode minimum architecture (partial supersession of uncommitted body)

This file currently has **uncommitted morning-redesign edits** (CLI surface split into read-only vs mutating bands; new verbs `claim`/`dispatch`/`heartbeat`/`question`/`answer`/`event`/`apply-decision`/`amend-roadmap`/`worktree-drift-guard`/`reconcile`/`doctor`/`status`/`phases`/`attach`/`run`; `QuestionIndex` extended with `drift_event_id` + `routing_hint`).

Per [docs/plans/team-mode-minimum-architecture.md](../docs/plans/team-mode-minimum-architecture.md), v0.4 ships **only a subset** of those. Surgical trim required on the next pass:

### Keep from the uncommitted body

- The **CLI surface split** into read-only vs user-approved-mutate bands. Good architecture, retain.
- **Read-only verbs:** `phases` (with `--ready`, `--phase implement|review|ship`), `status`, `questions`, `doctor`, `attach`, `run list`.
- **Mutating verbs:** `claim`, `dispatch` (refuses without claim_id), `heartbeat`, `question`, `answer`, `event`, `complete`, `cancel`, `gc`, `reconcile`, `run start`.
- The **stable JSON envelope** `{ ok, data?, error? }` on `--json`.

### Remove from the uncommitted body (deferred to v0.5 opt-in)

- `forge orchestrate apply-decision` verb (entire section)
- `forge orchestrate amend-roadmap` verb (entire section)
- `forge orchestrate worktree-drift-guard` verb (entire section)

### Remove from the uncommitted body (dropped entirely)

- `QuestionIndex.drift_event_id` field (the comment "Added 2026-05-17 per Codex C5 — drift routing fields" near the top of the file)
- `QuestionIndex.routing_hint` field
- All references to `--drift-event-id` and `--routing-hint amend-roadmap` flags on `question` verb
- All references to `--type drift` on the `event` verb (the `event` verb stays for other types; just the drift-typed events are removed)
- The "Note (2026-05-17 simplification)" block referencing `suggest-next`/`session-check`/`intent-detect` (already removed at decompose time; the block referencing their removal can also go now that nobody is reading the comparison).

### Simplify in the uncommitted body

- **Worker prompt template section** — replace the 6-level precedence rules with **authority-by-field** (SPEC owns architecture; tracker owns execution; phases.yaml is a derived snapshot with freshness display). Drop the drift event/question protocol. Add: on resume, the dispatch skill emits an informational `SPEC changed since claim — N commits` block; the worker proceeds regardless.
- **Doctor section** — scope down to SPEC↔code reference checks only. Drop ADR-drafts scope. Drop apply-journal scope.
- **Reconcile section** — bidirectional but no conflict-resolution UI (team handles via git/tracker normally). Diff preview only.
- **`/forge orchestrate` dispatch skill section** — keep the present → approve → claim flow. Add the SPEC-diff-since-claim notification at worker-resume time.

### Add to the body (new)

- `phases.yaml` carries a `source:` block (tracker, project_id, synced_at, tracker_revision, spec_revision). Every CLI verb that reads `phases.yaml` prints a freshness summary line. Reference the schema in `spec/SPEC.md` §`phases.yaml is a derived snapshot`.
- Claim record gains a `spec_revision` field stamped at claim time. Dispatch skill computes commits-since-claim-against-spec/ on resume and emits informational block.

**Process note:** the §Worker prompt template body (below) has been rewritten in P2.5-T06 / FORGE-97 to match the authority-by-field contract. The other simplifications enumerated above (Doctor scope-down, Reconcile UI, dispatch-skill resume notification, `phases.yaml` source block, claim `spec_revision`) are handled by their respective tickets (P2.5-T08 / FORGE-99, P2.5-T09 / FORGE-100, P2.5-T07 / FORGE-98, P2.5-T17 / FORGE-113, P2.5-T18 / FORGE-114).

---

## Purpose

forge's orchestrator turns the dependency graph in `phases.yaml` into shipped PRs, with a human in the loop on architectural decisions and autonomy on tactical ones. It is structured as three layers:

1. **Control plane** — the `forge` CLI. Stateless on-demand commands that own durable state on disk: task/attempt/run state machines, leases, atomic file ops, tracker CAS, schema validation, gc reconciliation. Source of truth.
2. **Dispatch layer** — a host-specific skill (`/forge orchestrate` in Claude Code; equivalent in Codex). Thin. Reads the next ready task from the CLI, dispatches a worker via the host's native subagent primitive, relays open questions to the user, records answers, polls for completion. Has no persistent state of its own.
3. **Worker layer** — a host-native subagent prompt template. Receives a task, works in an isolated worktree, calls CLI commands to register questions and report verdicts, returns to the parent skill on completion or block.

The design satisfies three constraints:

1. **Two-host parity.** Claude Code and Codex CLI users get equivalent UX. The CLI is identical across hosts; the dispatch layer is one thin per-host skill; the worker prompt is portable text with host-specific dispatch glue.
2. **Subscription billing only.** Workers are subagents in the user's interactive main session, billed against the user's Claude / ChatGPT Plus subscription. The orchestrator never spawns headless host CLI processes (`claude -p`, `codex exec`) and never uses provider API keys or Agent SDK quota.
3. **Human-in-the-loop on architecture.** Workers escalate decisions that affect public API shape, file lifecycle, deprecation strategy, exported-symbol naming, scope, or error semantics across module boundaries. They decide autonomously on tactical matters (variable names, internal helpers, log format, test fixture shape).

## Architectural primitives

The orchestrator is **not** a long-running process. It is three layered surfaces:

| Layer | Responsibility | Owner module |
|---|---|---|
| **CLI control plane** | State machine, leases, atomic file ops, tracker CAS, schema validation, gc reconciliation, status snapshots, event log | `src/cli/orchestrate/*.ts`, `src/orchestrator/state/*.ts`, `src/orchestrator/leases/*.ts` |
| **Skill dispatch layer** | Read ready tasks, dispatch subagents, relay questions to the user, record answers, poll completion | `skills/forge-orchestrate/SKILL.md` (host-specific files compiled from a shared source in Phase 3) |
| **Worker subagent** | Implement a task in a worktree, call CLI to register questions/verdicts, return to parent on completion or block | `templates/worker-prompt.template.md` (rendered by `src/orchestrator/render-worker-prompt.ts` and loaded into every subagent dispatch) |

The three are file-disjoint. They share contracts (schemas, filesystem layout, event types) defined in this document. The CLI is the only surface that mutates persistent state. Skills and workers call the CLI; they never read or write `.forge/orchestrator/` directly.

## Write-surface contract (who may write what under .forge/)

Workers, skills, and the CLI have different write authority. The contract:

| Path | Worker may write | Skill may write | CLI writes |
|---|---|---|---|
| `.forge/orchestrator/tasks/<t>/state.json` | ❌ | ❌ | ✅ (only via state-machine transitions) |
| `.forge/orchestrator/tasks/<t>/lease.json` | ❌ | ❌ | ✅ (only via lease verbs) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/manifest.json` | ❌ | ❌ | ✅ (on `dispatch`) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/events.jsonl` | ✅ via `forge orchestrate event` | ❌ | ✅ for events the CLI observes |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/save-point.md` | ✅ direct write | ❌ | — |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/verdict.json` | ✅ direct write (advisory; CLI verifies) | ❌ | — |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/verdict.verified.json` | ❌ | ❌ | ✅ (only on `complete` after verification) |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/questions/<q>.json` | ✅ via `forge orchestrate question` | ❌ | ✅ for CLI-validated writes |
| `.forge/orchestrator/tasks/<t>/attempts/<a>/answers/<q>.json` | ❌ | ❌ | ✅ on `answer` verb |
| `.forge/orchestrator/runs/<r>/notifications.jsonl` | ❌ | ❌ | ✅ (notification stream is CLI-emitted) |
| `.forge/orchestrator/index/questions.json` | ❌ | ❌ | ✅ (global question index — see "Answer lookup" below) |
| `.forge/logs/orchestrate.jsonl` | — (no direct path) | — | ✅ (every CLI invocation appends) |
| `.forge/worktrees/<sanitized-task>/**` | ✅ (this is the worker's working directory) | ❌ (use `forge orchestrate ensure-worktree` instead — FORGE-98) | ✅ create via `ensure-worktree`, remove via `gc` |

**Principles:**
- All writes go through atomic helpers (tmp+link+unlink, never `rename`) regardless of writer.
- Worker direct-writes to advisory paths (verdict.json, save-point.md) are explicitly OK because the CLI verifies them on `complete`. The CLI rejects writes whose verification fails.
- Skill never writes anything under `.forge/orchestrator/` directly. Every skill state change goes through a CLI verb.
- `state.json` and `lease.json` are CLI-only — even workers cannot touch them. This is what makes the state machine enforceable.

### Answer lookup — global index

`forge orchestrate answer <question-id>` accepts a global question ID (UUIDv7) but answers are stored task-keyed under `.forge/orchestrator/tasks/<t>/attempts/<a>/answers/<q>.json`. To make the global lookup cheap, the CLI maintains a small global index at `.forge/orchestrator/index/questions.json`:

```ts
type QuestionIndex = {
  version: 1;
  questions: {
    [question_id: string]: {
      task_id: string;
      attempt_id: string;
      decision_key: string;
      created_at: string;
      resolved_at: string | null;
      // Added 2026-05-17 per Codex C5 — drift routing fields
      drift_event_id?: string;
      routing_hint?: 'amend-roadmap';  // 'apply-decision' was originally here, removed for ephemeral ADRs (use --draft + --apply directly)
    };
  };
};
```

The index is written atomically on every `forge orchestrate question` and `answer`. If the index is corrupted or out-of-sync (detectable via the global event log on next gc pass), it is fully rebuilt from the task tree — the canonical store is per-task; the index is derivable.

## CLI surface (rewritten 2026-05-17, simplified — read-only / mutate split per "suggest-don't-force")

The `forge orchestrate` command tree is the entire public surface of the control plane. **Verbs are classified into two strictly-separated bands:**

- **Read-only verbs** never acquire leases, never mutate tracker, never write task state.
- **User-approved mutating verbs** require explicit user approval per invocation, either at the verb call (e.g., `claim` is only called after the user picked a task from `phases --ready` output) or implicitly via the invoking skill having gathered approval (e.g., `apply-decision` is only called by `/update-spec --apply` skill which has user diff-review confirmation).

Every command is idempotent within its band, validates inputs with zod before touching disk or tracker, and returns a stable JSON envelope on `--json`: `{ ok: boolean, data?: ..., error?: { code, message, retriable } }`.

**Note (2026-05-17 simplification):** Feature 7's `suggest-next`, `session-check`, `intent-detect` verbs and the deprecated `next` alias were ALL dropped. Use cases:
- Listing ready tasks → `forge orchestrate phases --ready` (already existed, now extended with `--phase implement|review|ship`)
- Session re-grounding → `forge orchestrate status` (already existed) or the `/status-check` skill (FORGE-90)
- "I had an idea" intent → user explicitly invokes `/amend-roadmap` (no automatic detection)

### Read-only verbs

```
forge orchestrate doctor [--scope spec-code|all] [--json]
    # Read-only drift diagnostics (v0.4: file-path checks across spec files vs src/).
    # Scopes: spec-code (default), all (alias for spec-code in v0.4; reserved for v0.5).
    # Deprecated: --scope adr-drafts and --scope apply-journal (rejected with INVALID_ARGS; deferred to v0.5 per SPEC §21).
    # Honors settings.doctor.spec_code_check_enabled (default true).
    # Exit codes: 0 clean, 1 warnings, 2 drift detected.

forge orchestrate status [--run <run-id>] [--json] [--include-warnings]
    # Snapshot of task state(s). Also used for session re-grounding.
    # --json: stable ok envelope mirroring the text snapshot (run id, started_at,
    #   pid, worker status counts). --include-warnings adds the auto-gc cheap
    #   divergences as a `warnings` array (FORGE-149).

forge orchestrate questions [--open] [--run <run-id>] [--json]
    # List questions.

forge orchestrate phases [--ready] [--phase implement|review|ship] \
    [--blocked-by <task-id>] [--limit N] [--run <run-id>] [--json] [--include-warnings]
    # Read-only graph state inspection. With --ready, returns tasks ready for the given phase
    # (deps shipped + merged + no worktree overlap for implement). Used by the dispatch skill to
    # present options to the user before user-approved claim+dispatch.
    # --include-warnings (with --ready --json): adds the auto-gc cheap divergences
    #   as a `warnings` array on the result data; omitted entirely otherwise (FORGE-149).

forge orchestrate attach --run <run-id>
    # Tail .forge/orchestrator/runs/<run-id>/notifications.jsonl. Read-only (consumer side).

forge orchestrate render-worker-prompt --task <task-id> --attempt <attempt-id> \
    [--repo-root <path>] [--json]
    # (FORGE-98) Render the worker prompt for a dispatched attempt. Read-only —
    # sources WorkerPromptContext from attempt manifest.json, plans/phases.yaml
    # (description + acceptance), CLAUDE.md or AGENTS.md (conventions),
    # .forge/settings.yaml (host), and walks attempts/* for prior attempts +
    # answered questions. Returns the rendered prompt string in the envelope
    # so the dispatch skill can inject it into the host's Task tool when
    # spawning the worker subagent. dispatch.ts does NOT render or spawn.
```

### User-approved mutating verbs

```
forge orchestrate ensure-worktree --task <task-id> [--base <branch>] [--branch <name>] \
    [--repo-root <path>] [--json]
    # (FORGE-98) Idempotent worktree create + hydrate at .forge/worktrees/<sanitized-task>/.
    # Honors the write-surface contract — CLI is the sole writer of .forge/worktrees/.
    # Wrapper around src/core/workspace.ts#create with idempotence:
    #   - existing marker with matching task_id → no-op exit 0, returns {created:false}
    #   - existing marker with different task_id → exit 1 with WORKTREE_CONFLICT
    #   - path exists without a marker → exit 1 (refuses to overwrite manual dirs)
    # Used by both /pickup-task and /forge orchestrate so worktree creation
    # lives behind one authoritative code path.

forge orchestrate claim <task-id> --run <run-id> [--json]
    # (Renamed from the mutating half of `next`.) Atomically claims task via tracker CAS + local lease.
    # Refuses if task is not in `unclaimed` state or lease is held by another active claim.
    # Returns claim_id (UUIDv7) on success. Caller (skill) MUST have user approval per Flow 2.

forge orchestrate dispatch <task-id> --claim <claim-id> --run <run-id> \
    --worktree <path> [--phase implement|review|ship] [--json]
    # Register a new worker attempt. REFUSES without a valid claim_id from a prior `claim` call.
    # --phase defaults to implement on first dispatch; review/ship continue under the original IMPLEMENT claim.

forge orchestrate heartbeat <task-id> --attempt <attempt-id> [--json]
    # Renew lease. Returns LEASE_STOLEN if generation has moved past the holder.

forge orchestrate question <task-id> --attempt <attempt-id> \
    --decision-key <key> --question <text> [--options-file <path>] \
    [--drift-event-id <id>] [--routing-hint apply-decision|amend-roadmap] [--json]
    # Worker writes a question. --drift-event-id + --routing-hint added 2026-05-17 for §Precedence rules
    # integration: when a worker emits a drift event before writing the question, link them so the
    # supervisor's dispatch skill can suggest the right routing skill (/update-spec --apply or /amend-roadmap).

forge orchestrate answer <question-id> --option <id> [--note <text>]
    # Supervisor answers a question.

forge orchestrate event <task-id> --attempt <attempt-id> \
    --type <event-type> [--data <json>] [--json]
    # Append to attempt event log. event-type includes drift (added 2026-05-17 per §Precedence rules).

forge orchestrate complete <task-id> --attempt <attempt-id> \
    --verdict-file <path> [--phase implement|review|ship] [--json]
    # Finalize an attempt. CLI re-verifies tests, lint, diff stats independently before accepting.

forge orchestrate cancel <task-id> [--reason <text>] [--json]
    # Cancel + flag cleanup. Marks current attempt cancelled, releases lease, preserves worktree.

forge orchestrate gc [--dry-run] [--run <run-id>] [--json]
    # Reconciliation pass per gc divergence table.

forge orchestrate run start [--name <text>] [--json]
    # Start a new orchestrator run. Allowed because invocation of /forge orchestrate constitutes
    # user approval to begin a run; subsequent task-level approvals still required for each claim.

forge orchestrate run list [--active] [--json]
```

### Closed-loop workflow control verbs (added 2026-05-17, simplified for ephemeral ADRs)

```
forge orchestrate apply-decision --adr <slug> [--yes-all] [--resume] [--dry-run] [--json]
    # CLI verb wrapping /update-spec --apply skill's mutations.
    # Propagate accepted ephemeral ADR to SPEC + PRD § + phases.yaml task amendments + tracker issue body updates.
    # Refuses if ADR frontmatter status != "accepted". Shows diff per artifact; user confirms each unless --yes-all.
    # Writes journal at .forge/orchestrator/global/update-spec-apply-journal/<slug>.json before each mutation
    # so --resume can recover from partial tracker failures (Codex C2).
    # On full success: writes ADR content (Context + Decision + Alternatives + Consequences) to commit message body,
    # DELETES spec/decisions/<slug>.md, archives journal under .../completed/, invokes worktree-drift-guard.

forge orchestrate amend-roadmap [--from-file <yaml>] [--task-id <id>] \
    [--title <text>] [--depends-on <ids>] [--owner-type <type>] [--json]
    # Mid-flight new-task creation. Writes to phases.yaml AND pushes to tracker atomically (local rollback
    # on tracker failure; resumable journal under .forge/orchestrator/global/amend-journal/).

forge orchestrate reconcile {--pull|--push} [--dry-run] [--json]
                            [--confirm-prune|--no-prune] [--task <task-id>] [--check]
    # Bi-directional phases.yaml ↔ tracker sync.
    # --pull: tracker → phases.yaml (detects new issues, status changes); conflict prompts user.
    # --push: phases.yaml → tracker (mirrors local canonical state).
    # --confirm-prune / --no-prune: resolve orphan-task removals (PRUNE_PENDING exits 1 until one is given).
    # --task <id> (FORGE-119): scope the run to one task — a scoped run never applies/prunes/pushes
    #   outside that task; unknown id → INVALID_ARGS exit 3.
    # --check (FORGE-123, --pull only): probe the cheap upstream revision first; on a match, refresh the
    #   freshness stamp and exit 0 WITHOUT fetching the issue list; mismatch/missing/probe-failure → full pull.

forge orchestrate worktree-drift-guard --adr <slug> [--task <task-id>] [--dry-run] [--json]
    # Invoked by /update-spec --apply and /amend-roadmap to proactively flag active worktrees whose task
    # depends on a SPEC section being mutated. Writes drift events + questions into worker channels.
    # Targets worktrees in states: running, blocked_on_question, awaiting_respawn, ready_for_review (Codex I3).
    # --dry-run returns affected list without writing events (Codex I1).
```

### Verb classification table

| Verb | Band | User approval source |
|---|---|---|
| `doctor` | read | n/a |
| `status` | read | n/a |
| `questions` | read | n/a (now accepts `--run <id>` filter — FORGE-98) |
| `phases` | read | n/a |
| `attach` | read | n/a |
| `render-worker-prompt` | read | n/a (FORGE-98 — read-only prompt synthesis for dispatch skill) |
| `run list` | read | n/a |
| `ensure-worktree` | mutate | Per-task: inherited from the `/forge orchestrate` or `/pickup-task` skill's user approval (FORGE-98) |
| `claim` | mutate | Per-task: user picked from `phases --ready` output |
| `dispatch` | mutate | Inherits from prior `claim` |
| `heartbeat` | mutate | Inherits from prior `dispatch` |
| `question` | mutate | Worker has dispatch grant |
| `answer` | mutate | Supervisor explicit |
| `event` | mutate | Worker has dispatch grant |
| `complete` | mutate | Worker has dispatch grant |
| `cancel` | mutate | Supervisor explicit |
| `gc` | mutate | Supervisor explicit OR auto-gc opt-in |
| `run start` | mutate | Invocation of `/forge orchestrate` = approval |
| `apply-decision` | mutate | `/update-spec --apply` skill diff-review |
| `amend-roadmap` | mutate | `/amend-roadmap` skill prompt confirmation |
| `reconcile` | mutate | Per-task diff confirmation |
| `worktree-drift-guard` | mutate | Inherited from parent `/update-spec --apply` or `/amend-roadmap` |

## State machine

### Task state (cross-run, repo-level, persisted)

```
                  ┌───────────────────────────────────────────────────┐
                  │                                                    │
                  ▼                                                    │
              unclaimed                                                │
                  │                                                    │
                  │ claim (atomic, lease-backed)                       │
                  ▼                                                    │
              claimed                                                  │
                  │                                                    │
                  │ dispatch                                           │
                  ▼                                                    │
              dispatched                                               │
                  │                                                    │
                  │ first heartbeat                                    │
                  ▼                                                    │
              running                                                  │
                  │                                                    │
                  ├─── question_written ──▶ blocked_on_question        │
                  │                                  │                 │
                  │                                  │ answer_recorded │
                  │                                  ▼                 │
                  │                              awaiting_respawn      │
                  │                                  │                 │
                  │                                  │ dispatch        │
                  │                                  └─────────────────┘
                  │
                  ├─── verdict ready_for_review ──▶ ready_for_review
                  │                                       │
                  │                                       │ review_passed
                  │                                       ▼
                  │                                  reviewed
                  │                                       │
                  │                                       │ ship_op_completed (push + PR; 'auto' merges on green, head-bound)
                  │                                       ▼
                  │                                  merge_pending ── merge_confirmed ──▶ shipped (terminal)
                  │                                       │        (RepoHost: PR merged to recorded base
                  │                                       │         at the reviewed head SHA)
                  │                                       │
                  │                                       ├─── head_drift ──▶ ready_for_review
                  │                                       │    (new head re-verifies; dual-host re-reviews,
                  │                                       │     single-host CLI-only — §Single-host mode)
                  │                                       │
                  │                                       └─── pr_closed_unmerged / probe_or_policy_loss
                  │                                            ──▶ blocked_on_question (park)
                  │
                  ├─── lease_expired (no heartbeat) ──▶ abandoned ──┐
                  │                                                  │
                  ├─── cancel ──▶ cancelled (terminal)              │
                  │                                                  │
                  └─── retries_exhausted ──▶ failed (terminal)      │
                                                                     │
                  ┌──────────────────────────────────────────────────┘
                  │
                  ▼
              unclaimed (steal-after-expiry; new attempt)
```

A task's persistent state lives at `.forge/orchestrator/tasks/<task_id>/state.json`. State transitions go through `forge orchestrate <verb>`, which validates the proposed transition against this state machine and rejects illegal moves with a typed error.

### Attempt state (scoped to a single dispatch)

```
                  ┌──────────┐
                  │ dispatched│
                  └─────┬─────┘
                        │ first heartbeat
                        ▼
                  ┌──────────┐
                  │ running  │
                  └─────┬────┘
                        │
        ┌───────────────┼──────────────────────────┐
        │               │                           │
  blocked_on        completed                  abandoned
  question        (verdict written)        (lease expired
        │               │                    or worker died)
        │ answer        │ CLI verifies
        │ recorded      │ verdict, marks
        │               │ attempt terminal
        ▼               ▼
   awaiting_         finalized                     │
   respawn          (terminal)                     │
        │                                          │
        └──────────────────────────────────────────┘
                        │
                  next dispatch
                  creates new attempt
```

Each attempt is identified by `attempt_id` (UUIDv7). Attempts are immutable once terminal — a respawned worker is a *new* attempt with its own metadata, lease, event log, and verdict file. Prior attempts' artifacts are preserved as historical context.

### Run state

A "run" is a single supervisor session — a contiguous slice of work driven from one main Claude Code or Codex window. Each main session calls `forge orchestrate run start` at boot, recording its `run_id` for use in subsequent commands. Multiple runs coexist: each claims tasks independently against the tracker.

Run lifecycle is light: `active` (heartbeating) → `quiesced` (no active workers) → `archived` (gc'd after retention window). The CLI tracks runs to scope ownership of leases and to bound gc behavior.

## Lease semantics

Every claim is backed by a **lease** with explicit expiry, heartbeat, and steal-after-expiry semantics. Leases solve the "abandoned claim" problem: laptop sleep, parent shell death, worker hang, OOM.

### Lease record

```ts
type Lease = {
  claim_id: string;          // UUIDv7
  task_id: string;
  attempt_id: string | null; // null until first dispatch
  owner_run_id: string;
  acquired_at: string;       // ISO 8601
  expires_at: string;        // ISO 8601 — acquired_at + lease_ttl_ms
  last_heartbeat_at: string; // updated on `forge orchestrate heartbeat`
  generation: number;        // incremented on steal — for fencing
};
```

Stored at `.forge/orchestrator/tasks/<task_id>/lease.json`. Only one lease per task at a time; a concurrent acquire loses with `LEASE_EXISTS`.

**FORGE-231 — the lease file joins the CAS protocol.** The record gains a monotonic **`lease_version`** (+1 on EVERY mutation, heartbeat renewals included), and after its first acquisition the file is NEVER deleted: `release` writes a **tombstone** (`{status: 'released', lease_version, last_generation, …}`) so the version and generation sequences survive ownership cycles. ALL FOUR mutators — acquire, heartbeat, release, steal — commit through `casGuardedWrite` on `lease_version` (O_EXCL transition marker, mandatory post-acquire revalidation, conservative no-takeover recovery), which makes every lease write single-committer: a stale heartbeat can never resurrect an old generation over a published successor, and the pre-FORGE-231 unlink→link replacement window no longer exists. Re-acquire after release continues `generation` from the tombstone's `last_generation`; an ABSENT file with claim history is a legacy (pre-FORGE-231 / admin-released) state whose next generation derives from claim history — generation NEVER resets.

**Steal is a two-file protocol (reserve state, then fence lease, then publish):** the stealer (1) observes the target lease expired past grace, (2) RESERVES the task-state transition by acquiring the state file's CAS marker — a held marker (a paused writer) ABORTS the steal entirely, publishing nothing, (3) acquires the lease marker and re-verifies expiry post-acquire, (4) publishes the successor lease (`generation+1`, `lease_version+1`), (5) commits `state.json = unclaimed` under the reserved state marker. Lock order is **STATE before LEASE** for every path taking both (steal; complete's finish path) — single-marker takers (heartbeat, release, gc) take only the lease marker — so no lock cycle exists. Every crash window leaves a stuck marker that conservatively BLOCKS its one transition (and further steals) until gc's report-guided manual remediation; no window admits a second committer or a generation rollback.

### Defaults

| Setting | Default | Configurable in |
|---|---|---|
| `lease_ttl_ms` | 30 min (1,800,000 ms) | `.forge/settings.yaml` → `agents.lease_ttl_ms` |
| `heartbeat_interval_ms` | 5 min (300,000 ms) — workers heartbeat every 5 min; dispatch layer reminds via prompt | `.forge/settings.yaml` → `agents.heartbeat_interval_ms` |
| `steal_grace_ms` | 5 min past expiry before steal is allowed | `.forge/settings.yaml` → `agents.steal_grace_ms` |

### Steal-after-expiry

`forge orchestrate claim` is the only operation that can steal an expired lease:

1. Read existing lease record (if any).
2. If `now > expires_at + steal_grace_ms`: increment `generation`, write a new lease atomically (tmp+link with new `claim_id`). Old `generation` is now fenced.
3. The original worker's next CLI call (heartbeat, question, complete) will see `generation` has advanced and fail with `LEASE_STOLEN`. That worker is expected to detect the failure, write a final event (`attempt_abandoned_by_steal`), and exit cleanly.
4. The new claimer dispatches a fresh attempt that reads the prior attempt's event log + git state.

This is the safe-by-construction equivalent of distributed locking with TTLs: explicit, observable, idempotent.

### Heartbeat

Workers heartbeat every `heartbeat_interval_ms` via `forge orchestrate heartbeat`. The CLI:
- Validates the lease still belongs to the caller's `(run_id, claim_id, generation)`.
- Updates `last_heartbeat_at` and extends `expires_at = now + lease_ttl_ms`.
- Returns the current lease for caller verification.

If a worker fails to heartbeat, `lease_ttl_ms` elapses and the lease becomes steal-eligible. The skill dispatch layer is responsible for reminding the worker subagent to heartbeat (via the worker prompt template). Workers that can't heartbeat (e.g., blocked on a long shell command) are at risk of having their lease stolen mid-flight; this is acceptable because (a) stolen leases produce a `LEASE_STOLEN` error rather than silent data corruption, and (b) the prior attempt's work is preserved in the worktree's git state.

## Filesystem layout

State is **task-keyed**, not run-keyed. Task is the coordination object; run is metadata.

```
.forge/
├── settings.yaml                         # config (loaded on each CLI invocation)
├── logs/
│   └── orchestrate.jsonl                 # global event log (append-only, rotated at 100MB)
├── orchestrator/
│   ├── runs/
│   │   └── <run_id>/                     # one directory per supervisor session
│   │       ├── manifest.json             # run metadata: started_at, host, agent_id
│   │       └── notifications.jsonl       # per-run notification stream (consumed by skill)
│   └── tasks/
│       └── <task_id>/                    # one directory per task across all runs
│           ├── state.json                # current task state (see state machine)
│           ├── lease.json                # current lease (atomic write, one at a time)
│           ├── claim-history.jsonl       # append-only log of claims, steals, releases
│           └── attempts/
│               └── <attempt_id>/         # one directory per attempt
│                   ├── manifest.json     # { run_id, claim_id, generation, dispatched_at }
│                   ├── events.jsonl      # append-only event log (replaces save-point.md)
│                   ├── save-point.md     # narrative context (optional, advisory)
│                   ├── questions/
│                   │   └── <question_id>.json        # atomic, never overwritten
│                   ├── answers/
│                   │   └── <question_id>.json        # atomic, never overwritten
│                   ├── verdict.json      # worker's self-reported verdict
│                   ├── verdict.verified.json  # CLI-computed verification of verdict
│                   └── logs/
│                       ├── stdout.log
│                       └── stderr.log
└── worktrees/                            # one worktree per task (not per attempt)
    └── <sanitized-task-id>/
```

### Why task-keyed, not run-keyed

Codex v2 review identified that run-keyed state creates split brain between tracker truth (cross-run) and local artifacts (per-run). With task-keyed layout:
- Tracker, state machine, lease, and on-disk attempts all key off `task_id` and stay consistent.
- `run_id` is metadata stored *inside* per-attempt manifests, used for ownership checks and observability.
- Cross-run aggregation (`forge orchestrate status` from any main) reads the same files.
- gc operates on tasks, not runs.

### Why worktree-per-task, not per-attempt

A respawned worker after a blocked-question continues the prior worker's in-progress code. That's the **feature**: workers ask architectural questions mid-flight, and the answered worker picks up where the prior left off. Codex v2 framed this as "contaminated git state"; for forge's workflow it is intentional continuity. The new attempt reads the prior attempt's `save-point.md` and `events.jsonl` for narrative context, and `git log` + working-tree state for code-level orientation.

Edge case: if the prior attempt was cancelled mid-edit and the worktree is in an unusable state (e.g., merge conflict markers from an aborted rebase), the new attempt's first event is `worktree_inspected` and it can choose to `git reset --hard` to recover. The worker prompt instructs this explicitly.

### File semantics

| Property | Rule |
|---|---|
| Atomicity | Never-overwritten files (question, answer, manifest, verdict) go to a uniquely-named `.tmp` sibling, `fsync`, then `link(tmp, target)` followed by `unlink(tmp)` — `link` fails with `EEXIST`, giving OS-level enforcement of the "never overwritten" invariant; concurrent writers reject all but one with `DUPLICATE_ID`. CAS-GUARDED files (`state.json`, `lease.json`, `ship-record.json` — FORGE-231) instead commit through the version-marker protocol: O_EXCL transition marker, post-acquire revalidation, then a DURABLE rename (`fsync` tmp + rename + `fsync` dir) — overwriting is exactly the point, and the marker (not `link`) provides the single-committer guarantee. Requires `.forge/` on a local POSIX filesystem. |
| Idempotence | Question, answer, and manifest files are never overwritten — a second write with the same id is a bug; the CLI rejects it. Verdict files (FORGE-231) are **semantically idempotent** instead: a wx collision with an existing artifact whose IDENTITY fields (verdict value, pinned `target_sha`) match the intended write is a crash-replay — the existing file stays canonical and completion continues; DIFFERENT content is a real collision and still rejects. |
| Schema versioning | Every JSON document includes a `version` field. Readers warn-and-skip on unknown versions; they never crash. |
| Untrusted input | Question/answer file contents may originate from compromised workers. The CLI validates every read against the zod schema with strict size caps (default 64KB per file). |
| Cleanup | All cleanup is gated through `forge orchestrate gc` (see "gc reconciliation rules"). No background reaper. |

**Durability contract.** `fsync(fd)` before `link` protects readers from torn writes under crash-free I/O. It is **not** a power-loss-durability guarantee for the placement: after `link(tmp, target)` returns, a sudden host crash before the parent directory's dirent is persisted can lose the placement. We deliberately do not `fsync` the parent directory on every write — the CLI reconciles state from the tracker + filesystem on every `gc` pass, so a lost placement degrades to "the gc reports a divergence and offers a resolution," not data corruption. Adopters with stricter durability requirements should mount `.forge/` on a journaled filesystem (ext4 `data=journal`, ZFS, APFS with `sync` mount). See `docs/learnings/2026-Q2/link-vs-rename-for-never-overwrite-invariant.md`.

## Hydration

When `forge orchestrate ensure-worktree` creates a new worktree, it populates the worktree's filesystem from two distinct sources. The split is load-bearing — conflating them produces silent HEAD/working-tree divergence on tracked files (see FORGE-136).

| File class | Source | Mechanism |
|---|---|---|
| **Tracked files** (anything reported by `git ls-files` — `CLAUDE.md`, `CRITICAL.md`, `spec/*.md`, `plans/phases.yaml`, `src/**`, `test/**`, `package.json`, …) | `base` ref — `origin/<resolved default branch>`. Default-branch resolution is **host-independent git** (`git ls-remote --symref origin HEAD` first — authoritative remote truth, catches a same-remote default change even when the local `origin/HEAD` ref is stale; fallback local `git symbolic-ref refs/remotes/origin/HEAD`; last resort the fingerprint-matched persisted cache) so it works on every remote type — no RepoHost required; it runs **before** worktree creation and is persisted, and the RepoHost consumes the same persisted value later for the PR base (ADR `orchestrator-ship-auto-merge`; literal `origin/main` wherever the resolved default is `main`) | `git worktree add -b <branch> <path> <base>` |
| **Untracked project meta** under the hydration roots (canonically: `plans/tasks/*.plan.md`, `docs/learnings/**`, `.forge/settings.yaml` — all gitignored in forge's own layout, plus any other untracked files under those roots) | Local main checkout's **working tree** | Filesystem copy in `workspace.create()` after a `git ls-files` filter drops tracked entries from the plan |

**Rationale.** Tracked files belong to git: they have a HEAD and any deviation from HEAD is a real modification a worker is expected to commit. The hydration loop must NEVER touch them — `git worktree add` already places the correct content from `base`, and overwriting that content from main's filesystem creates a spurious diff whenever `base` resolves to a different revision than local main (e.g., `base=origin/main` while local main lags). The pre-FORGE-136 code copied `CLAUDE.md`, `CRITICAL.md`, `spec/*.md`, and `plans/*` from main's working tree on top of the `git worktree add` checkout, manifesting as phantom modifications immediately after worktree creation when local main and `base` resolved to different revisions for those files.

**Hydration roots.** The plan walks `spec/`, `plans/`, `docs/learnings/`, and the single file `.forge/settings.yaml`. Within each root, ANY entry reported by `git ls-files` is filtered out at plan time — only **untracked** files survive into the copy phase. The walk still runs (so the symlink-rejection defense fires on every candidate), but tracked entries never reach `copyFileSync`. In forge's own repository layout this untracked set IS the gitignored set (per `/plans/tasks/*.plan.md`, `/docs/learnings/**`, `/.forge/` in `.gitignore`); adopters with looser gitignores should be aware that the filter discriminates on tracked-vs-untracked, not on gitignored-vs-not.

**Untracked project meta** does not live in git, so a fresh worktree's working tree would otherwise be empty for `plans/tasks/*.plan.md`, `docs/learnings/**`, and `.forge/settings.yaml`. These are the user's authoritative in-flight work — workers need them to read pending plans, accumulated learnings, and current settings — so hydration copies them from main's working tree filesystem at the moment of worktree creation. Re-hydration is not supported; on `forge orchestrate ensure-worktree` against an existing marker the verb returns `{created: false}` and leaves the worktree untouched.

**Symlinks are rejected.** `workspace.create()` `lstat`s every source before copying and throws `SYMLINK_REJECTED` if any entry under the hydration roots is a symbolic link. This defends against a hostile or misconfigured main checkout pointing `.forge/settings.yaml` (or any other hydration candidate) at `/etc/passwd`.

**Manifest.** Every hydrated file is recorded in `<worktree>/.forge/copied-from-main.json`. `cleanup()` uses this manifest to allow-list files for removal on `gc` — only files originally hydrated are eligible for cleanup; any other gitignored file produced by the worker triggers `GITIGNORED_LOSS` and refuses cleanup without `--force`.

## Event types

Three distinct event streams:

### 1. Attempt event log — `events.jsonl` per attempt

Append-only, structured, machine-readable. Replaces the prose `save-point.md` as the authoritative record of attempt progress. Save-point.md remains for narrative context only.

```ts
type AttemptEvent =
  | { type: 'attempt_started'; ts: string; attempt_id: string; run_id: string; claim_id: string; generation: number }
  | { type: 'worktree_inspected'; ts: string; head_sha: string; dirty: boolean; conflicts: boolean }
  | { type: 'heartbeat'; ts: string; lease_expires_at: string }
  | { type: 'files_modified'; ts: string; files: string[] }
  | { type: 'tests_run'; ts: string; passed: number; failed: number; skipped: number; duration_ms: number; output_excerpt: string }
  | { type: 'lint_run'; ts: string; clean: boolean; violations: number; output_excerpt: string }
  | { type: 'commit'; ts: string; sha: string; message_excerpt: string }
  | { type: 'question_written'; ts: string; question_id: string; decision_key: string }
  | { type: 'answer_observed'; ts: string; question_id: string }
  | { type: 'attempt_completed'; ts: string; verdict: 'ready_for_review' | 'changes_needed' | 'blocked' }
  | { type: 'attempt_cancelled'; ts: string; reason: string }
  | { type: 'attempt_abandoned_by_steal'; ts: string; new_generation: number }
  | { type: 'lease_stolen'; ts: string; from_generation: number; to_generation: number };
```

The CLI writes these as side effects of its verbs (`dispatch`, `heartbeat`, `question`, `complete`, etc.). Workers can append events directly via `forge orchestrate event` for steps the CLI can't observe (e.g., a long shell sequence the worker wants to checkpoint).

### 2. Per-run notification stream — `notifications.jsonl`

Filtered events surfaced to the supervisor's main session. The dispatch skill tails this file. **Deliberately narrow** — only events that demand human attention.

```ts
type NotificationEvent =                       // every variant carries `id` (FORGE-231):
  | { type: 'question'; id?: string; ts: string; run_id: string; task_id: string; question_id: string; decision_key: string; attempt: number; question: string; context: string; options: Option[]; recommended_option_id?: string; what_happens_if_unanswered?: string }
  | { type: 'question_resolved'; id?: string; ts: string; run_id: string; task_id: string; question_id: string; resolution: 'answered' | 'expired' | 'budget_exhausted' | 'duplicate'; answer_option_id?: string }
  | { type: 'ready_for_review'; id?: string; ts: string; run_id: string; task_id: string; state_version: number }
  | { type: 'merge_pending'; id?: string; ts: string; run_id: string; task_id: string; state_version: number; pr_url: string; auto_merge: boolean }  // ship op done: PR open; auto_merge=true when merge_policy 'auto' (forge merges on green, head-bound — ADR orchestrator-ship-auto-merge)
  | { type: 'shipped'; id?: string; ts: string; run_id: string; task_id: string; state_version: number; pr_url: string }  // emitted ONLY on RepoHost-confirmed merge-to-base at the reviewed head SHA
  | { type: 'fatal'; id?: string; ts: string; reason: string; details?: Record<string, unknown> };
```

`id` is computed by the SINGLE append helper, never by producers: progress events use the time-free natural key `<task_id>:<state_version>:<type>` (the state CAS makes `state_version` unique per transition), question events `<task_id>:<question_id>:<type>`, fatal `<task_id ?? run_id>:<epoch-ms>:fatal`. It is optional on the READ union so legacy files parse; required at write time. Readers (attach) dedup on it.

**Loss semantics (FORGE-231, owner decision NL):** the three PROGRESS events (`ready_for_review`, `merge_pending`, `shipped`) are **advisory** — emission runs strictly AFTER the task-state CAS, a crash in that window loses the event permanently, and this is accepted; authoritative discovery is state-derived listing (`review-queue` for ready_for_review, `status`/`dashboard` for merge_pending). `fatal` and `question` events keep their durable semantics — questions are durable files + queues; this stream only announces them.

Operational events (heartbeats, commits, intermediate progress) never appear here. They go to `events.jsonl` per attempt and to the global `orchestrate.jsonl`.

### 3. Global event log — `orchestrate.jsonl`

Append-only structured JSONL with every CLI verb invocation, every state transition, every error. Rotated at 100 MB. Read by `forge orchestrate status` for snapshot aggregation and by `forge orchestrate gc` for reconciliation.

## Tracker atomic claim — per-adapter capability matrix

Codex v2 review correctly flagged that GitHub and Notion don't have natural compare-and-set primitives. Codex v3 introspection (2026-05-15, confirmed against `@linear/sdk@84.0.0`) further established that Linear also has no CAS primitive — `IssueUpdate` exposes no `expectedVersion`/`expectedRevision`/`ifMatch` field, and `Issue` has no `version`/`revision`/`etag`/`sequence` read field. **All three trackers are therefore in the weak-CAS posture.** The honest design is layered:

- **Local lease is authoritative within the working window** (`lease_ttl_ms` default 30 min). All concurrency safety inside a run derives from the local lease, not the tracker.
- **Tracker is the cross-run rendezvous point.** Multiple mains discover ready tasks by reading the tracker. The first to claim wins via best-available tracker semantics; the loser retries.
- **Race losers are handled gracefully.** Two mains claiming the same task at the same instant both write a tentative tracker label; one detects the conflict on read-back and releases. Worst case: one wasted tracker round-trip per race.

### Per-tracker mechanism

| Tracker | Authoritative atomicity | Mechanism | Race-loss detection |
|---|---|---|---|
| **Linear** | **Weak — best-effort label-CAS + verify-on-readback** | Two-step claim: (1) add `forge:claimed-by:<run_id>` via `IssueUpdate` with `addedLabelIds` (the append-only field) — or equivalently the dedicated `issueAddLabel(id, labelId)` mutation. **MUST NOT** use `IssueUpdateInput.labelIds` — that field is a full-list replacement and would clobber user-applied labels on every claim. (2) Re-fetch via `IssueQuery` and verify our label is present AND no other `forge:claimed-by:*` label is present. | Race loser sees another `forge:claimed-by:*` label, removes its own via `removedLabelIds` or `issueRemoveLabel`, drops the task. Race window: bounded by the local lease (same posture as GitHubTracker). |
| **GitHub Issues** | **Weak — best-effort label-CAS** | Two-step claim: (1) add label `forge:claimed-by:<run_id>` via `gh issue edit --add-label`; (2) immediately re-fetch via `gh issue view --json labels` and verify our label is present *and* no other `forge:claimed-by:*` label is present. Both checks must pass. | Race loser sees another `forge:claimed-by:*` label, removes its own label, drops the task. Race window: ~200ms between add and re-fetch. Acceptable because the local lease prevents same-host concurrent dispatch. |
| **Notion** | **Weak — race-detect-only** | Set `forge_claimed_by` page property to `<run_id>`, then re-fetch the page and verify `last_edited_time` matches our write. | If `last_edited_time` advanced past our write, another writer raced us. Race loser clears its claim and drops the task. |

**For all three trackers**, the documented stance is: **the local lease is the ownership truth within a working window; the tracker is the eventually-consistent rendezvous point.** This is good enough because:
1. The worker is already serialized within a run by the local lease.
2. The only failure mode is "two mains briefly both think they own task T; both dispatch; second commit conflicts at PR time" — recoverable.
3. The merge-to-main-between-phases policy (see "Branch/PR topology") ensures conflicts surface at PR time, not at merge time on main.

Adapter implementation lives in `src/trackers/<adapter>.ts` and exposes a common interface:

```ts
type ClaimResult =
  | { ok: true; tracker_version?: string }
  | { ok: false; reason: 'already_claimed' | 'version_conflict' | 'transient_error'; detail?: string };

interface Tracker {
  // ... existing methods from spec/SPEC.md ...
  claim(issueId: string, runId: string): Promise<ClaimResult>;
  releaseClaim(issueId: string, runId: string): Promise<void>;
}
```

## gc reconciliation rules

`forge orchestrate gc` is the deterministic reconciler. Every read-band CLI invocation may *detect* divergences from the cheap-row subset and emit warnings to stderr; only an explicit `forge orchestrate gc` *mutates* state. `forge orchestrate gc --dry-run` plans without changing anything. The rules below are exhaustive — every state divergence has a defined resolution.

### Divergence table

| Local state | Tracker state | Resolution |
|---|---|---|
| `running` | `done` / `cancelled` / closed | Mark local `cancelled` — never `shipped` from tracker status alone (tracker state is not merge proof; only RepoHost confirmation establishes `shipped` — ADR `orchestrator-ship-auto-merge`); release lease; archive attempt; preserve worktree for inspection (gc with `--remove-worktrees` to delete) |
| `running` | no claim or claim by different `run_id` | If lease is expired beyond `steal_grace_ms`: mark `abandoned`, release lease. If lease still valid: keep local truth, log warning (tracker is the diverged party). |
| `claimed` (local) | not claimed (tracker) | Re-attempt tracker claim once; if fails, mark local `unclaimed`, release lease. |
| no local state | tracker claimed by *us* | Recover: write `state.json` and `lease.json` from tracker metadata. (Happens after `.forge/orchestrator/` wipe.) |
| `blocked_on_question` | any | Check `.forge/orchestrator/tasks/<t>/attempts/<a>/answers/`. If answer exists, mark `awaiting_respawn`. If not and `attempt_started + question_timeout_ms` elapsed, mark `expired`. |
| `ready_for_review` (local) | `done` (tracker) | Report divergence + park with a question — do **not** mark `shipped` (tracker `done` — even a closed GitHub issue — cannot prove that a specific PR merged to the recorded base at the reviewed head SHA). If the operator confirms an out-of-band manual merge, gc resolves via RepoHost confirmation → `shipped`, else `cancelled` with a note. |
| `shipped` | not closed | Confirm via RepoHost + PR record: if merged at the reviewed head SHA, transition tracker to done. If NOT merged, local `shipped` is corrupt — park with a question (never re-open/re-merge silently). |
| `merge_pending` | any | Probe via RepoHost + PR record. Merged to recorded base at the reviewed head SHA → `shipped`; update tracker; emit `shipped` notification. Merged with `mergedHeadSha != reviewed_head_sha` (tainted — external merge; forge's own call is head-bound) → park with **fatal** notification + revert guidance; never `shipped`. PR closed without merge / honesty-probe or policy loss → park with a question (answer → `reviewed` for re-ship, or `cancelled`); the next tick must NOT silently recreate the PR or retry the merge. Head SHA drifted → regress to `ready_for_review` — the new head re-enters verify + re-review (dual-host: cross-host review; single-host: CLI re-verification refreshes `reviewed_head_sha` — §Single-host mode). |
| Verdict file exists but `verdict.verified.json` missing | n/a | Re-run CLI verification; write `verdict.verified.json`. |
| Branch exists in repo | worktree missing | If task `shipped`: prune. If task `unclaimed` or terminal: prompt user with `--dry-run` output before pruning. |
| Worktree exists | no task with matching ID in `phases.yaml` | Orphan; report. `gc --remove-orphan-worktrees` to delete. |
| Question file exists | attempt is terminal | Archive the question under `attempts/<a>/archived/`. |
| Answer file exists | question file is missing | Log warning; archive. (Shouldn't happen.) |
| Multiple leases for same task | n/a | Only most recent `generation` is authoritative. Older NON-CANONICAL duplicate artifacts (e.g. `lease.json.bak`) are unlinked; a stale identity at the CANONICAL path is released by writing a tombstone through the CAS protocol (the canonical file is never deleted — FORGE-231). |
| Lease present | task state is terminal | Release lease. |
| `merge_pending` + canonical lease expired beyond grace | n/a | Identity-checked lease release (row 15 — FORGE-231): `complete` releases the worker lease right after entering `merge_pending`; a crash in that window leaves a lease with no heartbeat source. Task STATE untouched — the merge_pending probing rows (FORGE-234) own state resolution. |
| Incomplete CAS transition marker present (state/lease/ship-record) | n/a | REPORT ONLY (row 16 — FORGE-231, conservative no-takeover): gc never removes an incomplete marker. The report carries the ownership tuple, lease expiry, run-manifest liveness and PID liveness AS A HINT (PID reuse is possible); the operator confirms the owning run is dead, then removes the marker manually. Completed markers (file version advanced past them) are cleaned automatically. |

### `--dry-run` output

```
$ forge orchestrate gc --dry-run
gc plan (no changes will be made):

  task            local       tracker     action
  ─────────────   ─────────   ─────────   ────────────────────────
  FORGE-31        shipped     done        archive attempt, prune worktree
  FORGE-32        running     unclaimed   mark abandoned (lease expired 47m ago)
  FORGE-99        n/a         n/a         orphan worktree at .forge/worktrees/forge-99 (orphan)
  FORGE-103       running     done        mark cancelled (tracker closed ≠ merge proof), archive attempt, keep worktree

4 actions queued. Re-run without --dry-run to apply.
```

### Auto-gc

A lightweight reconcile **detects** the cheap rows (lease expiry, blocked_on_question state-file checks, verdict-file integrity, question/answer orphans, duplicate or terminal-state leases) on every `forge orchestrate phases --ready` and `forge orchestrate status` invocation; warnings go to stderr with the form `[gc] <task>: row <N> (<action>) — run \`forge orchestrate gc\` to apply`. Read-band verbs **never mutate** — operator runs `forge orchestrate gc` to apply. Tracker-dependent rows (state alignment vs. tracker) and expensive operations (branch/worktree scans) only run in explicit `gc`.

## Worker prompt template

Every worker subagent is dispatched with `templates/worker-prompt.template.md` as the system/user prompt, with placeholders rendered by `src/orchestrator/render-worker-prompt.ts` and the rendered string passed to the host's subagent primitive by the dispatch skill (P2.5-T07 / FORGE-98).

### Authority by field — binding contract

When two artifacts seem to disagree, the worker asks **"whose field is this?"** — not "which artifact ranks higher?" Ownership is a matrix:

| Artifact | Owns |
|---|---|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria |
| `plans/phases.yaml` | Local execution snapshot (derived from tracker) |
| Tracker issue body | Execution metadata: assignee, status, sequencing, live coordination |
| Source code | Implementation |

A "disagreement" between artifacts often isn't one — it's two artifacts each owning a different field of the same decision. The template carries 5 worked examples covering the common shapes (false-collision, real-collision, stale-snapshot, narrower-vs-wider, code-out-of-date).

### Disagreement protocol

When the matrix is unclear, the worker writes a standard question via the existing `forge orchestrate question` verb with `decision-key: authority-collision:<field>:<short-slug>` and pauses. The supervisor resolves via `/answer` as for any other open question.

### On-resume informational block

The dispatch skill emits an informational `SPEC changed since claim — N commits` block on worker resume (powered by `forge orchestrate spec-diff <task>`, P2.5-T18 / FORGE-114). The worker treats it as informational and proceeds unless the diff conflicts with current scope, in which case it writes a question.

**Push-time half (FORGE-164).** `forge orchestrate spec-diff --all-active` enumerates every task in an ACTIVE state (`dispatched` | `running` | `blocked_on_question`) whose claim `spec_revision` predates a `spec/` change, emitting `{ task_id, commit_count, files_affected, lease_expired }[]`. Corrupt/missing state or lease → skip with a stderr note (never fails the listing); an expired lease is still listed with `lease_expired: true` (the stale claim is exactly the signal); no-diff tasks are omitted; it always exits 0. `/ship` runs the single-task form between its preflight and gates and, when non-null, adds an informational `### ⚠ SPEC changes since this task was claimed` PR-body section (it never blocks the ship). This is the mechanism-not-policy push-time complement to the on-resume pull-time block above — together they close both halves of the FORGE-114 SPEC-drift mitigation.

### phases.yaml freshness

CLI verbs that read `phases.yaml` print a freshness line on stderr (P2.5-T17 / FORGE-113). If the snapshot is > 24h old, the worker treats phases.yaml as advisory and asks before relying on it for scope. Tracker is the source of truth.

### Host portability

The template carries host-conditional blocks via the markers `<!-- host: claude -->...<!-- /host -->` and `<!-- host: codex -->...<!-- /host -->`. The renderer strips other-host blocks before the prompt reaches the host. The worker never sees instructions intended for another host.

### Heartbeat protocol

The worker calls `forge orchestrate heartbeat <task> --attempt <attempt>` every ~5 minutes. On `LEASE_STOLEN`, it emits an `attempt_abandoned_by_steal` event and returns to the parent.

### Decision guidelines — the 70/30 rule

Tactical decisions (~70%) — variable names, helper extraction, comment placement, regex specifics, test naming, log verbosity within documented ranges — the worker decides itself and logs via `forge orchestrate event --type files_modified`.

Architectural decisions (~30%) — exported symbol names, schema shapes consumed downstream, file paths intended for import by other modules, deprecation strategies, irreversible migration approaches, scope, error semantics across module boundaries — the worker escalates via `forge orchestrate question`.

### Structured classification rubric

Before any question, the worker classifies:

```json
{
  "decision_type": "routine" | "architectural",
  "category": "public_api" | "scope" | "naming" | "deprecation" | "error_semantics" | "file_lifecycle" | "schema_shape" | "compat_policy" | "enforcement_mode" | "scope_cut" | "provider_choice" | "release" | "security_tradeoff" | "other",
  "reversibility": "low" | "medium" | "high",
  "blast_radius": "local" | "module" | "project" | "external",
  "default_action": "decide" | "ask",
  "reason": "<1-2 sentences>"
}
```

`routine` → log a `files_modified` event and proceed. `architectural` → write a question.

`category` is a single union of two taxonomies that share one field so `/inbox`
and the statusline can group by one key (FORGE-216, additive — every prior value
still parses, no migration). Pick the BEST-FIT value:

- **Code-shaped decisions:** `public_api` (exported symbol surface), `scope`
  (what's in/out of the task), `naming`, `deprecation`, `error_semantics` (error
  contracts across module boundaries), `file_lifecycle` (file paths intended for
  import).
- **Delivery decisions:** `schema_shape` (schema forks / field shape consumed
  downstream), `compat_policy` (back-compat / migration / deprecation strategy),
  `enforcement_mode` (advisory vs enforced), `scope_cut` (defer vs build now),
  `provider_choice` (adapter / host / provider picks), `release` (versioning /
  release sequencing), `security_tradeoff` (security calls).
- `other` is the fallback when nothing fits.

Producers carry the classification into the question via
`forge orchestrate question … --classification-file <path>` (a
`DecisionClassification` JSON). Without it the verb defaults to
`category: "other"`. Every escalated question SHOULD also carry
options-with-tradeoffs, a `--recommended-option-id`, and
`--what-happens-if-unanswered`.

### Template placeholders (allowlisted)

The renderer accepts only this set; unknown tokens throw at render time (no silent expansion):

`{{TASK_ID}}`, `{{ATTEMPT_ID}}`, `{{RUN_ID}}`, `{{WORKTREE_PATH}}`, `{{PHASE}}`, `{{TASK_DESCRIPTION}}`, `{{ACCEPTANCE_CRITERIA}}`, `{{CONVENTIONS}}`, `{{PRIOR_ATTEMPTS}}`, `{{ANSWERED_QUESTIONS}}`.

### Verdict schema

```ts
type Verdict = {
  version: 1;
  verdict: 'ready_for_review' | 'changes_needed' | 'blocked';
  summary: string;
  tests: {
    ran: boolean;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
    output_excerpt: string;  // last 2KB
  };
  lint: {
    ran: boolean;
    clean: boolean;
    violations: number;
    output_excerpt: string;
  };
  branch: string;            // git branch the worker is on
  save_point: string;        // narrative note
};
```

### CLI verification of verdicts

`forge orchestrate complete` does not trust the worker's self-report. It independently computes:

| Verdict field | CLI verification |
|---|---|
| `branch` | `git -C <worktree> rev-parse --abbrev-ref HEAD` |
| `tests.ran/passed/failed` | Re-run the project's test command (`npm test` or detected equivalent) with a short timeout; record actual results. If worker's self-report disagrees, the attempt is marked `verdict_unverified` and the worker stays in `running` state to retry. |
| `lint.clean` | Re-run lint; record actual results. |
| `diff_stats` (computed, not worker-reported) | `git diff --stat <base>...HEAD` |
| `conflicts_with_base` (computed) | `git merge-tree --write-tree $(git merge-base HEAD <base>) HEAD <base>` — non-zero exit indicates conflicts. |
| `files_changed` (computed) | `git diff --name-only <base>...HEAD` |

The verified record is written to `verdict.verified.json`. Only after verification does the task state transition to `ready_for_review`. Worker self-reports are kept as historical context in `verdict.json` but are never authoritative.

### Preflight wrapper — `forge orchestrate guardrail-check`

Forge cannot mechanically intercept the host's file-write tools (no PreToolUse hook into Claude Task subagents or Codex native subagents). Preflight is therefore **prompt-discipline + verb side-effects** in v0.4, with **post-hoc audit deferred** to a follow-up release:

1. The worker prompt instructs every worker to call `forge orchestrate guardrail-check --path <p>` before any write.
2. The verb reads `.forge/settings.yaml#agents.preflight_globs` (default list below), realpaths the target (rejecting symlinks that escape the repo), matches the proposed path, and returns `{architectural, matched_glob, suggested_decision_key}`.
3. When `--task` + `--attempt` are supplied (and the ids pass `validateIdSegment`), the verb appends a `guardrail_checked` event to the attempt log.
4. **Post-hoc audit — deferred** (FORGE-FOLLOWUP-A): a future release will have `forge orchestrate complete` cross-reference the verdict's computed `files_changed` against the `guardrail_checked` event stream and mark `verdict_unverified` if a guardrail write occurred without a prior check. Until that ships, calling `guardrail-check` is a prompt-discipline requirement, not a mechanical one — skipping it leaves no audit record and forfeits the suggested decision-key, but does not block the attempt's `complete`.

| Glob | Rationale |
|---|---|
| `src/index.ts` | Top-level re-export surface; changes affect every consumer |
| `src/schemas/**` | Public data contracts |
| `src/bin/**` | CLI entry shape |
| `src/cli/**` | CLI command surface |
| `src/trackers/base.ts` | Tracker interface |
| The migrate command (planned for v0.5; see P3-T02) | Migration logic — adopter-facing, irreversible side effects |
| `spec/**` | Specifications |
| `CRITICAL.md`, `CLAUDE.md`, `AGENTS.md` | Project-wide rules |
| `package.json` (deps + bin fields) | Distribution surface |
| `phases.yaml` | Dependency graph |

The list lives in `.forge/settings.yaml` (`agents.preflight_globs`) so projects can tune it. Globs are matched against repo-relative paths by `src/orchestrator/glob-match.ts` (supports `**`, `*`, and literal patterns; no new dependency).

When `guardrail-check` returns `architectural: true`, the worker writes a question using the returned `suggested_decision_key` regardless of what the structured rubric returned. Guardrails compose with classification by always upgrading.

## Phase machine — IMPLEMENT → REVIEW → SHIP

Each task flows through three phases sequentially. Each phase is its own subagent dispatch in the appropriate host.

### Phase 1 — IMPLEMENT (primary host)

- Dispatch skill calls `forge orchestrate phases --ready` (read-only) to surface ready tasks for user approval, then `forge orchestrate claim` once user picks.
- Dispatch skill calls `forge orchestrate ensure-worktree` to materialize `.forge/worktrees/<sanitized-task-id>` (idempotent: existing marker with matching task_id → no-op; CLI is the sole writer of `.forge/worktrees/**` per §80-98).
- Dispatch skill calls `forge orchestrate dispatch` to register the attempt.
- Subagent runs with worker prompt + task context.
- On completion: subagent writes verdict.json, calls `forge orchestrate complete`, returns to parent.
- CLI verifies verdict. If verified `ready_for_review`, task state advances to `ready_for_review`.

### Phase 2 — REVIEW (secondary host — adversarial review)

> **Cross-host direction restricted in v0.3.0.** Only `primary=Claude, review=Codex` is supported. The reverse (`primary=Codex, review=Claude`) requires spawning `claude -p` from a Codex session, which lands in Anthropic's Agent SDK quota and violates the v2 subscription-only invariant. The Codex direction is safe because OpenAI does NOT have an equivalent Agent-SDK-vs-interactive billing split — `codex exec` invoked from a Claude session bills against the user's ChatGPT Plus subscription identically to interactive Codex usage. **Correction (2026-06-07):** the reverse direction has **no subscription-billed path** and does NOT unlock via MCP host-bridging — an earlier draft of this note wrongly assumed it would. `claude mcp serve` exposes Claude Code's *tools* (Read/Edit/Bash/LS), **not the Claude model**: an MCP-bridged Codex session calling Claude runs file operations with Codex's own tokens and never invokes the Claude model to review. Producing a Claude *model* review requires `claude -p` (metered Agent SDK credit pool from 2026-06-15) or an interactive Claude session — there is no documented way for a non-Claude host to invoke Claude model inference on the Pro/Max subscription bucket. The reverse direction (`primary=Codex, review=Claude`) is therefore available only as an **explicit opt-in, metered** feature, never subscription-billed. **FORGE-223/FORGE-224 update:** that opt-in is now wired — `review_host_cli: claude` is a supported configuration. `ClaudeHarness.runReview` shells out to `claude -p --output-format text --no-session-persistence` (Claude's default tools and default permission behavior; no permission/tool overrides), the second-opinion verb probes the `claude` CLI on PATH before dispatching, and review-compose's same-host gate enforces that the review host differs from the primary. The billing analysis above is unchanged: a Claude review is metered against the Agent SDK credit pool, not the subscription bucket — so claude review is a deliberate, opt-in cost.

- Dispatch skill detects `ready_for_review` tasks via `forge orchestrate phases --ready --phase review` (read-only listing within already-approved IMPLEMENT scope).
- Dispatch skill spawns a Codex subagent when primary is Claude (only supported direction in v0.3.0), with a review prompt that includes the worktree diff. Implementation: skill calls `codex exec --cd <worktree> --sandbox read-only` via Bash with the review prompt. This is subprocess dispatch in shape but subscription-billed in substance.
- **Review-target SHA binding (ADR `orchestrator-ship-auto-merge`; both endpoints pinned per FORGE-231):** at review dispatch the CLI records **`review_target_sha`** (the worktree HEAD at that moment) AND **`review_base_sha`** (`origin/<frozen base_branch>` resolved at the same moment) in the attempt manifest. The review prompt pins the diff to `git diff <review_base_sha>...<review_target_sha>` — two immutable SHAs, never a floating ref — so both the reviewed content AND the range it is judged against are exact, named commits. REVIEW is a first-class phase attempt: the task state stays `ready_for_review` while it runs (dispatch is a pointer-only self-loop advancing `current_attempt_id`).
- Review subagent reads `git diff <base>...<review_target_sha>`, runs the host's `/review` skill, writes `review_verdict.json` (including `target_sha`) to the same attempt directory.
- Review verdict schema:
  ```ts
  type ReviewVerdict = {
    version: 1;
    verdict: 'pass' | 'changes_requested';
    findings: { severity: 'block' | 'improvement'; path: string; line?: number; message: string }[];
    host: 'claude' | 'codex' | 'cursor' | 'gemini';
    target_sha: string; // the exact SHA reviewed (must equal the dispatch-time review_target_sha — ADR orchestrator-ship-auto-merge)
  };
  ```
  `target_sha` is REQUIRED for orchestrated review (the CLI parses the raw witness with the pinned schema variant) and OPTIONAL on the globally-shared schema so interactive `/second-opinion` and harness flows keep working unpinned (FORGE-231 schema split: `ReviewVerdictSchema` vs `PinnedReviewVerdictSchema`).
- `forge orchestrate complete --phase review` records the verdict through the **trusted policy gateway** (FORGE-231): it reads the RAW witness (`review_verdict.json`, host must equal `agents.review_host_cli`) plus the optional raw second opinion, verifies `witness.target_sha == review_target_sha == current worktree HEAD` (any mismatch fails verification — a change sneaked in between review and completion is NOT reviewed code), DERIVES critical-path status from the pinned endpoints (`git diff --name-only --no-renames <review_base_sha>...<review_target_sha>` against the tighten-only union of both endpoints' `CRITICAL.md`; **any change touching `CRITICAL.md` itself — including a rename away — is intrinsically critical**; read errors fail closed), re-runs the same pure composition the review-compose verb uses, and requires the supplied composed artifact to EQUAL the recomputation — a substituted carrier over a failing witness can never advance the task.
- On `pass`: task state advances to `reviewed`.
- On `changes_requested`: task state regresses to `awaiting_respawn` (the dispatchable respawn state — dispatch is not legal from `running`), and a new IMPLEMENT attempt is dispatched with `priorReviewFindings` injected into the prompt. The failure consumes one unit of the single total `failure_count` budget (`agents.retry_attempts`).

### Phase 3 — SHIP (primary host)

> Rewritten 2026-07-10 per ADR `orchestrator-ship-auto-merge` (FORGE-189/FORGE-230): adds the
> non-terminal `merge_pending` state, final-SHA binding, and opt-in platform-gated auto-merge.
> Implementation lands in FORGE-231…235.

- Dispatch skill detects `reviewed` tasks.
- **Dependency check before dispatch:** all `depends_on` tasks must be in state `shipped` — which per the lifecycle below means their PRs are **merged to base**. A dependency in `merge_pending` (PR open, not yet merged) defers SHIP until it merges.
- **Reviewed-SHA recording (final-SHA binding, part 1):** when REVIEW passes, the CLI (`complete --phase review`) records the **verified review target** (`verdict.target_sha`, checked against the dispatch-time `review_target_sha` and the current worktree HEAD — see Phase 2) as **`reviewed_head_sha`** — CLI-owned, immutable for the attempt, persisted in the ship record (below). This is the ONLY SHA the ship operation may ship. (Single-host mode records the CLI-verified IMPLEMENT head instead — see §Single-host mode.)
- **The ship operation** (idempotent + crash-safe; FORGE-234): (1) **write-ahead**: persist/refresh the durable **ship record** at `.forge/orchestrator/tasks/<task_id>/ship-record.json` (reviewed_head_sha, resolved base repo + base branch, then per-side-effect: PR id/URL, merge-attempt status) — the record is written **before** each external side effect and reconciled idempotently after it, so a crash between push, PR-create, and merge recovers via create-or-get; (2) re-run `settings.verify` in the task worktree; (3) verify the local head equals `reviewed_head_sha` — any post-review change (rebase-on-drift, `update-branch`, conflict resolution, third-party push) produces a new SHA that must re-enter verify + re-review before shipping proceeds (dual-host: cross-host review; single-host: CLI re-verification — §Single-host mode); (4) final secrets scan; (5) push; (6) create-or-get the PR via the RepoHost; (7) mark tracker `in_review`. **Forge creates NO standing auto-merge enablement** (`gh pr merge --auto`): GitHub's persisted auto-merge request cannot hold an expected head SHA, and GitHub auto-disables it only for pushes by users *without* write permission — a write-capable push after enablement could therefore merge unreviewed code. The merge is instead the atomic, head-bound step below.
- On success: task state advances to **`merge_pending`** (non-terminal). Notification `merge_pending` event emitted (`auto_merge: true|false` — true when `ship.merge_policy: 'auto'`, i.e. forge will execute the head-bound merge on green).
- **The merge step (`'auto'` only; runs on `merge_pending` ticks):** when the platform reports every required check green AND `headSha(pr) == reviewed_head_sha`, forge executes the **atomic head-bound merge**: `gh pr merge --squash --match-head-commit "<reviewed_head_sha>"`. The expected-head check is enforced **server-side at merge time** (GraphQL `expectedHeadOid`) — if the head moved between probe and call, the merge fails and the task enters drift handling. Branch protection is likewise enforced server-side on the call: forge cannot merge red (`--admin` and every bypass path prohibited). Durability trade-off (accepted): with no orchestrator running, nothing merges — the task waits in `merge_pending`, fail-safe (`approval`-equivalent), until the next tick.
- **`merge_pending → shipped` (terminal) requires RepoHost confirmation** (gc/reconcile or dispatch-tick probe) that the PR merged into the **recorded base repo + base branch** AND the merged PR head equals **`reviewed_head_sha`**. Tracker status is never merge proof (see gc divergence table). Notification `shipped` emitted on confirmation.
- Failure/regression paths (fail-closed, each with an event):
  - **Head drift while pending** (probe sees `headSha(pr) != reviewed_head_sha`) → regress to `ready_for_review`: the new head MUST re-enter verify + cross-host review (never plain `reviewed`, which would allow silent re-ship; single-host: CLI re-verification refreshes the SHA — see §Single-host mode).
  - **Atomic merge call fails** (head moved between probe and call, or checks regressed) → re-enter drift handling; repeated unexplained failures → park with a question.
  - **PR closed without merge, or honesty-probe/policy loss while pending** → **park with a question** — the next tick must NOT silently recreate the PR or retry the merge. The operator's answer resolves the task to `reviewed` (re-ship) or `cancelled`.
  - **Tainted merge** (PR merged with `mergedHeadSha != reviewed_head_sha` — necessarily an external actor, since forge's own merge call is head-bound) → park with a **fatal** notification + revert guidance; never mark `shipped`.
  - Red PR CI → regress via the changes-requested path with findings injected. Transient git/tracker failures → retry with backoff; after `retry_attempts` failures → `failed`, fatal notification.
- **`'auto'` preconditions** (`ship.merge_policy: 'auto'`; default is `'approval'` = open PR, human merges): requires `agents.review_host_cli` configured (dual-host review — single-host + `auto` is a settings validation error) AND the RepoHost **honesty probe** passing: the *effective* base-branch rules (classic branch protection + rulesets) enforce at least one blocking required status check; the squash method is allowed; the authenticated identity has write permission; no admin bypass is in play; **the base branch has NO merge queue** (owner decision MQ: a queue-enabled base can queue/merge with no orchestrator running, breaking the head-bound guarantee — merge-queue repos are UNSUPPORTED for `'auto'`; the probe reports `merge_queue_enabled` and the ship path parks fail-closed). Probe failure → **park the task with a question** — never warn-and-merge, never a silent downgrade. (Tracker and repo host are orthogonal — a Linear-tracked repo hosted on GitHub gets the full path. Repos with no RepoHost cannot SHIP at all — see §RepoHost.)

### Single-host mode

If `agents.review_host_cli` is `null`, REVIEW phase is skipped. Task flows IMPLEMENT → SHIP directly. A one-time warning at orchestrator first-run: *"Second-opinion review disabled — running single-host. Forge recommends configuring review_host_cli for adversarial review."*

Single-host mode is incompatible with `ship.merge_policy: 'auto'` — that combination is a settings validation error (ADR `orchestrator-ship-auto-merge` D2: unattended merge requires dual-host review). Only `approval` (open PR, human merges) is reachable single-host.

**Single-host SHA binding (ADR `orchestrator-ship-auto-merge`):** with no REVIEW phase to mint `reviewed_head_sha`, the direct path is: when the CLI's independent verification of the IMPLEMENT verdict succeeds (`complete --phase implement` re-runs tests/lint — the existing gate), the task advances directly to `reviewed` via the dedicated `implement_verified_single_host` transition (legal from `running`, and from `ready_for_review` on drift re-entry — there is NO ready_for_review hop and NO ready_for_review notification on this path), and the CLI records the **verified worktree HEAD** as `reviewed_head_sha` in the ship record write-ahead before the state commits. The binding invariant is preserved with a weaker witness: what ships is exactly what the CLI verified (single-host mode's documented posture — no adversarial review — unchanged). Head drift while `merge_pending` regresses to `ready_for_review` as usual; single-host re-entry means the CLI re-runs independent verification on the new head and refreshes `reviewed_head_sha` (there is no cross-host review to re-run).

## Branch / PR integration topology — merge-to-main-between-phases

The branch strategy: **every task branches from `main`. SHIP opens the PR against `main`; under `ship.merge_policy: 'auto'` forge executes the platform-gated, head-bound merge once required checks are green; a task is `shipped` only when its PR is confirmed merged to `main`. A task with declared dependencies cannot SHIP until all dependency PRs are merged.**

Throughout this document, `main` denotes the **resolved repository default branch** — resolved via host-independent git (`git ls-remote --symref origin HEAD` first, fallback local `git symbolic-ref refs/remotes/origin/HEAD`, last resort the fingerprint-matched persisted cache; no RepoHost involved, so IMPLEMENT worktrees work on every remote type) and persisted **before `ensure-worktree` creates the worktree** (hydration checks out `origin/<resolved-default>`), and the same persisted value supplies the PR base at ship time via the RepoHost (ADR `orchestrator-ship-auto-merge`; fixes the former `/ship --base dev` split). An explicit `ensure-worktree --base <branch>` always wins: it is normalized (`origin/x` == `x`), validated (`git check-ref-format`), and FROZEN into the worktree marker as the task's `base_branch` — a later global default-branch refresh never retargets an existing task, and review dispatch resolves its pinned `review_base_sha` from this frozen name. Repositories whose default branch is not literally named `main` use their resolved default everywhere this document says `main`.

Rationale (chosen over stacked PRs):
- Matches the dependency-graph philosophy: parallel-dispatched tasks are independent by graph construction, so they don't need to share a branch.
- Eliminates rebase churn that stacked PRs require when an upstream PR is amended during review.
- Each PR is reviewable in isolation against `main`.
- Dependency latency is small (PR merge → next task dispatch on next `forge orchestrate phases --ready` tick).

Concretely:
- `forge orchestrate phases --ready` filters ready tasks to those whose `depends_on` are all `shipped` (i.e., PRs merged — `merge_pending` does not count).
- A task whose dependency is `reviewed` or `merge_pending` but PR not yet merged is **not ready** — it waits.
- If a dependency PR is closed without merge: the dependency **parks with a question** (fail-closed — see Phase 3 failure paths); the operator's answer resolves it to `reviewed` (re-ship) or `cancelled`. Dependent tasks simply remain not-ready meanwhile (there is no dedicated `blocked` task state).

Trade-off accepted: tasks with declared dependencies cannot run in parallel with their dependencies even if their dependency's IMPLEMENT phase is done. This is correct — dependencies exist *because* the consumer needs the producer's output committed.

For projects that want stacked PRs (rare; adds rebase loops), an opt-in `agents.branch_strategy: 'stacked'` mode is reserved in the settings schema but not implemented in v-next. Documented as a future extension if real demand emerges.

## RepoHost — repository-host abstraction (ADR orchestrator-ship-auto-merge)

PR/merge operations live in a **RepoHost** interface, deliberately separate from `Tracker` — tracker and repository host are orthogonal (forge itself is Linear-tracked on a GitHub repo). Interface + fake land in FORGE-231; `GitHubRepoHost` in FORGE-232.

**Discovery/auth is independent of `tracker.type`:** the GitHub RepoHost activates on a GitHub remote + authenticated `gh`, regardless of tracker. Fork topologies (base repo ≠ push repo) are detected and **parked** — out of scope for v0.4. Non-GitHub remotes have no RepoHost, so **orchestrator SHIP is unavailable there under BOTH policies**: a `reviewed` task on such a repo parks with a question (Phase 3 requires RepoHost PR creation and `mergeResult()` merge proof — without them the task could never legitimately reach `shipped`); the interactive `/ship` skill remains the manual path. `ship.merge_policy: 'auto'` on such a repo is additionally a settings validation error.

**Operations (spec-level contract; exact signatures shipped in FORGE-231 — every result is a discriminated union validated at the adapter boundary: `ProbeReport`, `ChecksResult`, `MergeResult`, `MergeAttemptOutcome`, `HeadShaResult`; all SHA fields are lowercase 40-hex by schema, so invalid host output becomes a typed transport failure rather than a drift/merge-proof participant):**

- `resolveBase()` — base repo identity + push remote; **consumes** the persisted host-independent default-branch resolution (recorded before `ensure-worktree` — see §Hydration) rather than re-resolving it; all persisted in the ship record (never re-sniffed from remote URLs).
- `probe()` — the **honesty probe**: evaluates *effective* base-branch rules (classic branch protection + rulesets + merge queue) and reports: blocking required-check count, allowed merge methods, authenticated write permission, admin-bypass exposure.
- `createOrGetPullRequest(head, base)` — idempotent by head branch (crash/duplicate-PR safe).
- `requiredChecksGreen(pr)` — whether every blocking required check currently passes (gates the merge step).
- `mergeAtomic(pr, expectedHeadSha)` — the `'auto'` merge step: squash merge with the server-side expected-head check (`gh pr merge --squash --match-head-commit`); fails — never bypasses — if the head moved or protections are unsatisfied. No standing auto-merge enablement is ever created (GitHub's persisted auto-merge cannot pin a SHA).
- `mergeResult(pr)` — `{ merged, baseRef, mergeCommit, mergedHeadSha }` — the ONLY source of merge proof (`shipped` requires `merged && baseRef == recorded base && mergedHeadSha == reviewed_head_sha`).
- `headSha(pr)` — drift detection while `merge_pending`.

**Ship record** (`.forge/orchestrator/tasks/<task_id>/ship-record.json`, CLI-owned): `reviewed_head_sha`, resolved base repo + branch + push remote, PR id/URL, merge-attempt status. Written **write-ahead** (before each external side effect) and reconciled idempotently after, so every crash window (post-push, post-create, post-merge-attempt) recovers without duplicate side effects.

## File-glob declarations + overlap detection (file-level safety)

`phases.yaml` is extended to allow each task to declare its **expected write globs**:

```yaml
phases:
  - number: 2
    tasks:
      - id: FORGE-31
        title: Event payload schema
        write_globs:
          # Illustrative paths under app/ rather than src/ so this example
          # doesn't trip the doctor file-path drift check on the live forge
          # repo. Adopters writing real `phases.yaml` should use their actual
          # source roots (typically src/...).
          - app/schemas/events.ts
          - app/schemas/events.test.ts
        # ... existing fields
```

`write_globs` is optional. When present, `forge orchestrate phases --ready` performs an **overlap check** before recommending parallel tasks (overlap detection is read-only; ranking surfaces non-overlapping tasks higher):

| Overlap class | Behavior |
|---|---|
| No overlap | Dispatch both freely |
| Soft overlap (non-guardrail files) | Warn in dispatch output: `"FORGE-31 and FORGE-32 may both write app/utils/foo.ts — merge conflicts possible"` |
| Hard overlap (any guardrail glob from preflight list) | **Block dispatch.** The task that came second in `phases.yaml` waits until the first completes. |
| Either task declares a known-global file (`package.json`, lockfiles, migration directories) | Block: serialize them. |

The hard-locked file list lives at `.forge/settings.yaml` → `agents.hard_lock_globs` and defaults to:
```
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
tsconfig.json
phases.yaml
src/index.ts
migrations/**
prisma/schema.prisma
```

Adopters can extend this. The principle: any file where two unrelated changes can't be merged-cleanly via git's 3-way merge belongs on this list.

When `write_globs` is **absent**, the CLI assumes worst-case overlap and serializes more conservatively. This is a deliberate nudge for `/decompose` to fill in write_globs as part of task creation. v-next ships with `/decompose` updated to fill write_globs by inspection of task scope; pre-existing phases.yaml files without write_globs remain valid but get conservative scheduling.

## Question lifecycle (preserved from v1 with CLI-as-consumer adjustments)

```
worker decides to ask
        │
        ▼
classify ──autonomous──▶ decide; log autonomous decision; continue
        │
        └──architectural──▶ check .forge/orchestrator/tasks/<t>/attempts/<*>/answers/
                                 │
                                 ├──prior answer (decision_key match)──▶ reuse; do not ask
                                 │
                                 └──no prior──▶ check open question with same decision_key
                                                  │
                                                  ├──open exists──▶ block on existing
                                                  │
                                                  └──no open──▶ check per-task budget
                                                                  │
                                                                  ├──hard cap reached──▶ force autonomous decision
                                                                  │
                                                                  └──budget OK──▶ forge orchestrate question
                                                                                       │
                                                                                       ▼
                                                                       Worker exits subagent run, returns to parent
                                                                                       │
                                                                                       ▼
                                                                       Dispatch skill polls notifications.jsonl
                                                                                       │
                                                                                       ▼
                                                                       Skill renders question to user
                                                                                       │
                                                                                       ▼
                                                                       User answers in main session
                                                                                       │
                                                                                       ▼
                                                                       Skill calls forge orchestrate answer
                                                                                       │
                                                                                       ▼
                                                                       Skill dispatches new attempt (Task tool / Codex subagent)
```

### Question identity

A question is identified by `question_id` (UUIDv7) but **deduplicated** by `decision_key`. A `decision_key` is a stable string the worker constructs from the decision context (e.g. `public-api:dispatcher-events:v1`). Respawned workers that re-encounter the same decision reuse an existing answer (even from a prior attempt, even from a prior run).

### Retry + per-task budgets

- `attempt` increments on each respawn for the same `decision_key` within an attempt-respawn chain. Initialized at 1.
- `max_attempts` default 3 (`agents.question_max_attempts`).
- After `max_attempts`, worker forces an autonomous decision with logged justification, OR marks the task `blocked` if it cannot proceed without resolution.
- Per-task `soft_cap` (default 3) and `hard_cap` (default 6) for total questions. Beyond `hard_cap`: forced autonomous decisions. Configurable per-task via `question_budget: { soft, hard }` in `phases.yaml`.

### Unanswered-question fallback

If a question is unanswered for `question_timeout_ms` (default 30 min — same as lease TTL, deliberately):
1. Attempt marked `expired`.
2. Tracker comment posted with question text + answer file path.
3. Tracker issue moves to `IssueState.blocked`.
4. Question stays in `.forge/orchestrator/tasks/<t>/attempts/<a>/questions/` for audit.
5. Supervisor can answer via `forge orchestrate answer <Q>` later; next `/forge orchestrate` dispatch picks up the answer and creates a new attempt.

## Tool-permission isolation — workflow isolation, not security isolation

The orchestrator runs worker subagents with the user's host CLI permissions. Worktree boundaries are **workflow isolation, not security isolation.** Workers can read and write any file the user can; can run any shell command; can read environment variables.

Mitigations applied:
- Worker prompts explicitly forbid writes outside the worktree.
- Codex workers spawn with `--sandbox workspace-write` (Codex's built-in sandbox).
- Claude Code workers run with restricted tool list (Read, Write, Edit, Bash with allowlist of safe commands).
- A `forge orchestrate dispatch --strict-env` flag adds prompt instructions to avoid reading globally-readable secrets. This is a defense-in-depth nudge, not enforcement.

Workers can still:
- Read environment variables (including `ANTHROPIC_API_KEY` if set — see ingestion safety in `/SPEC.md`).
- Read user dotfiles (`~/.aws/credentials`, `~/.ssh/`, etc.) if granted bash access.
- Modify shared global files (lockfiles, system configs) — though preflight guardrails and hard-locked file globs reduce the surface.

This is documented honestly: **forge is workflow tooling, not a security sandbox.** Adopters running untrusted workloads should add OS-level sandboxing (Docker, firejail, etc.) outside forge's scope.

## Multi-main coordination

Multiple supervisor sessions ("mains") can run concurrently against the same forge project. Each has its own `run_id`. Coordination is fully mediated by the local lease + tracker:

1. **Discovery.** Each main runs `forge orchestrate phases --ready` (read-only) → user picks → `forge orchestrate claim`. The CLI's `claim` verb:
   - Reads `phases.yaml` (graph hasn't changed).
   - Computes ready set (tasks with all `depends_on` shipped, no overlap conflict with active tasks).
   - For each candidate, attempts atomic claim against the tracker.
   - Returns the first successfully-claimed task.

2. **Working window.** Once claimed, the lease is the ownership truth. Other mains see the lease and skip the task.

3. **Race resolution.** Two mains hitting `forge orchestrate claim` within the same tracker-claim window may both write a tentative claim. The slower writer detects the conflict on re-fetch and releases. Worst case: both successfully write a claim to different tracker fields simultaneously (e.g., GitHub doesn't reject the second label-add); race-loss detection on re-fetch resolves: only one keeps its claim, the other releases.

4. **Cross-main visibility.** Any main can run `forge orchestrate status` and see all active runs, leases, and attempts across the project. The CLI reads task-keyed state under `.forge/orchestrator/tasks/`.

5. **Cleanup on main exit.** When a main's session ends, its run is marked `quiesced`. Active leases owned by that run continue to heartbeat from any active subagent worker. When the lease TTL elapses without a heartbeat, the lease becomes steal-eligible. Another main can pick up the task; the worktree's git state is the continuity.

The dependency graph plus the tracker plus the lease combine to give: **at most one worker per task at any moment**, with eventual recovery from any main / worker / tracker failure.

## ADR integration (added 2026-05-17, simplified for ephemeral ADRs)

Per SPEC §ADR layer and §Precedence rules, the orchestrator integrates with ephemeral ADRs in two places (worker hydration was REMOVED 2026-05-17 because ADRs are now ephemeral and SPEC reflects all accepted decisions).

Workers no longer hydrate ADRs into their prompt. ADRs are ephemeral — once `/update-spec --apply` runs, the ADR is deleted and the change lives in SPEC. Workers read `spec/SPEC.md` for current architecture. No "Active ADRs" prompt block.

### 1. Drift detection (worker runtime)

When a worker reading SPEC, PRD, phases.yaml, or tracker body finds content that contradicts a higher-precedence artifact per §Precedence rules, it MUST emit a drift event + question rather than silently fix. See "Worker prompt template" above for the exact protocol. Drift events are typed:

```ts
type DriftEventData = {
  from_artifact: ArtifactKind;  // 'user' | 'spec' | 'prd' | 'phases' | 'tracker' | 'attempt'
  to_artifact: ArtifactKind;
  from_ref: string;
  to_ref: string;
  detail: string;
};
```

Note: `'adr'` is NOT in `ArtifactKind` because ephemeral ADRs are not durable artifacts — by the time a worker runs, an accepted ADR has already been propagated to SPEC (and the ADR file deleted). Drift is between SPEC/PRD/phases/tracker, not between ADR and anything.

Events written to `.forge/orchestrator/tasks/<task_id>/attempts/<attempt_id>/events.jsonl` (worker-emitted) and `.forge/orchestrator/global/drift-events.jsonl` (doctor/update-spec-apply/reconcile-emitted).

### 2. Proactive worktree drift guard (`/update-spec --apply` and `/amend-roadmap` runtime)

When the supervisor invokes `/update-spec --apply` or `/amend-roadmap` (mid-flight artifact mutations), the skill calls:

```
forge orchestrate worktree-drift-guard --adr <slug> [--dry-run] --json
```

The guard:

1. Reads the ADR's frontmatter (`affected_spec_sections`, `affected_prd_sections`, `affected_phases_tasks`, `affected_tasks`) — for `/amend-roadmap`, reads the new-task descriptor
2. Iterates active worktrees: queries `.forge/orchestrator/tasks/*/state.json` for tasks in `running`, `blocked_on_question`, `awaiting_respawn`, or `ready_for_review` states (Codex I3 — NOT `dispatched` or terminal)
3. For each affected worktree (unless `--dry-run`):
   - Writes a drift event to the worker's events.jsonl
   - Writes a question to the worker's question channel via the existing question-write atomic helpers, with `--drift-event-id` linking to the event AND `--routing-hint amend-roadmap` (for new tasks) or no routing-hint (for SPEC mutations where worker should just answer "rebase or restart")
4. The next worker heartbeat surfaces the question; worker pauses with `blocked_on_question`; dispatch skill polls it on next loop

With `--dry-run`: returns the list of would-affect worktrees as JSON without writing events/questions. Used by the skill for preview before user confirms.

This complements (does not replace) worker-side drift detection. The guard bounds discovery latency to `heartbeat_interval_ms` instead of relying on worker read patterns.

### 3. Doctor checks (v0.4)

`forge orchestrate doctor` (read-only) enforces SPEC↔code drift only in v0.4 — for each TypeScript path under `src/` mentioned in `spec/SPEC.md`, `spec/PRD.md`, or `spec/ORCHESTRATOR.md`, doctor asserts the file exists under `repoRoot`. Stale ADR drafts and pending apply-journal scopes are deferred to v0.5 (see SPEC §21). Honors `settings.doctor.spec_code_check_enabled` (default `true`). Exit codes: 0 clean, 1 warnings, 2 drift detected. See SPEC §Doctor enforcement (v0.4) for the canonical contract.

**Symbol-mention drift (FORGE-131).** Doctor additionally flags identifier-shaped backtick spans in the spec files that appear nowhere in `src/**/*.ts` (`missing_symbol` drift entries, same exit-2 semantics). This is a **bounded mention check, not export analysis** — a symbol in a comment or test counts as present; a renamed export with stale prose is caught only when the old name disappears from `src` entirely; it will not grow toward AST analysis. The shape filter (CamelCase ≥2 humps / camelCase / `ALL_CAPS_SNAKE`, len ≥4) plus a built-in `BASE_SYMBOL_ALLOWLIST` and the adopter-declared `settings.doctor.symbol_allowlist` keep prose nouns and external names out of the drift list.

### Files the orchestrator does NOT own

- `spec/decisions/*.md` — ADR draft files are user-owned (drafted via `/update-spec --draft`, accepted by user editing frontmatter, applied + deleted via `/update-spec --apply`). Orchestrator reads them only via `apply-decision` CLI verb invoked by the skill.
- `templates/adr.template.md` — owned by the forge framework templates.
- `spec/PRD.md`, `spec/SPEC.md`, `plans/phases.yaml` — `/update-spec --apply` skill (via `apply-decision` verb) mutates these with diff preview + user confirm.
- `.forge/orchestrator/global/update-spec-apply-journal/*.json` — owned by the `apply-decision` verb; written before each artifact mutation, archived under `completed/` after successful full propagation.

---

## Settings (extended schema)

```yaml
# .forge/settings.yaml — orchestrator section
agents:
  # Host CLI selection
  primary_host_cli: claude              # claude | codex | cursor | gemini
  review_host_cli: codex                # must differ from primary; null disables REVIEW
  
  # Subagent dispatch
  subagent_cap_per_main: 3              # cap on parallel subagents per main session
  
  # Lease management
  lease_ttl_ms: 1800000                 # 30 min
  heartbeat_interval_ms: 300000         # 5 min
  steal_grace_ms: 300000                # 5 min after expiry before steal allowed
  
  # Retry / backoff
  retry_attempts: 10
  retry_backoff_ms_max: 300000          # 5 min cap
  
  # Question management
  question_timeout_ms: 1800000          # 30 min (same as lease TTL)
  question_max_attempts: 3              # respawns per decision_key
  question_budget_soft: 3               # warning threshold per task
  question_budget_hard: 6               # forced-autonomous threshold per task
  
  # Worktree
  worktree_root: ./.forge/worktrees
  
  # Branch strategy
  branch_strategy: merge-to-main        # merge-to-main | stacked (stacked not implemented in v-next; reserved in spec pseudocode only — ship/merge policy is the separate `ship:` block, ADR orchestrator-ship-auto-merge)
  
  # Preflight guardrails
  preflight_globs:
    - src/index.ts
    - src/schemas/**
    - src/bin/**
    - src/cli/**
    - src/trackers/base.ts
    # The migrate command (planned for v0.5; see P3-T02) joins this list once it ships.
    - spec/**
    - CRITICAL.md
    - CLAUDE.md
    - AGENTS.md
    - package.json
    - phases.yaml
  
  # File-glob overlap detection
  hard_lock_globs:
    - package.json
    - package-lock.json
    - pnpm-lock.yaml
    - yarn.lock
    - tsconfig.json
    - phases.yaml
    - src/index.ts
    - migrations/**
    - prisma/schema.prisma
  
  # Failure policy
  on_persistent_failure: notify         # notify | block_task | move_to_next

# ADR orchestrator-ship-auto-merge (2026-07-10) — top-level ship block
# (schema lands in FORGE-231). Scoped to the orchestrator SHIP path only:
# no inheritance to/from drive.merge_policy / deliver.merge_policy.
ship:
  # approval (DEFAULT) = open PR, human merges.
  # auto = forge executes the platform-gated, head-bound merge once required
  #        checks are green (gh pr merge --squash --match-head-commit
  #        <reviewed_head_sha>; server-side expected-head check; NO standing
  #        gh pr merge --auto enablement — it cannot pin a SHA). Validation
  #        errors: auto + review_host_cli null (single-host), or auto +
  #        unsupported RepoHost (non-GitHub remote).
  merge_policy: approval                # approval | auto
```

## Security posture

The orchestrator treats worker output (including question files) as **untrusted input** for two reasons:

1. **Compromise**: a malicious dependency could induce a worker to write crafted question files.
2. **Prompt injection**: if questions/answers are reflected back into another worker's prompt context, a worker reading a tainted answer could be induced to leak credentials or escape its intended scope.

Mitigations:

- Schema validation with strict size caps on every CLI read (default 64 KB per file).
- Question/answer content rendered as **plain text** in the supervisor's notification stream, never interpreted as markup or code.
- Answer content injected into respawned worker prompts via a `WorkerContext.answered_questions` structured map, not as free-form context.
- Filesystem permissions on `.forge/orchestrator/<run_id>/` are 0700; question/answer files are 0600.
- The CLI rejects any state-mutation operation from a process whose effective UID does not own `.forge/`.

As noted in "Tool-permission isolation," forge does not claim to be a security sandbox. The above mitigations protect the orchestrator's integrity (state machine, schemas) but not the host system from a worker that goes off-script. Adopters who need true sandboxing must layer OS-level isolation.

## Integration points (cross-task contracts)

| Producer | Consumer | Contract |
|---|---|---|
| FORGE-31 question infra | FORGE-20 CLI | `QuestionSchema`, `AnswerSchema`, `NotificationEvent` types; atomic-write helpers |
| FORGE-31 question infra | FORGE-32 worker prompt template | Same schemas; CLI calls `forge orchestrate question` |
| FORGE-20 CLI | FORGE-21 dispatch skill | CLI command surface + JSON envelope schema |
| FORGE-21 dispatch skill | FORGE-22 worker prompt template | `WorkerContext` shape; dispatch parameters; verdict file path |
| FORGE-65 lease + state machine | FORGE-20 CLI | Lease record schema; state transition table; gc reconciliation rules |
| FORGE-20 CLI | tracker adapters | `ClaimResult`, `Tracker.claim`/`releaseClaim` interface |

Every implementation task is closed (no contract churn) once the matching producer task lands.

## Non-goals (v-next)

- Headless daemon mode surviving parent shell exit (deleted in v2).
- `execa`-based subprocess workers (deleted in v2).
- tmux / node-pty / pty-based worker spawning.
- Provider API key support (Anthropic, OpenAI) — subscription-only.
- Background or overnight unattended runs.
- Distributed orchestration across multiple machines.
- Skill portability across host CLIs (host-neutral source format, per-host emitters, migration UX) — deferred to Phase 3.
- Stacked-PR branch strategy — schema reserved, not implemented.
- Web UI / TUI for monitoring (`forge orchestrate status --json` is the machine surface; let people build TUIs on top).
- Per-question ad-hoc UI (picker for multi-choice) — supervisor types option id.
- MCP-server interface for `forge orchestrate` commands — possible future enhancement.

## Open questions for Phase 3

None remaining at the start of FORGE-20/21/31/32/65 implementation. The following are flagged for *Phase 3* design once the orchestrator is shipping in real projects:

1. **Skill portability across hosts.** Host-neutral source schema, per-host emitters, migration prompts on host change. Separate design doc.
2. **Stacked-PR branch strategy.** Real demand from users running on long-running feature branches. Adds rebase loops; design only if there's evidence of need.
3. **Background daemon-mode revival (for overnight runs).** Layered on top of the v2 architecture as an opt-in mode. CLI semantics unchanged; a `forge orchestrate daemon` long-runs in the background and invokes the same CLI verbs.

## Changes from v1 (point-by-point)

| v1 element | v2 disposition | Reason |
|---|---|---|
| Daemon process | **Deleted** | User does not need overnight runs; supervisor-driven dispatch is sufficient. Deleting the daemon eliminates pty/tmux requirement (billing fix) and ~half the spec's complexity. |
| Signals, drain, hot-reload | **Deleted** | No long-running process. |
| Lease files (filesystem-only) | **Replaced** with structured lease records with `expires_at`, `generation`, steal-after-expiry | Codex v2 review #4 — abandoned claims need principled expiry. |
| Slot accounting per max_concurrent | **Replaced** with `subagent_cap_per_main` enforced by the dispatch skill | No central process; cap is per-main. |
| `execa(host_cli, [...])` subprocess workers | **Replaced** with host-native subagent dispatch (Claude Task tool / Codex subagent) | Billing fix: workers bill as interactive subscription, not Agent SDK quota. |
| `forge orchestrate {status, attach, questions, answer}` CLI | **Retained and expanded** | Codex v2 review explicitly called out: these are user controls, not daemon features. |
| Atomic file ops (tmp+link), schema versioning, security posture | **Retained** | The hard-won durability work survives. |
| `decision_key` dedupe | **Retained** | Idempotency under respawn is unchanged. |
| 70/30 rule, structured classification, preflight guardrails | **Retained** | Worker prompt behavior is host-agnostic. |
| Question channel filesystem layout | **Restructured**: task-keyed instead of run-keyed; per-attempt scoping | Codex v2 review #5 — task is the coordination object. |
| Worker self-reported verdict | **Wrapped** with CLI-verified verdict facts | Codex v2 review #7 — verdict facts must be CLI-computed, not worker-claimed. |
| `save-point.md` prose as authoritative | **Demoted to advisory**; replaced by structured `events.jsonl` per attempt | Codex v2 review #3 (open questions) — prose can lie; structured events are checkable. |
| Tracker atomic claim hand-waved | **Per-adapter capability matrix** with honest framing: all three trackers use weak label-CAS + verify-on-readback. Linear's "strong CAS via `expectedVersion`" assumption was wrong (disproven 2026-05-15 against `@linear/sdk@84.0.0`); the spec was corrected before adapter implementation started. | Codex v2 review #1 + Codex v3 introspection 2026-05-15 — name the strength honestly. |
| `gc` mentioned without rules | **Deterministic divergence table with `--dry-run`** | Codex v2 review #10. |
| File-level conflict not addressed | **`write_globs` per task + overlap detection + hard-locked globals list** | Codex v2 review #2 + open question #1 — graph helps scheduling, not file-level safety. |
| Branch/PR topology unspecified | **Merge-to-main-between-phases**, explicit | Codex v2 review #8. |
| Tool isolation overstated | **Workflow isolation, not security isolation** — stated plainly | Codex v2 review #9. |
| Cross-host parity via shared daemon | **Cross-host parity via shared CLI**: one state machine, two skills, two adapters | Codex v2 review #3 — overstated symmetry replaced with honest layering. |
