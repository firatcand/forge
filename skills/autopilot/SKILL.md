---
name: autopilot
description: Take a product idea from the discovery interview all the way to a running delivery loop — drive the spec chain (BRIEF → PRD → SPEC → CONTEXT → phases.yaml → tracker), pausing ONLY at the human approval gates, then roll into /deliver. The single front door for a new forge product; pair with native /goal for hands-off completion.
tools: Bash(*), Read, Write, Edit, Task
---

# /autopilot

`/autopilot` is the single front door for a NEW forge product: it takes a raw
idea through discovery and the whole spec chain — `/forge` → `/draft-prd` →
`/draft-spec` → `/ingest-spec` → `/decompose` → `/push-to-tracker` — and then
rolls into **`/deliver`**, so the product goes from *interview* to *delivering*
with the user touching only three things: **interview answers, spec approvals,
and parked decisions.** Everything between the gates is autonomous; the judgment
AT each gate stays human.

It completes the vision arc: `/autopilot` is the front half (idea → populated
tracker), `/deliver` is the back half (tracker band → merged + Done), and
`/drive` is the per-ticket gauntlet inside `/deliver`. All three ride native
`/goal`; none self-loops.

## This is a per-turn recipe — NOT a loop (ADR)

`/autopilot` does **all it can in one invocation and then RETURNS**. It MUST NOT
self-loop: no `sleep`, no `watch`, no `while true`, no `--follow`, no
`gh pr checks --watch`. Whenever the next step is a human gate (a spec to
approve) or an asynchronous wait (CI), it reports the state and returns. The
repeat-until-done engine is native `/goal` — run `/autopilot` and, once it hands
off, pair the delivery with `/goal "<product> delivered"`. `/autopilot` is the
recipe; `/goal` is the engine. (This is the autopilot ADR — see
`spec/decisions` / the native-/goal ADR.)

## Precondition — a forge-initialized repo

The chain ends at `/push-to-tracker`, which needs `.forge/settings.yaml` with a
`tracker:` block. So `/autopilot` requires a forge-initialized repo. If
`.forge/settings.yaml` is absent, STOP and instruct the user to run `forge init`
first — do NOT auto-run the interactive initializer.

## Re-entrancy — resume from APPROVED-stage state, never from bare artifacts

Because `/goal` (or the user) re-invokes `/autopilot` across turns, it must
resume from the furthest **approved** stage. The subtle trap: the chain skills
write their artifact BEFORE their review gate passes (`/forge` writes
`spec/BRIEF.md` then prints "Gate 1 — review the brief"; `/draft-prd` writes
`spec/PRD.md` then "Gate 2"; `/decompose` writes `plans/phases.yaml` then
"Gate 4"). So **artifact existence ALONE must never skip a stage** — that would
resume PAST an unapproved spec and break the never-auto-approve guarantee.

`/autopilot` therefore tracks per-stage APPROVAL in its own scratch and resumes
on the pair **(artifact exists AND approval recorded)**:

```
<repo>/.forge/autopilot-state.md
```

Per stage (BRIEF, PRD, SPEC, DESIGN, CONTEXT, DECOMPOSE, PUSHED) it records
`{ artifact_written, approved, approved_at, approved_digest }` plus answered
front-load decisions. `approved_digest` is a content fingerprint (e.g. a hash of
the artifact file) captured AT approval time — this binds the approval to the
exact content the human signed off on. For the optional DESIGN branch it also
records `{ skipped: true }` when the user declines, so resume neither re-offers
nor blocks on it. This is the skill's PRIVATE scratch — NOT `.forge/orchestrator/`
state — so writing it honors the skill ↔ verb contract.

**Resume rule:**

- A stage is COMPLETE only when its artifact exists AND its approval is recorded
  AND the artifact's CURRENT content still matches `approved_digest`.
- If the artifact EXISTS but approval is NOT recorded, OR its content has CHANGED
  since approval (digest mismatch — e.g. it was edited or re-`--refine`d) →
  **re-present that gate** (show the current artifact, ask for approval; record
  the new digest). Do NOT re-run the drafting (no clobber) and do NOT skip — a
  stale approval of edited content is never honored. Every human gate stays real
  across compaction.
- DESIGN is optional: a recorded `{ skipped: true }` means complete-by-decline
  (do not re-offer); otherwise it follows the artifact+approval rule above.
- **Pushed** means `plans/phases.yaml` carries `source.project_id` AND a
  `tracker_issue_id` on EVERY task. (Per-phase `tracker_milestone_id` is
  tracker-dependent + schema-optional — do NOT require it.) A partial push (some
  task ids missing, or an existing `source.project_id`) means `/push-to-tracker`
  re-runs in UPDATE mode; report update/reconcile rather than
  re-creating.

## Every ceremony stays a real gate (suggest-don't-force)

`/autopilot` NEVER auto-approves a BRIEF, PRD, SPEC, DESIGN, or decomposition.
The gates ARE the product: autonomy between them, human judgment at them. It also
never proceeds past the BLOCKING `/ingest-spec` validation.

## Skill ↔ verb contract

`/autopilot` REUSES the existing chain skills verbatim — there is NO forked spec
chain. Every orchestrator state change goes through the verbs those skills
already call; `/autopilot` itself writes only its `<repo>/.forge/autopilot-state.md`
scratch (not orchestrator state) and never touches `.forge/orchestrator/`
directly.

