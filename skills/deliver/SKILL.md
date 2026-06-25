---
name: deliver
description: Drive a whole phase or feature-set to "merged + Done" — themed batching over /drive, front-loaded architectural questions, phase-gate ceremonies, and lossless resume. The long-horizon recipe ABOVE /drive; pair with native /goal "<phase> delivered" for hands-off, multi-turn completion.
tools: Bash(*), Read, Edit, Write, Task
---

# /deliver

`/deliver <phase-id | --all>` drives a whole **band** of work — a phase, a
feature-set, or the entire roadmap — toward "merged + Done", by grouping ready
tickets into themed batches and driving each batch through the per-ticket
`/drive` gauntlet. It is the long-horizon recipe **above** `/drive`: `/drive`
delivers one ticket; `/deliver` sequences and batches many, front-loads the
architectural decisions, and runs the phase-gate ceremony at phase boundaries.

This is the vision headline — *use loops, goals, and the gauntlet to deliver a
full phase/feature-set/product by asking the user mainly architectural
questions* — codified into a reusable skill that orchestrates the EXISTING
skills (`/drive`, `/pickup-task`, `/plan-task`, `/implement`, `/review`,
`/second-opinion`, `/ship`, `/wrap-up`, `/phase-gate`) and read verbs.

## This is a per-turn recipe — NOT a loop (ADR)

`/deliver` does **all it can in one invocation and then RETURNS**. It MUST NOT
self-loop: no `sleep`, no `watch`, no `while true`, no `--follow`, no
`gh pr checks --watch`. Whenever the next step is an asynchronous wait — CI
running, a human decision pending — `/deliver` reports the state and returns.

The repeat-until-done behavior is owned by the **native `/goal` driver**:

```
/goal "phase-4 delivered"      # or: /goal "v0.5 delivered"
```

and the host re-invokes `/deliver <band>` each turn until every ticket in the
band is merged and Done. Keeping the loop in native `/goal`/`/loop` (not here) is
what lets every round run as a fresh, fully-budgeted interactive turn — the
autopilot ADR decision (`spec/decisions` / the native-/goal ADR). `/deliver` is
the recipe; `/goal` is the engine. Within one turn `/deliver` may drive several
batches sequentially, but it never wraps itself in its own loop.

## Runs on the interactive skill path (NOT the formal dispatch lifecycle)

`/deliver` uses the SAME interactive recipe as `/drive` and `/pickup-task`:
**tracker status (set natively) + `ensure-worktree` + `/plan-task` +
`/implement` + `/review` + `/second-opinion` + `/ship` + tracker-Done +
`/wrap-up`** (whose `gc --remove-worktrees` removes the worktree). It does NOT
drive the formal `claim → dispatch → heartbeat → complete` state machine — that
is the HEADLESS-orchestrator path. This matters two ways:

- **No `forge orchestrate claim`.** Like `/pickup-task`, `/deliver` sets a
  ticket In Progress **natively** on the tracker and creates the worktree with
  `ensure-worktree` — it does NOT acquire a local orchestrator lease. (A `claim`
  would set local state to `claimed`, which `gc` treats as ACTIVE and refuses to
  clean up on the skill path, stranding the lease — so we never take one.)
- **No `complete`.** `complete` requires a `current_attempt_id` that only
  `dispatch` sets, and carries the per-task worktree-marker binding (FORGE-188)
  that would reject a shared-worktree batch. Because `/deliver` never calls
  `complete`, a shared-worktree / one-PR multi-ticket batch is sound: each ticket
  is closed by marking it Done on the tracker, and the shared worktree is removed
  once by `/wrap-up`.

Forge does not pin or route models — dispatched subagents inherit the session
model (the host owns that choice). Escalation surfaces via `AskUserQuestion`
(interactive HITL); on a headless run where a dispatched attempt exists, `forge
orchestrate question` parks it to `/inbox`. Every orchestrator state change still
goes through a verb; `deliver-state.md` (below) is private scratch, not
orchestrator state, so writing it honors the skill ↔ verb contract.

## Re-entrancy — resume from durable truth, never redo

Because `/goal` re-invokes `/deliver` many times for the same band, `/deliver`
must reconstruct band progress on EVERY entry from DURABLE signals, in priority
order (durable signals always win over the scratch note):

1. **Tracker status** — the live execution truth. Read each band ticket's status
   from the tracker (MCP / `gh`). A ticket that is Done is finished; In Progress
   / In Review is in-flight; Backlog/Todo is a candidate. Do NOT infer status
   from `phases --ready` (which only lists not-yet-started dispatchable
   candidates and filters out done/in-progress/paused).
