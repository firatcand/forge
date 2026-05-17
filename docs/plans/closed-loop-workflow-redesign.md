# Closed-Loop Workflow Redesign

> **⚠️ SUPERSEDED 2026-05-17 (PM) by [`team-mode-minimum-architecture.md`](./team-mode-minimum-architecture.md).**
>
> This redesign was approved + partially applied in the morning, then stress-tested against a 5-person team scenario in the afternoon. Across four Codex consult rounds the user pulled the design back to a minimum-viable shape:
> - Ephemeral ADRs, `/update-spec --draft|--apply`, `apply-decision`, `/amend-roadmap`, `worktree-drift-guard`, drift events, drift-routed questions, cross-session question routing → **deferred to v0.5 opt-in or dropped entirely**.
> - 6-level precedence chain → **replaced with authority-by-field** (SPEC owns architecture; PRD owns product behavior; tracker owns execution; phases.yaml is a derived snapshot).
> - No contradiction gate on SPEC changes. Standard git push. Workers see informational SPEC-diff-since-claim on resume.
>
> The Phase 2.5 work in `plans/phases.yaml` has been consolidated accordingly. See the superseding doc for the full new ticket list and edit plan.
>
> This doc is preserved unchanged below for historical context — sections §3 (21 workflow points), §4 (Codex consults), and §10 (disposition) are still useful to read for the *reasoning trail*. Sections §5-§8 describe the design state at noon and should not be taken as current.

**Status:** SUPERSEDED 2026-05-17 (PM)
**Author:** Firat (with Claude + Codex consults)
**Date:** 2026-05-17 (morning)

> **SIMPLIFICATION APPLIED 2026-05-17 (after Codex SPEC review + user pushback)**
>
> The redesign was simplified mid-conversation. The canonical CURRENT state lives in:
> - **§5 Precedence rules** (now 6 levels, no ADR layer — ephemeral ADRs)
> - **§6 Verb taxonomy** (suggest-next/session-check/intent-detect dropped; Feature 7 entirely removed)
> - **§8 Phase 2.5 task list** (consolidated, 15 tasks not 18)
>
> Sections §3 (21 workflow points), §4 (Codex consults), §7 (originally proposed 2 state machines — workflow-stage was DROPPED, only task state remains), §10 (disposition), §11 (unknowns) describe the EVOLUTION of the design and may reference earlier states. They're preserved for historical context but should not be taken as the current spec.
>
> **What dropped (with rationale):**
> - Workflow-stage state machine + `.forge/workflow/state.json` → existing skill-end nudges + `/status-check` cover the same use cases
> - `suggest-next`, `session-check`, `intent-detect` verbs → not needed; `phases --ready` + `status` + explicit `/amend-roadmap` cover use cases
> - SessionStart / Stop / UserPromptSubmit host hooks → adds platform fragility for marginal benefit in sole-user one-session-one-task workflow
> - Append-only ADRs (MADR-style) → replaced with ephemeral ADRs (drafted → applied → deleted; rationale in commit message)
> - Separate `/update-spec` and `/apply-decision` skills → collapsed into `/update-spec --draft` + `--apply`
> - `next` verb deprecation alias → sole user, no compat shim needed

---

## 1. Why this document exists

Forge today ships pieces of a workflow but no **source-of-truth contract** between PRD, SPEC, phases.yaml, tracker bodies, learnings, and code. Two of our own learnings literally contradict each other on whether SPEC or Linear AC wins ([spec-beats-linear-ac.md](../learnings/2026-Q2/spec-beats-linear-ac.md) vs [spec-api-reality-check-before-design.md](../learnings/2026-Q2/spec-api-reality-check-before-design.md)). Three shipped tickets (FORGE-72/22/76) carry rescope notes in their Linear body that never made it back to SPEC. Agents reading SPEC cold today build the wrong mental model.