---

## The recipe (one invocation, resume-aware, then return)

Each stage is skipped only when the resume rule above marks it complete
(artifact + recorded approval).

### 1. Resume + precondition

Read `.forge/autopilot-state.md` and scan for the chain artifacts
(`spec/BRIEF.md`, `spec/PRD.md`, `spec/SPEC.md`, optional `spec/DESIGN.md`,
`spec/CONTEXT.md`, `plans/phases.yaml`, the `source`/`tracker_issue_id` push
markers). Confirm `.forge/settings.yaml` exists (precondition). Resume at the
first stage that is not (artifact + approved).

### 2. Discovery → BRIEF (Gate 1)

If BRIEF is not approved: run **`/forge`** (the 4-question discovery interview)
when `spec/BRIEF.md` is absent, else re-present the existing brief. **Pause for
BRIEF sign-off** (suggest-don't-force); on approval, record it in the scratch.

### 3. BRIEF → PRD (Gate 2)

Run **`/draft-prd`** (per-feature discovery) when `spec/PRD.md` is absent, else
re-present. **Pause for PRD review.** Record approval.

### 4. PRD → SPEC (Gate 3)

Run **`/draft-spec`** when `spec/SPEC.md` is absent, else re-present. Honor the
**stack-choice ceremony** (a DECISION gate — list viable stacks + trade-offs,
STOP, ask) and **pause for SPEC approval.** Record approval.

### 4b. (Optional) DESIGN — a first-class gated branch

If the product has a UI surface, OFFER **`/draft-design`**. If the user accepts,
run it (when `spec/DESIGN.md` is absent) and **pause for DESIGN review** before
`/ingest-spec`; record approval (with its digest). If declined, record
`DESIGN { skipped: true }` in the scratch so resume neither re-offers nor blocks
on it — DESIGN is optional for `/ingest-spec`.

### 5. Validate → CONTEXT (blocking gate)

Run **`/ingest-spec`** — it validates BRIEF/PRD/SPEC/(DESIGN) and builds
`spec/CONTEXT.md`. This gate is **BLOCKING**: on failure, surface the gaps and
STOP; do not proceed to decompose. (No human approval needed on success — it is a
mechanical validation — but record that it passed.)

### 6. SPEC → phases.yaml (Gate 4)

Run **`/decompose`** (the `product-decomposer` subagent) when `plans/phases.yaml`
is absent, else re-present. **Pause for the decompose review** (one round of
edits). Record approval.

### 7. phases.yaml → tracker

Run **`/push-to-tracker`** (the `tracker-syncer` subagent) — it creates the
project + issues + `depends_on` relations and writes `source.project_id` /
`source.tracker_url`, per-phase `tracker_milestone_id`, and per-task
`tracker_issue_id` back into `plans/phases.yaml`. If `source.project_id` already
exists, it runs in UPDATE mode — report update/reconcile, do not re-create.
Report the project URL + issue count. Record PUSHED.

### 8. Roll into delivery

Invoke **`/deliver --all`** (or `/deliver --phase <first>`). The handoff is
IMPLICIT: `/deliver` reconstructs the band from tracker status + `phases --ready`
+ open PRs, so the now-populated tracker is all it needs. Pair the delivery with
native `/goal "<product> delivered"` for hands-off, multi-turn completion. Then
RETURN — `/autopilot`'s front half is done; `/deliver` owns the rest.

---

## Question-budget discipline

Front-load and bundle the discovery + architecture questions; `AskUserQuestion`
already caps a round at 4, so the budget is naturally bounded. When the user
steps away, decisions are parked to `/inbox` (via the same path `/deliver` uses
on the headless/attempt path) and the loop continues on whatever is unblocked.
Ask MAINLY architectural / public-API forks (typed per the FORGE-216 taxonomy);
drive sequencing and defensible defaults autonomously.

## Model routing

Model routing applies from the first DELIVERY dispatch: `/deliver` routes
implement/fix subagents via `forge orchestrate route`. The front-half drafting
subagents (`product-spec`, `software-architect`, `product-decomposer`) run at the
project's `default_model_tier` — there is no per-task tier to route on yet, so do
not fake a route for taskless drafting.

## cwd note

The front-half spec authoring happens in the repo root (greenfield bring-up
writes `spec/` + `plans/` on the main branch, as the chain skills do).
`/autopilot` does NOT create worktrees — the per-ticket DELIVERY work runs in
worktrees owned by `/deliver` → `/drive`.

## Native-/goal pairing

`/autopilot` does one turn's worth of work (one stage, or the handoff) and
returns; native `/goal` re-invokes it until the spec chain is approved and pushed
and `/deliver` takes over. Do not wrap `/autopilot` in your own loop — the engine
is native.

## Future integration points

- **Deterministic recorded-answer replay** — the front-half skills are
  LLM-interactive markdown; a future ticket can add answer-injection infra
  (a `FORGE_DISCOVERY_ANSWERS_JSON`-style seam, mirroring `forge init`) so a
  greenfield arc replays in CI. Today the dogfood is a documented walkthrough +
  recorded-answers fixture (`examples/autopilot-walkthrough.md`).
- **FORGE-216** — the question taxonomy types the spec-chain architectural-fork
  prompts that step 2–6 front-load.
- **FORGE-215 / FORGE-191 / FORGE-192** — the `/deliver` back half and its future
  parallelism own everything after the tracker is populated.