2. **Orchestrator task state** — `forge orchestrate status --json` for per-task
   local state (claimed / leased) and lease health.
3. **Open PRs** — `gh pr list --state open --json number,headRefName,body` to
   find in-flight batch PRs (match by branch or the `Closes` lines in the body).
4. **`deliver-state.md` scratch** — the computed batch plan, per-batch stage,
   parked tickets, and PR ledger.

`phases --ready --json` is used ONLY to enumerate the not-yet-started ready
candidates and their batching metadata — never as a status ledger.

### The deliver loop-state scratch

A markdown recipe cannot remember the batch plan across `/goal` re-invocations,
so `/deliver` keeps a human-readable scratch file at the repo root:

```
<repo>/.forge/deliver-state.md
```

It records: the target band; the computed batches (each batch's tickets, lead
ticket, shared branch/worktree, and per-batch stage); decisions captured from
front-loaded questions; tickets split out "awaiting decision"; and a PR ledger
(PR# ↔ batch ↔ ticket IDs). This is the skill's PRIVATE scratch — it is **NOT**
`.forge/orchestrator/` state, so writing it does not violate the skill ↔ verb
contract. `/deliver` reads it on entry to recover the plan, then **trusts the
durable signals above** when they disagree. Rewrite it after each stage
transition (with a timestamp). It makes resume lossless across compaction and
session restarts.

## cwd discipline — the session's hard-won rule

A subagent inherits the main-repo cwd and can silently edit `main` instead of the
worktree. So **every** subagent prompt `/deliver` issues MUST begin with a cwd +
branch assertion before any edit:

```bash
cd <worktree> && git rev-parse --abbrev-ref HEAD
```

The branch must be the batch's `feat/<lead-ticket-id>-<slug>` before any file is
touched. `/deliver` verifies the branch in the returned report against its own
measured numbers — it never trusts a subagent's self-report — and checks `main`
for contamination (`git -C <main> status --porcelain src/`) after each implement.

## Cross-review rule — the implementer never reviews its own code

Every batch's cross-review (step 5f below) is run by the **OTHER** model
lineage — the configured `agents.review_host_cli` (Claude, Codex, or Gemini; a
different host than the primary), via `forge orchestrate second-opinion` — never
the model that wrote the code. This
dual-lineage gate is inherited from `/drive`.

---

## The recipe (one invocation, resume-aware, then return)

### 1. Resume-aware start

Reconstruct band progress from the durable-truth sources above and read
`deliver-state.md`. Resolve the target band: `--phase <id>` (one phase) or
`--all` (the whole roadmap, phase by phase). If every ticket in the band is
already Done, run the phase-boundary ceremony (step 6) or report completion and
RETURN.

### 2. Enumerate ready candidates + batching metadata

```bash
forge orchestrate phases --ready --json
```

Each ready task carries `task_id`, `phase`, `estimate`, `depends_on`, its raw
declared **`write_globs`** (FORGE-215 exposes this for batching), and `overlap`.
Filter to the target band. Pull out `human` checkpoints and report them
separately — they are NOT auto-deliverable (a human must act); never try to
batch or drive them.

### 3. Compute batches (the themed-batching heuristic)

Grouping policy lives HERE, in the skill (it is intentionally not a verb).
Group two ready candidates into the SAME batch when ALL hold:

- **Same phase.**
- **Within the estimate cap** — each ticket's `estimate` index ≤
  `deliver.max_batch_estimate` in `ESTIMATES` order (`S < M < L < XL`). A ticket
  above the cap is delivered **SOLO** (its own batch → `/drive`).
- **Shared subsystem** — their `write_globs` intersect (candidate-vs-candidate
  glob intersection, computed here from the exposed `write_globs`). This is the
  "theme": related tickets that touch the same files/area. Shared-subsystem
  overlap — including hard-lock globs like `spec/**`, `skills/**`,
  `package.json` — is EXPECTED and SAFE within a batch, because all batch tickets
  are built SEQUENTIALLY in ONE shared worktree and land in ONE PR: there is no
  concurrent write between batch members, so shared subsystem is the POINT of a
  theme, not a hazard. (Cross-RUN safety — vs a different `/deliver`/worker — is
  the tracker In Progress status; v1 is sequential, so no lease arbitration.)
- **Batch size ≤ `deliver.max_batch_size`.**
- Dependency-adjacent tickets (one `depends_on` the other) PREFER the same batch
  when the other rules allow.

Order batches dependency-topologically. Persist the plan to `deliver-state.md`
(tickets, lead, branch). A ticket matching nothing batches alone (→ `/drive`).

### 4. Front-load architectural questions (the headline)

For the NEXT batch to build, run a planning-only fork-collection pass and bundle
its architectural forks into **`AskUserQuestion`** BEFORE building. (Use
in-session `AskUserQuestion` here — NOT the orchestrator `question` verb, which
needs a dispatched attempt and is the headless/MID-build park path referenced in
`/drive` step 8.) For each fork:

- **Answered in-session** → record the decision in `deliver-state.md` and build
  with it.
- **Deferred / declined** → split the affected ticket OUT of this round: leave it
  unclaimed + ready, note it in `deliver-state.md` as "awaiting decision", and
  RECOMPUTE the remaining batch without it. (When that ticket is later picked up
  on its own turn, `/drive`'s normal mid-build fork → `question` → `/inbox` path
  handles it post-claim.) Never block a whole batch on one ticket's open fork.

Ask MAINLY architectural / public-API forks (per the question taxonomy,
FORGE-216) — drive sequencing, batching, and defensible defaults autonomously.

### 5. Deliver the batch

**Singleton batch** (one ticket) → run **`/drive <ticket>`** and let it ride
native `/goal` per-ticket. Full reuse — do not reimplement the per-ticket
gauntlet.

**Multi-ticket batch** → the shared-worktree gauntlet on the interactive skill
path — **claim-free**, one LEAD worktree (lowest-dependency / lowest-id ticket):

a. **Set every batch ticket In Progress NATIVELY** (tracker MCP / `gh`) — exactly
   as `/pickup-task` does, with NO `forge orchestrate claim` and NO local lease.
   (v1 is sequential — a single `/deliver` — so the tracker In Progress status is
   the cross-run signal that keeps another run from picking these up;
   batch-lease arbitration for concurrent runs is deferred to FORGE-191/192.)
b. **One shared worktree, keyed on the LEAD:**
   ```bash
   forge orchestrate ensure-worktree --task <lead> --json
   ```
   ALL batch tickets' work happens in this single worktree (the verb owns
   `git worktree add` + the `.forge/worktree-task.json` marker; skills never run
   `git worktree add`). Then install/symlink `node_modules` and `mkdir -p
   plans/tasks` inside it, as `/pickup-task` does. On `WORKTREE_CONFLICT`, a
   different task owns that path — pick a different lead or report.