The user's described end-state workflow elevates "deterministic agent driver / no-drift workflow" from an implicit nice-to-have to **the product thesis**. This document captures the redesign before we touch any more code so that:

- The new PRD, SPEC, and phases.yaml are written around the right thesis on the first pass
- In-flight work (FORGE-20/74/21) is paused before it hardens the wrong public API
- Every Phase 2.5 ticket has a clear home and a deterministic precedence answer

This is the **proto-PRD**. The actual `spec/PRD.md` rewrite happens after this doc is approved.

---

## 2. Product thesis — "suggest, don't force"

> Forge is a framework that **suggests** a structured workflow for building software with AI coding agents. It does not force this workflow. The user remains the decider at every gate; deviation is supported. Forge's guarantee is that **every artifact agents read is deterministic and up-to-date** — no drift between local plan, tracker, and code.

The suggested default path:

```
forge init → /forge (BRIEF) → /draft-prd (PRD) → /draft-spec (SPEC)
         ↓
   /decompose (phases.yaml) → /push-to-tracker
         ↓
   /pickup-task → (build in worktree, with mid-flight ADRs + /apply-decision)
         ↓
   /ship (PR + tracker update) → /reconcile (drift sync) → cleanup
```

At any gate the user can:

- Skip ahead (e.g., paste an existing PRD and jump to `/draft-spec`)
- Loop back (`/forge --refine`, `/draft-prd --refine`, `/update-spec`)
- Mutate the roadmap mid-flight (`/amend-roadmap`) without violating the contract
- Pause and let active workers finish current attempts

Forge's job is to **make the next step obvious**, not to enforce it.

---

## 3. The 21 workflow points (verbatim from user, 2026-05-17)

Captured here as the canonical input to the rewritten PRD. Numbered for traceability.

1. Download forge and run `forge init` for a new project — creates basic structure.
2. Start Claude Code or Codex; at every session start it asks questions about current project structure.
3. First-run onboarding: primary coding agent, secondary coding agent, current tracker, GitHub connected?
4. After setup, start building — main thesis: user already knows what they're building (no idea-validation interview).
5. Once basic intent is captured (few sentences, couple of paragraphs, a couple of UX workflows), forge asks: what to build, tech stack, high-level architectural decisions.
6. Initial interview → BRIEF.
7. BRIEF → PRD → SPEC → decompose to plans/phases.yaml dependency graph.
8. Push issues into tracker (Linear, GitHub, or Notion).
9. Based on dependency graph, pick up tasks and start building. Each task has body, title, description, ACs, details — these drive per-task PRDs/plans.
10. Single session can pick up multiple non-overlapping tasks running in background subagents + worktrees.
11. Dependency graph ensures no two picked-up tasks overlap (no double-build, no breakage).
12. Multiple sessions can run in parallel, each picking up multiple tasks.
13. While building, agents can ask architectural questions that surface in the main session for the user to answer.
14. **Cannot use `claude -p`** — subscription-only via host's subagent primitive (API key forbidden).
15. Second opinion from Codex or Gemini CLI via forge wrapper, callable within the session (no separate session).
16. Wrapper auto-triggers during build (architectural decision points) AND after build (pre-review).
17. After implementation: ship → PR → merge → worktree cleanup → rebase to main.
18. Housekeeping verifies everything merged; back to building.
19. **Mid-flight architectural decisions** that change priority or scope must propagate to PRD + phases.yaml + tracker. No drift between local artifacts and tracker. Local plan is source of truth; tracker is current planning state.
20. FORGE-91 issue defines some of this but before picking it up, refactor current state to match the redesigned workflow.
21. Workflow auto-suggested at each step (brief → housekeeping → phase-gating) so user doesn't type explicit commands.

---

## 4. Codex consultation summary (2026-05-17)

Two Codex consults informed this redesign:

### Consult A — "Does FORGE-91 ship the described workflow?"

