# forge — ORCHESTRATOR architecture

> Drafted: 2026-05-13
> Scope: contract for the dispatcher + worker + question-channel subsystem (Phase 2 tasks FORGE-20, FORGE-21, FORGE-31, FORGE-32, FORGE-22).
> Status: frozen reference. Every Phase 2 implementation task is built against this spec. Changes here require re-review of any unfinished task.

## Purpose

forge's orchestrator runs as a local daemon. It claims tasks from a tracker, spawns host-CLI subprocess workers in isolated git worktrees, advances each worker through an IMPLEMENT → REVIEW → SHIP phase machine, and surfaces architectural questions from workers back to a human supervisor. It is deliberately headless: it consumes no host-CLI context window of its own. It is observable from a fresh main session at any time via the `forge orchestrate {status,questions,answer,attach}` CLI.

The design is the synthesis of three constraints:

1. **Two-host parity.** Both Claude Code and Codex CLI users must get equivalent UX. We do not depend on host-side primitives (e.g. Claude Code's agent view) that have no Codex equivalent.
2. **Human-in-the-loop on architecture.** Workers ask the supervisor when a decision affects scope, public API shape, naming of exported symbols, deprecation strategy, error semantics that propagate across module boundaries, or anything explicitly flagged in spec/ as "decide with user." They decide autonomously on routine choices.
3. **Minimum context pollution.** The main session reads a narrow notification stream (`question`, `question_resolved`, `fatal`). Operational noise (heartbeats, retries, ship events, worker stdout) goes to per-worker log files and the tracker, never to the main session.

## Architectural primitives

The orchestrator is one daemon process. It owns three primitives:

| Primitive | Responsibility | Owner module |
|---|---|---|
| Dispatcher | Poll loop, eligibility filter, atomic claim, slot accounting, phase transitions, hot-reload, drain, signals | `src/orchestrator/dispatcher.ts` |
| Worker | Subprocess wrapper per phase invocation; heartbeat; stall detection; verdict parsing; retry-with-findings | `src/orchestrator/worker.ts` |
| Question channel | Atomic filesystem mailbox; CLI surface for human supervisor; JSONL notification stream filter | `src/orchestrator/questions/`, `src/orchestrator/events.ts`, `src/cli/orchestrate-*.ts` |

The three primitives are file-disjoint. They share contracts (schemas, filesystem layout, event types) defined in this document.

## State machine

### IssueState (tracker-side)

```
todo ──claim──▶ in_progress ──verdict=pass──▶ in_review ──ship-ok──▶ done
                     │                              │
                     ├──question──▶ needs_input ──answer──▶ in_progress
                     │
                     ├──stall/exit≠0──▶ in_progress (retry)
                     │
                     └──retries_exhausted──▶ blocked
                                                  │
                                            (manual unblock)
                                                  │
                                                  ▼
                                                todo
```

We extend `IssueState` with a new value:

- **`needs_input`** — issued by the dispatcher when a worker has written a question file and is awaiting an answer. The worker has exited clean (with a lease) OR is blocked-polling on the answer file. In either case the slot is **not** consumed by an active worker (see "Slot accounting" below).

Cancellation is reachable from any state via `tracker.updateState(id, 'cancelled')`.

### WorkerState (in-memory, orchestrator-owned)

```ts
type WorkerState =
  | { status: 'pending'; taskId: string; queuedAt: number }
  | { status: 'claimed'; taskId: string; agentId: string; claimedAt: number }
  | { status: 'running'; phase: 'implement' | 'review' | 'ship'; taskId: string; agentId: string; pid: number; startedAt: number; lastHeartbeat: number }
  | { status: 'paused_for_question'; taskId: string; agentId: string; questionId: string; decisionKey: string; pausedAt: number; expiresAt: number }
  | { status: 'succeeded'; taskId: string; finishedAt: number }
  | { status: 'failed'; taskId: string; attempt: number; error: string; nextRetryAt: number | null };
```

The `paused_for_question` status is the orchestrator's view of a worker that has emitted a question and is waiting. Transitions:

- `running → paused_for_question` — worker wrote `.forge/questions/{question_id}.json` and exited 0 with the lease file.
- `paused_for_question → running` — answer file appeared; dispatcher respawns the worker with the answer injected.
- `paused_for_question → failed` — `expiresAt` reached without an answer; dispatcher applies the unanswered-question policy (see "Question lifecycle").

## Filesystem layout

All orchestrator state lives under `.forge/`. Every path documented below is rooted at the project directory.

```
.forge/
├── settings.yaml                          # config (hot-reloaded)
├── logs/
│   └── orchestrator.jsonl                 # append-only structured log (>100MB rotation)
├── orchestrator/
│   └── {run_id}/                          # one directory per orchestrator run (UUIDv7 prefix)
│       ├── pid                            # PID file for reattach detection
│       ├── started_at                     # ISO 8601 wall time
│       ├── settings_hash                  # SHA-256 of the settings.yaml at start
│       ├── state.json                     # run-level state snapshot (workers, claims) — written atomically every 5s
│       ├── notifications.jsonl            # the FILTERED stream that hits main-session stdout
│       └── workers/
│           └── {task_id}/                 # per-worker scratch
│               ├── attempt.json           # current attempt count + retry timing
│               ├── implement.log          # IMPLEMENT phase stdout/stderr
│               ├── review.log             # REVIEW phase stdout/stderr
│               ├── ship.log               # SHIP phase stdout/stderr
│               └── lease                  # presence == worker holds the task; absence == respawn-eligible
├── questions/
│   └── {question_id}.json                 # worker → supervisor (atomic write, never overwritten)
├── answers/
│   └── {question_id}.json                 # supervisor → worker (atomic write, never overwritten)
├── review/
│   └── {task_id}.json                     # review verdict file from REVIEW phase
└── worktrees/                              # configurable via agents.worktree_root
    └── {sanitized-task-id}/
```

### File semantics

| Property | Rule |
|---|---|
| Atomicity | All writes go to a uniquely-named `.tmp` sibling, `fsync`, then `link(tmp, target)` followed by `unlink(tmp)`. We use `link` rather than `rename` because POSIX rename silently overwrites an existing target; `link` fails with `EEXIST`, giving us OS-level enforcement of the "never overwritten" invariant below. Readers never observe a half-written file. Concurrent writers on the same id reject all but one with a typed `DUPLICATE_ID` error. Requires `.forge/` to live on a local POSIX filesystem — already true because git itself requires that. |
| Idempotence | `{question_id}.json` and `{answer_id}.json` are never overwritten. A second write with the same id is a bug; readers reject duplicates by id. |
| Schema versioning | Every JSON document includes a `version` field. Readers warn-and-skip on unknown versions; they never crash. |
| Untrusted input | Question/answer file contents may originate from compromised workers. Readers validate against the schema with strict size caps (default 64KB per file) and reject anything outside spec. |
| Cleanup | `.forge/questions/` and `.forge/answers/` accumulate across runs; `forge doctor --gc` reclaims entries whose tasks are in `done` or `cancelled` state. |

## Event types (JSONL notification stream)

The dispatcher writes one JSONL document per line to `.forge/orchestrator/{run_id}/notifications.jsonl` and to its own stdout. The set of event types in this stream is **deliberately narrow**. Operational events live in `orchestrator.jsonl`, not here.

```ts
type NotificationEvent =
  | { type: 'question'; ts: string; runId: string; taskId: string; questionId: string; decisionKey: string; attempt: number; question: string; context: string; options: { id: string; label: string; description?: string }[]; recommended_option_id?: string; what_happens_if_unanswered?: string }
  | { type: 'question_resolved'; ts: string; runId: string; taskId: string; questionId: string; resolution: 'answered' | 'expired' | 'budget_exhausted' | 'duplicate'; answerOptionId?: string }
  | { type: 'fatal'; ts: string; runId: string; reason: string; details?: Record<string, unknown> };
```

**Stream invariants:**

- Stdout receives only these three event types. Heartbeats, ship events, retry timing, worker stdout, settings reload notices all go to `orchestrator.jsonl` or per-worker log files and never appear on stdout.
- `question` events are emitted exactly once per question file appearance.
- `question_resolved` events fire on every terminal transition for a question (answered, expired, budget_exhausted, duplicate-dedup).
- `fatal` is for orchestrator-level errors that should pause the human supervisor: corrupt state, tracker total outage past retry cap, signal abort completed. Worker-level failures are not fatal at this layer.

## Question lifecycle

```
worker decides to ask
        │
        ▼
classify ──autonomous──▶ decide; log autonomous decision; continue
        │
        └──architectural──▶ check decision_key in .forge/answers/{*}.json
                                 │
                                 ├──prior answer exists──▶ reuse; do not ask
                                 │
                                 └──no prior answer──▶ check open question with same decision_key
                                                          │
                                                          ├──open exists──▶ block on existing
                                                          │
                                                          └──no open──▶ check per-task budget
                                                                          │
                                                                          ├──hard cap reached──▶ force autonomous decision; log
                                                                          │
                                                                          └──budget OK──▶ write .forge/questions/{question_id}.json atomically
                                                                                            │
                                                                                            ▼
                                                                                       worker exits clean with lease
                                                                                            │
                                                                                            ▼
                                                                                   dispatcher emits `question` event
                                                                                            │
                                                                                            ▼
                                                                                   supervisor answers via forge orchestrate answer
                                                                                            │
                                                                                            ▼
                                                                                   answer file appears → dispatcher respawns worker
                                                                                            │
                                                                                            ▼
                                                                                   worker reads answer; resumes from prior checkpoint
```

### Question identity

A question is identified by `question_id` (UUIDv7) but **deduplicated** by `decision_key`. A `decision_key` is a stable string the worker constructs from the decision context, e.g. `public-api:dispatcher-events:v1` or `naming:src/orchestrator/events.ts:NotificationEvent`. Respawned workers that re-encounter the same decision **reuse** an existing answer (even if the answer is from a previous run).

### Retry budget

- `attempt` — incremented on each respawn for the same `decision_key`. Initialized at 1.
- `max_attempts` — default 3; configurable via `agents.question_max_attempts` in settings.
- After `max_attempts`, worker marks the task `blocked_input_required` (a tracker-side comment + `IssueState.blocked` transition) and exits. The dispatcher emits `question_resolved` with `resolution: 'budget_exhausted'` and does not respawn.

### Per-task question budget

- `soft_cap` — default 3; emits a warning to the worker prompt on the next ask.
- `hard_cap` — default 6; forces autonomous decision with logged justification on subsequent forks.

Both caps are configurable per task via a `question_budget: { soft, hard }` field in `plans/phases.yaml` for architecture-heavy tasks.

### Unanswered-question fallback

If a `paused_for_question` worker reaches `expiresAt` (default 30 min from question creation, configurable via `agents.question_timeout_ms`):

1. Worker is marked `failed` with `error: 'question_expired'`.
2. Question file remains in `.forge/questions/` (for audit).
3. Dispatcher posts a tracker comment with the question text + a link to the question file.
4. Tracker issue moves to `IssueState.needs_input`.
5. Next time the supervisor runs `forge orchestrate questions --open`, the expired question reappears. They can answer it; the dispatcher detects the answer and respawns the worker fresh.

This **decouples** the supervisor's presence from the worker's progress: workers don't ping-pong waiting for an absent human; the tracker becomes the durable inbox.

## Slot accounting

`agents.max_concurrent` (default 10) caps **active worker processes**, not claimed tasks. A `paused_for_question` worker has exited clean and consumes no process slot, so the dispatcher can fill its slot with another task while the question is open.

This is a deliberate departure from "max_concurrent caps claimed tasks." We want supervisor latency on a single question to not starve the rest of the pipeline.

| WorkerState | Counts toward `max_concurrent`? |
|---|---|
| `pending` | No |
| `claimed` | No |
| `running` | **Yes** |
| `paused_for_question` | No |
| `succeeded` | No |
| `failed` (until retry fires) | No |

## Reattach + state reconciliation

The dispatcher daemon survives parent shell exit. A new main session can re-attach to an existing run:

```bash
forge orchestrate attach           # auto-detects the most recent run via .forge/orchestrator/*/pid
forge orchestrate attach <run_id>  # explicit
```

Attach behavior:
1. Read `pid` file; verify process is alive (`kill -0 <pid>`); refuse with actionable error if not.
2. Tail `notifications.jsonl` from end-of-file; emit existing events to stdout in order, then stream new ones.
3. Set up answer-write path through `.forge/answers/`; no other side effects.

### State reconciliation on dispatcher restart

If the dispatcher itself dies (kill -9, OOM, hardware) and a new dispatcher starts in the same project, it reconciles from:

| Source | Used for |
|---|---|
| `tracker.listActiveIssues()` | Authoritative IssueState per task; existing claims to release/reclaim |
| `.forge/orchestrator/*/state.json` | Most recent worker snapshots per task |
| `.forge/orchestrator/*/workers/{task_id}/lease` | Whether a worker is mid-flight (lease present) vs. clean-exited (lease absent) |
| `.forge/questions/{*}.json` + `.forge/answers/{*}.json` | Open vs. resolved questions; budget exhaustion |
| `plans/phases.yaml` | Dependency graph (unchanged across restarts under normal ops) |

Reconciliation rules:
1. Tracker is the source of truth for IssueState.
2. If the local `state.json` disagrees with tracker, tracker wins.
3. Stale claims (>2 × poll_interval_ms old, owned by our agentId) are released.
4. Workers whose lease file exists but PID is dead are marked `failed` with `error: 'worker_died_during_phase'` and a fresh attempt is queued.
5. Questions open in `.forge/questions/` without a corresponding answer are surfaced via the new run's notifications stream so the supervisor can re-engage.

## Worker prompt template

Every worker spawn is given:

1. The full `templates/worker-prompt.md` template (frozen text checked into the repo).
2. A `WorkerContext` JSON document with `taskId`, `worktreePath`, `agentId`, `phase`, `runId`, `priorAttemptFindings` (if a retry), `answeredQuestions` (decision_key → answer map for any prior resolved questions on this task).

The template encodes:

### The 70/30 rule

Workers **ask** the supervisor when a decision affects:

| Category | Example |
|---|---|
| Scope | "Should this PR also handle X, or punt to a follow-up?" |
| File lifecycle | "Delete the old module, or @deprecate it for one release?" |
| Public API shape | "Should this function return Result<T,E> or throw?" |
| Exported-symbol naming | "Is `dispatchWorker` the right name, or `spawnWorker`?" |
| Deprecation strategy | "Drop legacy field, or keep with warning?" |
| Error semantics propagating across module boundaries | "Surface the original tracker error, or wrap it?" |
| Anything tagged in SPEC.md / CLAUDE.md as "decide with user" | (free text) |

Workers **decide autonomously** when the decision is:

- Local variable names
- Internal helper structure (within a single module)
- Log format and verbosity
- Test fixture shape
- Retry counts and timeouts within documented ranges
- Whitespace, import ordering, comment style

### Structured classification

Before emitting any question, the worker MUST produce a classification JSON:

```ts
{
  decision_type: 'routine' | 'architectural',
  category: 'public_api' | 'scope' | 'naming' | 'deprecation' | 'error_semantics' | 'file_lifecycle' | 'other',
  reversibility: 'low' | 'medium' | 'high',
  blast_radius: 'local' | 'module' | 'project' | 'external',
  default_action: 'decide' | 'ask',
  reason: string,
}
```

If `decision_type === 'routine'`, the worker decides autonomously and logs the classification to `.forge/orchestrator/{run_id}/workers/{task_id}/decisions.jsonl`. If `decision_type === 'architectural'`, the worker proceeds to the question-write path with the classification attached to the question file.

### Recommended answer + consequences

Every question MUST include:
- `recommended_option_id` — the worker's pick if forced to decide, with one-sentence rationale.
- `what_happens_if_unanswered` — the worker's autonomous fallback if `expiresAt` is reached.

These are guardrails: a clearly-recommended question can usually be auto-resolved by the supervisor with one tap. A question that can't articulate consequences is probably not worth asking.

## Preflight wrapper (mechanical guardrail)

Independent of the prompt-level classification, a code-level wrapper inspects every file write attempted by the worker. If the path matches any of the **guardrail globs**, the wrapper forces a decision checkpoint (writes a question file before allowing the write):

| Glob | Rationale |
|---|---|
| `src/index.ts` | Top-level re-export surface; changes affect every consumer |
| `src/schemas/**` | Public data contracts |
| `src/bin/**` | CLI entry shape |
| `src/cli/**` | CLI command surface |
| `src/trackers/base.ts` | Tracker interface |
| `src/cli/migrate.ts` | Migration logic — adopter-facing, irreversible side effects |
| `spec/**` | Specifications |
| `CRITICAL.md`, `CLAUDE.md` | Project-wide rules |
| `package.json` (deps + bin fields) | Distribution surface |

This list is loaded from `.forge/settings.yaml` (`agents.preflight_globs`) so projects can tune it. The default ships with the list above.

Guardrails compose with classification: even if the worker classifies a change as `decision_type: routine`, a write to a guardrail path forces an `architectural` question. Prompt-side classification is advisory; preflight is enforcement.

## Security posture

The orchestrator treats worker output (including question files) as **untrusted input** for two reasons:

1. **Compromise**: a malicious dependency could induce a worker to write crafted question files.
2. **Prompt injection**: if questions/answers are reflected back into another worker's prompt context, a worker reading a tainted answer could leak credentials or escape its sandbox.

Mitigations:

- Schema validation with strict size caps on every read.
- Question/answer content is rendered as **plain text** in the supervisor's notification stream, never interpreted as markup or code.
- Answer file content is injected into respawned workers via a `WorkerContext.answeredQuestions` map, isolated from the rest of the prompt; the prompt template treats it as a structured input, not free-form context.
- Filesystem permissions on `.forge/orchestrator/{run_id}/` are 0700; questions/answers are 0600.
- The dispatcher process drops privileges (where supported) before invoking host CLIs.

## Integration points (cross-task contracts)

| Producer | Consumer | Contract |
|---|---|---|
| FORGE-31 question infra | FORGE-20 dispatcher | `QuestionSchema`, `AnswerSchema`, `NotificationEvent` types; atomic-write helpers |
| FORGE-31 question infra | FORGE-32 worker question writer | Same schemas; `writeQuestionAtomic`, `readAnswerAtomic` helpers |
| FORGE-20 dispatcher | FORGE-21 worker subprocess | `WorkerContext` shape; spawn signature; verdict file path |
| FORGE-21 worker subprocess | FORGE-22 retry queue | `WorkerState` transitions; `attempt.json` shape; failure error codes |
| FORGE-32 worker question writer | FORGE-21 worker subprocess | Preflight wrapper hook integration point in the spawn path |

Every implementation task is closed (no contract churn) once the matching producer task lands. This is the property that makes the work safe to serialize.

## Non-goals (deferred to v0.4.0+)

- Web UI / TUI for the dispatcher.
- Distributed orchestration (multiple machines coordinating).
- Integration with Claude Code's `claude --bg` agent view (gated on agent view exiting research preview + a Codex CLI equivalent existing).
- MCP-server interface (the filesystem mailbox + CLI surface is the v0.3.0 contract; MCP is a future enhancement layered on top).
- Per-question ad-hoc UI (e.g. picker for multi-choice options) — v0.3.0 surfaces options as plain text; supervisor types option id.

## Open questions

None remaining at the start of FORGE-20/21/31/32 implementation. Items that arise during implementation that affect this document must be brought back to the supervisor before the change lands. Each task's PR includes a checklist line: *"No ORCHESTRATOR.md contract changes" — confirmed.*