c. **One plan** (`/plan-task`) covering all batch tickets → **plan pre-opinion**
   (`/second-opinion review-plan`; skipped if `review_host_cli` is null or
   second-opinion is disabled). Fold findings in.
d. **Implement** (`/implement`) via a cwd-asserted subagent. Do not pin the
   subagent's `model` — it inherits the session model (Forge no longer routes
   models; the host owns that choice).
e. **Independent gate** — run the project gate yourself (`settings.verify` or
   typecheck + test + lint + build) and `forge orchestrate doctor --scope
   spec-code`. Trust your OWN measured numbers. Then **`/qa`**.
f. **One review + cross-review loop** — `/review` (primary) + `/second-opinion
   review-impl` (cross, OTHER lineage). The gate (R1, no numeric threshold):
   **PASS = `verdict === 'pass'` AND zero `block` findings across BOTH**. On
   fail, spawn a cwd-asserted fix subagent (routed the same way; increment the
   round count in `deliver-state.md`) and re-review, up to
   `deliver.review_loop_cap` (default 4) rounds. On cap hit, or a CRITICAL.md
   path with `review_host_cli: null` (no possible cross-review), **escalate** —
   surface the unresolved blocking findings to the user via `AskUserQuestion`
   (interactive HITL; typed per the FORGE-216 categories — give options +
   recommendation + what-happens-if-unanswered). On a HEADLESS run where a
   dispatched attempt exists, park instead via `forge orchestrate question ...
   --classification-file ...` (→ `/inbox`). Either way, do NOT merge.
g. **One `/ship`** — push, final gates, open ONE PR whose body lists EVERY batch
   ticket with a `Closes <ID>` line each, and mark each ticket In Review.
h. **Merge policy** (single CI check per invocation — no watch). If
   `deliver.merge_policy: 'approval'`, report the PR and RETURN (park for a human
   merge). If `'auto'` (default), check CI ONCE:
   ```bash
   gh pr view <pr> --json statusCheckRollup
   ```
   - **pending** → report and RETURN (native `/goal` re-enters and re-checks).
   - **green** → `gh pr merge <pr> --squash`. If the branch is behind base,
     `gh pr update-branch <pr>` and RETURN (next turn re-checks the rebased PR).
   - **red** → spawn a cwd-asserted fix subagent (within the cap) or escalate. Do
     NOT merge a red PR.