> *"FORGE-91 is necessary but insufficient. Keep it focused on decision-driven SPEC drift and ADR hygiene. The described workflow needs closed-loop control — roadmap state changes must converge across PRD, SPEC, phases, tracker issues, learnings, and active worktrees. That is separate control-plane work, not FORGE-91's job."*

Verdict: FORGE-91's scope is correct as a foundation but mis-sized to absorb the whole problem. Re-shape FORGE-91 to narrowly handle SPEC↔ADR; spin off complementary tickets for roadmap mutation, write-back sync, workflow state, hooks, etc.

Also flagged: `/update-spec` is **misnamed** if it must propagate to PRD + phases + tracker. Either keep it narrow or rename the broader command `/apply-decision`. → We choose: keep `/update-spec` narrow (SPEC only), create `/apply-decision` for the broader propagation.

### Consult B — "Does the orchestrator chain need refactor from scratch?"

> *"Recommendation: B. Confidence 9/10. Keep FORGE-78, pause FORGE-20/74/21. FORGE-78 is infrastructure — exclusive task ownership, resumable attempts, stale worker recovery, durable audit history. The new thesis changes workflow policy, not the need for task leases."*

> *"FORGE-20's biggest problem is `next`: it both 'suggests' and 'claims'. That contradicts the new product thesis. Suggestion must be read-only. Claiming is a user-approved mutation."*

> *"The orchestrator task state machine and the workflow-stage machine are different machines. Coupling them would make both worse."*

→ Adopted in section 6.

---

## 5. Precedence rules (binding contract — updated 2026-05-17 simplified)