i. **On confirmed merge** → mark EACH batch ticket **Done** on the tracker. Then
   run **`/wrap-up`** ONCE on the shared worktree (keyed on the lead) — exactly as
   `/drive` runs `/wrap-up` after a per-ticket merge. `/wrap-up` owns the
   merged-gate, the `reconcile --pull`, and the worktree-removal eligibility +
   lease state machine (`gc --remove-worktrees`); `/deliver` does NOT remove the
   worktree by hand or assert gc's internals. (No orchestrator lease was taken on
   this claim-free path, so none can strand.) One shared worktree → one wrap-up
   for the whole batch.
j. **Lead-ticket / batch failure** → if the batch cannot be satisfied, **park the
   WHOLE batch as a unit** (the shared PR is atomic): escalate via
   `AskUserQuestion`, report the batch parked, and RETURN. Do NOT partially-merge.

### 6. Phase boundary

When the band crosses a phase (or `--all` finishes a phase's tickets), invoke
**`/phase-gate phase-<N>`** (gate criteria + retro + human approval) before
entering phase N+1. Offer a release cut at band completion — suggest, don't
force.

### 7. Degenerate bands — clean no-op + report (never spin)

An empty band, all-candidates-parked, human-checkpoint-only, or
all-candidates-above-the-estimate-cap (each then delivered SOLO via `/drive`) are
REPORTED and RETURN — never recompute in a loop.

---

## HITL knobs (`.forge/settings.yaml` → `deliver:`)

| Knob | Default | Meaning |
|------|---------|---------|
| `deliver.max_batch_size` | `4` | Max tickets grouped into one shared-worktree/one-PR batch. |
| `deliver.max_batch_estimate` | `'S'` | Only tickets with estimate ≤ this (in `S<M<L<XL`) batch; larger go SOLO. |
| `deliver.review_loop_cap` | `4` | Max review↔fix rounds for a batch before escalating (park to `/inbox`). |
| `deliver.merge_policy` | `'auto'` | `auto` = merge on green CI; `approval` = open the PR and park for a human merge. |

The block is fully defaulted (`.default({})`), so a `settings.yaml` with no
`deliver:` section yields all four defaults. As with `/drive`, there is
intentionally **no** `review_threshold` knob (R1): forge's `ReviewVerdict` has no
numeric scores, so the gate is the pass + no-`block` rule above, not a number.

## Skill ↔ verb contract

`/deliver` owns the UX (batching, sequencing, escalation prompts, the phase-gate
ceremony, the merge decision). It uses only READ + worktree + advisory verbs —
`ensure-worktree`, `phases --ready`, `route`, `doctor`, `second-opinion`,
`gc` (via `/wrap-up`), and `question` on the headless path — plus native tracker
status updates; it NEVER drives the formal `claim`/`dispatch`/`complete` state
machine and NEVER writes into `.forge/orchestrator/` directly. Its
`<repo>/.forge/deliver-state.md` scratch is not orchestrator state.

## Escalation → /inbox

Every cap-hit, red-CI-unfixable, missing-cross-review-on-critical-path, or
architectural fork escalates to the user. In an INTERACTIVE session this is
`AskUserQuestion` (HITL). On a HEADLESS run where a dispatched attempt exists, the
escalation is parked via `forge orchestrate question` → `/inbox` (drained by the
`/inbox` skill). `/deliver` never merges past an unresolved escalation.

## Native-/goal pairing

`/deliver <band>` does one turn's worth of work and returns;
`/goal "<band> delivered"` re-invokes it each turn until the whole band is merged
and Done. Run them together for hands-off, multi-turn delivery of a phase or
feature-set. Do not wrap `/deliver` in your own loop — the engine is native.

## Future integration points

- **FORGE-191 / FORGE-192 (Autopilot I5/I6)** — concurrent multi-batch
  parallelism (overlap-classified, lease-arbitrated) and a fully-forge-owned
  headless dispatch. v1 `/deliver` runs batches SEQUENTIALLY and claim-free (no
  leases); concurrent runs will add lease-based batch arbitration when parallelism
  lands.
- **FORGE-217** — discovery → queue wiring: the `/forge` interview will feed the
  band `/deliver` consumes.
- **FORGE-216** — the question taxonomy types the architectural-fork prompts that
  step 4 front-loads.