**Updated 2026-05-17 simplification:** Ephemeral ADRs are NOT in the precedence chain (they're transient staging artifacts). Was 7 levels; now 6.

When two artifacts disagree, this is the order workers and skills MUST follow:

1. **Current user instruction** (in active session) — highest. Session/recency rule: active-session wins; persisted older-session contradictions must be formalized via `/update-spec --draft` + `--apply`, otherwise treated as attempt notes.
2. **spec/SPEC.md** — sole architectural source of truth (ephemeral ADRs propagate INTO this and then disappear)
3. **spec/PRD.md** — current product requirements snapshot
4. **plans/phases.yaml** — canonical execution scope (NOT equal to tracker)
5. **Tracker issue body** — **projection** of phases.yaml (kept in sync by `/push-to-tracker` + `/reconcile --push`); authoritative only for live human state (assignee, comments, status moves done outside forge)
6. **Older attempt notes** — lowest

**When lower disagrees with higher**, the worker does NOT silently "fix" the discrepancy. It:

1. Emits a drift event via `forge orchestrate event --type drift --from <artifact> --to <artifact>`
2. Writes a question via `forge orchestrate question` (with optional `--routing-hint amend-roadmap`)
3. Pauses the attempt with state `blocked_on_question`
4. Supervisor routes through one of:
   - `/update-spec --draft` + `--apply` (formalize architectural change → propagates to SPEC + PRD + phases + tracker; ephemeral ADR deleted)
   - `/amend-roadmap` (formalize new scope → updates phases.yaml + tracker)
   - Answer the question with "lower is right, update higher" (manual edit + commit + worker resumes)

`/update-spec`, `/amend-roadmap`, and `/reconcile` are the only paths that mutate higher-precedence artifacts.

---

## 6. Verb taxonomy — read-only vs user-approved mutation (updated 2026-05-17 simplified)

The core refactor demanded by the "suggest, don't force" thesis. **Simplified 2026-05-17:** dropped `suggest-next`, `session-check`, `intent-detect` (Feature 7 removed). Existing `phases --ready` extended to cover ranking; `status` covers re-grounding.

### Read-only verbs

| Verb | Purpose |
|------|---------|
| `forge orchestrate phases --ready` | Lists ready tasks (deps shipped + no overlap); accepts `--phase implement\|review\|ship` |
| `forge orchestrate status` | Reads `.forge/orchestrator/tasks/*/state.json`; renders dashboard; used for re-grounding |
| `forge orchestrate questions` | Lists open worker questions |
| `forge orchestrate doctor` | Drift diagnostics (SPEC↔code, stale ADR drafts, pending apply-journals — NO SPEC↔ADR since ephemeral) |
| `forge orchestrate attach` | Tails notifications stream |
| `forge orchestrate run list` | Lists active runs |

### User-approved mutations

| Verb | Purpose |
|------|---------|
| `forge orchestrate claim` | Claims one ready task via tracker CAS (`next` removed entirely per sole-user decision) |
| `forge orchestrate dispatch` | Spawns host-native subagent for an explicitly-claimed task |
| `forge orchestrate heartbeat` | Extends lease |
| `forge orchestrate question` | Worker writes question; supports `--drift-event-id` + `--routing-hint amend-roadmap` |
| `forge orchestrate answer` | Supervisor answers question |
| `forge orchestrate event` | Append to attempt event log (supports `--type drift`) |
| `forge orchestrate complete` | Worker finalizes attempt; runs verification |
| `forge orchestrate cancel` | Cancels current attempt; releases lease |
| `forge orchestrate gc` | Reconciles stale state |
| `forge orchestrate apply-decision` | Wraps `/update-spec --apply` skill mutations; propagates ephemeral ADR → SPEC + PRD + phases + tracker; DELETES ADR on success; journal-backed |
| `forge orchestrate amend-roadmap` | Mid-flight task creation: phases.yaml + tracker push + dep edges |
| `forge orchestrate reconcile` | Bi-directional phases.yaml ↔ tracker sync |
| `forge orchestrate worktree-drift-guard` | Invoked by `/update-spec --apply` and `/amend-roadmap`; flags affected worktrees; `--dry-run` available |
| `forge orchestrate run start` | Begins a new orchestrator run (allowed because `/forge orchestrate` invocation = user approval to start) |

**Boundary rule:** every read-only verb returns `{ok, data}` with no side effects beyond writing its own log line. Every mutating verb requires either an explicit user-confirmed flag or runs inside a skill that itself confirmed with the user.

**Dropped 2026-05-17:** `suggest-next`, `session-check`, `intent-detect`, `next` deprecation alias. Use cases re-routed to `phases --ready`, `status`, or explicit `/amend-roadmap`.

---

## 7. Two state machines (do not couple)

### Task state (FORGE-78, kept as-is)

```
unclaimed → claimed → dispatched → running
            ↓                       ↓ ↓ ↓
            cancelled        blocked_on_question
                                    ↓
                            awaiting_respawn
                                    ↓
                            ready_for_review → reviewed → shipped
                                    ↓ ↓
                                failed   abandoned
```

Lives under `.forge/orchestrator/tasks/<task_id>/state.json`. One task can have many attempts; each attempt has its own state.

### Workflow stage (NEW, lightweight)

```
idle → briefed → prd-drafted → spec-drafted → decomposed
                                                  ↓
                                          tracker-pushed
                                                  ↓
                                       picking ⇄ building ⇄ reviewing → shipping
                                                                            ↓
                                                                          idle
```

Lives at `.forge/workflow/state.json`. One per project (not per task). Mutated by skill-end side effects (`/forge` writes `briefed`, `/draft-prd` writes `prd-drafted`, etc.).

`suggest-next` reads this to decide what to recommend.

These two machines describe **orthogonal** concerns:

- Task state = "is this specific issue's work in flight, blocked, done?"
- Workflow stage = "where is the whole project in the brief→ship arc?"

Coupling them would mean a single task's blocker pulls the whole workflow stage backward — wrong.

---

## 8. Phase plan

### Phase 0 — Re-spec (this week, ~1 day CC time)

| # | Task | Estimate | Output |
|---|---|---|---|
| 0.1 | Archive v0.2 artifacts | XS | `spec/archive/v0.2-{PRD,SPEC,ORCHESTRATOR}.md` |
| 0.2 | Rewrite `spec/PRD.md` from §3 (21 points) | M | new PRD covering 21 features |
| 0.3 | Codex review on new PRD | S | inline edits |
| 0.4 | Rewrite `spec/SPEC.md` with ADR layer + verb taxonomy | M | new SPEC referencing §5, §6, §7 |
| 0.5 | Codex review on new SPEC | S | inline edits |
| 0.6 | Run `/decompose` to rewrite `plans/phases.yaml` | S | new dep graph |
| 0.7 | Push new tickets via `/push-to-tracker`; close paused replacements | S | Linear in sync |

### Phase 1 — Foundations: **DONE** (no changes)

### Phase 2 — Core features (in-flight; partial pause)

| Status | Ticket | Disposition |
|---|---|---|
| ✓ merged | FORGE-78 (state machine + leases) | **Keep** — foundation survives the thesis change |
| ⏸ pause | FORGE-20 (CLI verb suite) | **Re-decompose** into §6 taxonomy; current 13 verbs split |
| ⏸ pause | FORGE-74 (dispatch skill) | **Rewrite** as suggest→approve→claim flow |
| ⏸ pause | FORGE-21 (worker prompt) | **Rewrite** with §5 precedence rules baked in |
| ↻ continue | FORGE-79 (file-glob overlap lib) | Adapter-agnostic; lands as-is |
| ↻ continue | FORGE-90 (dashboard verb + /status-check) | Read-only consumer; aligns with §6 |
| ⟲ reshape | FORGE-91 (architecture-drift workflow) | **Narrow** to 2.5.01 + 2.5.02 + 2.5.12 only; broader scope moves to 2.5.03 (/apply-decision) |

### Phase 2.5 — Closed-Loop Workflow Control (NEW, simplified 2026-05-17)

**Source-of-truth loop first (the user's chosen vertical slice).**

**Simplification 2026-05-17 (per Codex SPEC/ORCHESTRATOR review + user pushback):** Dropped Feature 7 (workflow-stage state machine, suggest-next/session-check/intent-detect verbs, SessionStart/Stop/UserPromptSubmit host hooks). Ephemeral ADRs (deleted after apply) replaced append-only MADR-style. `/update-spec` and `/apply-decision` collapsed into single `/update-spec --draft` + `--apply` skill.

| # | Task | Type | Est. | Depends on |
|---|---|---|---|---|
| 2.5.01 | `templates/adr.template.md` + ephemeral ADR convention docs | foundation | S | — |
| 2.5.02 | `/update-spec --draft` + `/update-spec --apply` skill (single skill, two modes; deletes ADR on successful apply; resumable journal) | skill | L | 2.5.01, 2.5.03 |
| 2.5.03 | `Tracker.updateIssueBody(id, body)` method on all 3 adapters | backend | S | — |
| 2.5.04 | `forge orchestrate apply-decision` CLI verb (called by /update-spec --apply skill; journal-backed; deletes ADR on success) | backend | M | 2.5.01, 2.5.03 |
| 2.5.05 | Refactor FORGE-20: split `next` → `claim` (mutate) + extend `phases --ready` (read); drop `next` entirely (no deprecation alias per sole-user decision) | backend | M | — |
| 2.5.06 | Rewrite FORGE-21 worker prompt with §5 precedence (6 levels, no ADR layer) and drift event/question protocol | backend | M | 2.5.01 |
| 2.5.07 | Rewrite FORGE-74 dispatch skill: present→approve→claim flow using `phases --ready` | skill | M | 2.5.05 |
| 2.5.08 | `forge orchestrate doctor` — SPEC↔code + stale ADR drafts + pending apply-journal checks only (NO SPEC↔ADR — ephemeral) | backend | S | 2.5.01 |
| 2.5.09 | `/reconcile` skill + `forge orchestrate reconcile` verb — bi-directional phases.yaml ↔ tracker | skill | M | 2.5.03 |
| 2.5.10 | `/amend-roadmap` skill + `forge orchestrate amend-roadmap` verb — mid-flight task creation | skill | M | 2.5.03 |
| 2.5.11 | `forge orchestrate worktree-drift-guard` verb — flags affected worktrees on `/update-spec --apply` and `/amend-roadmap`; `--dry-run` for preview | backend | S | 2.5.08 |
| 2.5.12 | Cross-session question UX in `/forge orchestrate` skill — surface drift-routed questions with routing-hint | skill | S | FORGE-73 (done) |
| 2.5.13 | Auto-codex in-skill hooks — invoke `/codex` on `/plan-task` exit, `/update-spec --draft` end, `/ship` pre-PR | skill | S | — |
| 2.5.14 | Precedence rules doc (CLAUDE.md) + lint enforcement | docs | S | 2.5.01 |
| 2.5.15 | Question schema extension: add `routing_hint` + `drift_event_id` to QuestionIndex + `forge orchestrate question` CLI flags | backend | S | 2.5.05 |

**Dropped from earlier draft (2026-05-17 simplification, with cross-ref to where they went):**
- ~~2.5.05 Workflow-stage state machine~~ → not needed; existing /pickup-task + /status-check cover use cases
- ~~2.5.06 suggest-next verb~~ → replaced by extending existing `phases --ready` verb (2.5.05)
- ~~2.5.07 session-check verb~~ → not needed; `forge orchestrate status` exists
- ~~2.5.08 SessionStart/Stop/UserPromptSubmit hooks template~~ → not needed; skill-end nudges sufficient
- ~~separate /update-spec and /apply-decision skills~~ → collapsed into one skill with --draft/--apply modes (2.5.02)

### Phase 3 — Launch v0.4 (replaces current "Polish & launch")

| # | Task | Est. |
|---|---|---|
| 3.01 | Init flow onboarding interview prompts (primary/secondary agent, tracker, GH auth) — no host hook install | M |
| 3.02 | `forge migrate` v0.2 → v0.4 (rewrite skill call sites for renamed verbs; archive old artifacts) | M |
| 3.03 | e2e fixtures + cross-host CI matrix (Claude Code + Codex parity) | L |
| 3.04 | Release v0.4.0 to npm + GitHub | S |

---

## 9. Launch criteria (v0.4 definition of done)

End-to-end demo runs cleanly on a fresh adopter machine:

1. `npx @firatcand/forge@latest init` — scaffolds project (no host hooks installed)
2. User runs `claude` and types `/forge`
3. `/forge` — 4-question interview → BRIEF, ends with "Next: /draft-prd"
4. `/draft-prd` — produces PRD, ends with "Next: /draft-spec"
5. `/draft-spec` — produces SPEC, ends with "Next: /decompose"
6. `/decompose` — produces phases.yaml, ends with "Next: /push-to-tracker"
7. `/push-to-tracker` — creates Linear/GitHub/Notion issues
8. `/pickup-task` — claims one issue, creates worktree
9. Inside the worktree: build the feature; mid-flight architectural shift triggers `/update-spec --draft` → user reviews (optionally `/codex review-decision`) → flips frontmatter to accepted → `/update-spec --apply <slug>` propagates to SPEC/PRD/phases/tracker + deletes ADR + writes rationale to commit message; `forge orchestrate doctor` returns 0
10. `/ship` — PR + tracker status update
11. After merge: `/reconcile` pulls tracker changes back to local phases.yaml; worktree drift guard reports nothing stale
12. Any time user runs `/status-check` they see current ready tasks, open questions, active workers

**All while:** never using `claude -p`, always within subscription, with Codex auto-suggested in-skill at architectural decision points (in-skill hooks, NOT host hooks).

`forge orchestrate doctor` on this very project returns exit 0.

---

## 10. Old work disposition (surgical, not full-rewrite)

**Principle:** ~75% of current PRD/SPEC/ORCHESTRATOR.md is still correct (Phase 1 foundations, multi-tracker, FORGE-78 state machine, lifecycle, security model, tracker CAS). We edit in-place only where the new thesis contradicts what's written. No archive moves.

### `spec/PRD.md` — surgical edit in-place

| Disposition | What |
|---|---|
| **Keep** | Lines 1-77 (title, pre-PRD work, problem, target user, Feature 1 multi-tool tracker) |
| **Light edit** | Feature 2 (orchestrator) — inject "suggest, don't force" framing; clarify suggest→approve→claim flow |
| **Light edit** | Feature 3 (init flow) — extend with session-start onboarding interview |
| **Light edit** | Feature 4 (settings.yaml) — add hooks block schema |
| **Light edit** | Acceptance criteria (lines 243-257) — add closed-loop ACs |
| **Light edit** | User flows (lines 287-323) — Flow A gets ADR + /apply-decision step |
| **Append** | Feature 5: Drift workflow + ADRs (ADR convention, /update-spec, /apply-decision, doctor) |
| **Append** | Feature 6: Mid-flight roadmap mutation (/amend-roadmap, /reconcile, worktree drift guard) |
| **Append** | Feature 7: Workflow-stage control plane (state machine, suggest-next + session-check, hooks, auto-codex) |
| **Append** | New section: Precedence rules (binding contract — lifts §5 of this plan) |

### `spec/SPEC.md` — surgical with structural refactor

| Disposition | What |
|---|---|
| **Keep** | Stack, Data model (settings/phases/tracker schemas), Task state, Lease record, Attempt event, Integration points, Security model, Env vars, Performance, Observability, Build/test/release, Cross-host parity matrix |
| **Rewrite (structural)** | §Module layout — add new src/orchestrator/workflow-state.ts, src/cli/orchestrate/{suggest-next,session-check,apply-decision,amend-roadmap,reconcile}.ts |
| **Rewrite (structural)** | §Key flows — Flow 2 (orchestrate dispatch) becomes suggest→approve→claim |
| **Append** | §ADR layer (schema, supersedes chain, status lifecycle) |
| **Append** | §Precedence rules (binding contract) |
| **Append** | §Workflow-stage state machine (separate from task state) |
| **Append** | §Hooks (SessionStart/Stop templates installed by forge init) |

### `spec/ORCHESTRATOR.md` — surgical with structural refactor on CLI surface

| Disposition | What |
|---|---|
| **Keep** | Purpose, Architectural primitives, Write-surface contract, Lease semantics, Filesystem layout, Event types, Tracker atomic claim, gc reconciliation rules, Phase machine (IMPLEMENT/REVIEW/SHIP), Branch/PR topology, File-glob declarations, Question lifecycle, Multi-main coordination, Security posture, Changes from v1 |
| **Rewrite (structural)** | §CLI surface (lines 83-108) — split 13 verbs into read-only (suggest-next, session-check, status, questions, doctor, phases, attach) vs user-approved mutate (claim, dispatch, heartbeat, question, answer, event, complete, cancel, gc, apply-decision, amend-roadmap, reconcile, run start); add new verbs |
| **Rewrite (structural)** | §Worker prompt template — add precedence rules section per §5 of this plan |
| **Append** | §Workflow-stage state machine reference (point to SPEC) |
| **Append** | §ADR integration (how workers detect drift and route through /apply-decision) |

### `plans/phases.yaml` — surgical, preserves tracker_issue_ids

| Disposition | What |
|---|---|
| **Keep untouched** | Phase 1 (entire); all Phase 2 tasks with shipped/in-flight tracker_issue_ids except the three paused below |
| **Add `status: paused` + `replaced_by`** | FORGE-20 (P2-T07) → replaced_by: [P2.5-T06, P2.5-T07, P2.5-T09] |
| **Add `status: paused` + `replaced_by`** | FORGE-74 (P2-T18) → replaced_by: [P2.5-T11] |
| **Add `status: paused` + `replaced_by`** | FORGE-21 (P2-T08) → replaced_by: [P2.5-T10] |
| **Insert** | Phase 2.5 — 18 new tasks (P2.5-T01..T18) per §8 |
| **Rewrite Phase 3 in-place** | Drop existing P3-T01..T08 (migrate, fixtures, etc.); replace with launch v0.4 tasks per §8 |

### Other artifacts

| Item | Action |
|------|--------|
| `spec/CONTEXT.md` | Update after PRD edits land (re-generate canonical synthesis) |
| `spec/DESIGN.md` | Keep as-is; no UI surface changes from this redesign |
| `spec/BRIEF.md` | Keep as-is; brief is product intent, unchanged |
| `plans/BACKLOG.md` | Keep; review after Phase 2.5 lands |
| Linear: FORGE-20/74/21 | Add comment with replaced_by reference; move to Backlog with paused label |
| Linear: FORGE-91 | Narrow description to P2.5-T01 + P2.5-T02 + P2.5-T12; broader pieces become new tickets |
| Linear: Phase 3 milestone | Re-shape around new launch v0.4 tasks |

---

## 11. Open unknowns (resolve during PRD rewrite)

1. **Hook script shape across hosts** — Claude Code's SessionStart/Stop/UserPromptSubmit hooks vs Codex CLI's equivalent. Need to confirm Codex parity before 2.5.08.
2. **Workflow-stage state location** — `.forge/workflow/state.json` separate file, or a `workflow:` block in `.forge/settings.yaml`? Lean toward separate file (mutated frequently, settings.yaml is more static).
3. **`/apply-decision` UX** — one command (apply silently after ADR accepted) or wizard (preview each propagation, confirm)? Lean toward wizard for the source-of-truth loop's first version.
4. **Conflict handling when active worker and main session both want to write the same artifact** — likely "main session wins, worker pauses with drift event" but needs explicit spec.
5. **Migration UX for v0.2 → v0.4 adopters** — auto-rewrite their PRD or just install hooks + ADR template and let them re-run `/forge --refine`? Lean toward the latter.
6. **Auto-codex trigger budget** — every architectural-decision point could burn token budget. Likely need a per-session cap or opt-in flag.
7. **Cross-host portability of skills** — Claude Code uses `skills/<name>/SKILL.md`; Codex uses `/Users/.../.agents/skills/`. Hook templates must handle both.

---

## 12. Immediate next steps (this conversation — surgical, not full rewrite)

1. ✅ This doc written
2. ✅ User approved surgical approach for PRD + SPEC + phases.yaml (2026-05-17)
3. ☐ Surgical edits to `spec/PRD.md` — append Features 5/6/7 + Precedence rules; light edits to Features 2/3/4 + ACs + Flow A
4. ☐ Codex review on PRD diff
5. ☐ Surgical edits to `spec/SPEC.md` — append ADR layer + Precedence + Workflow-stage machine + Hooks; rewrite Module layout + Flow 2
6. ☐ Surgical edits to `spec/ORCHESTRATOR.md` — rewrite CLI surface + Worker prompt; append workflow-stage reference + ADR integration
7. ☐ Codex review on SPEC + ORCHESTRATOR diff
8. ☐ Surgical edits to `plans/phases.yaml` — mark FORGE-20/74/21 paused; insert Phase 2.5 (18 tasks); rewrite Phase 3 in place
9. ☐ Update `spec/CONTEXT.md` to reflect amended PRD/SPEC
10. ☐ `/push-to-tracker` — create 18 new P2.5 tickets + 4 new P3 tickets; add comments to paused FORGE-20/74/21; narrow FORGE-91 description

**Estimated total CC time to land Phase 0:** ~3-4h across 1-2 sessions (down from 6-8h thanks to surgical).
**Estimated total CC time to land Phase 2.5:** ~25-35h across multiple sessions, parallelizable via `/pickup-task`.
