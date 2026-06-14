# `/autopilot` walkthrough — idea → running delivery loop

This is a documented, end-to-end dogfood of the **`/autopilot`** skill
(FORGE-217): how one standing invocation takes a fresh product from a discovery
interview to a populated tracker and a running `/deliver` loop, pausing only at
the human approval gates.

It uses **[`greenfield-linear/`](greenfield-linear/)** as the worked example —
that frozen mini-project IS the expected output of the chain below. The recorded
interview/spec answers that reproduce it live in
**[`autopilot-answers.linear.json`](autopilot-answers.linear.json)**.

> **Why this is a walkthrough, not a CI job.** The front-half skills (`/forge`,
> `/draft-prd`, `/draft-spec`, `/decompose`) are Claude-followed *markdown* — they
> need a live model, so they cannot run deterministically in CI without an
> answer-injection seam. That seam (a `FORGE_DISCOVERY_ANSWERS_JSON`-style
> mechanism mirroring `forge init`) is a deferred follow-up. Until then the
> dogfood is this documented arc + a recorded-answers reference fixture; the
> `greenfield-*` trees remain the deterministic E2E fixtures for the *back* half
> (the orchestrate verb surface).

## Precondition

A forge-initialized repo: `.forge/settings.yaml` with a `tracker:` block (here,
`tracker.type: linear` + `tracker.config.team_id`). If absent, run `forge init`
first — `/autopilot` will NOT auto-run the interactive initializer.

## The arc

Run `/autopilot`. It drives the chain below, recording per-stage **approval** in
`.forge/autopilot-state.md` so a re-invocation (via native `/goal`, or after a
compaction) resumes from the furthest *approved* stage — never past an unapproved
spec.

| # | Stage (skill) | Produces | Human gate | In this example |
|---|---|---|---|---|
| 1 | `/forge` | `spec/BRIEF.md` | **BRIEF sign-off** (suggest) | [`greenfield-linear/spec/BRIEF.md`](greenfield-linear/spec/BRIEF.md) |
| 2 | `/draft-prd` | `spec/PRD.md` | **PRD review** (suggest) | [`…/spec/PRD.md`](greenfield-linear/spec/PRD.md) — 2 features |
| 3 | `/draft-spec` | `spec/SPEC.md` | **stack-choice + SPEC approval** | [`…/spec/SPEC.md`](greenfield-linear/spec/SPEC.md) — CLI + relational store |
| 3b | `/draft-design` *(optional)* | `spec/DESIGN.md` | **DESIGN review** (if UI) | [`…/spec/DESIGN.md`](greenfield-linear/spec/DESIGN.md) |
| 4 | `/ingest-spec` | `spec/CONTEXT.md` | **BLOCKING validation** | builds CONTEXT.md; blocks decompose on gaps |
| 5 | `/decompose` | `plans/phases.yaml` | **decompose review** (one round) | [`…/plans/phases.yaml`](greenfield-linear/plans/phases.yaml) — 2 phases × 3 tasks |
| 6 | `/push-to-tracker` | tracker issues + `source`/`tracker_issue_id` in phases.yaml | reporting (project URL + count) | Linear project + issues |
| 7 | `/deliver --all` | merged PRs + Done tickets | `/deliver`'s own gates (review, CI, phase-gate) | hands off; pair with `/goal "greenfield delivered"` |

At each **suggest** gate `/autopilot` STOPS and asks — it never auto-approves a
BRIEF, PRD, SPEC, DESIGN, or decomposition. The **blocking** `/ingest-spec` gate
halts the chain on any spec inconsistency. Between gates, everything is
autonomous.

## What the user actually touches

Exactly three things, the rest is driven:

1. **Interview answers** — the `/forge` discovery questions + the per-feature
   `/draft-prd` loop (see the recorded answers fixture).
2. **Spec approvals** — the BRIEF / PRD / SPEC / (DESIGN) / decompose gates.
3. **Parked decisions** — any architectural fork the loop surfaces via
   `AskUserQuestion` (or, once delivery is running, drained from `/inbox`).

## Resume behavior

`/autopilot` is re-entrant. If a turn ends mid-chain (or a session restarts):

- A stage with its artifact written but **approval not recorded** → the gate is
  **re-presented** (the existing artifact is shown, not redrafted/clobbered).
- A fully approved stage whose artifact still matches its recorded approval
  digest → skipped. (If the artifact was edited since approval, the digest
  mismatch re-presents the gate — a stale approval of changed content is never
  honored.)
- "Pushed" is detected from `source.project_id` + a `tracker_issue_id` on every
  task; a partial push re-runs `/push-to-tracker` in UPDATE mode.

## Handoff to `/deliver`

The handoff is implicit: once `/push-to-tracker` has populated the tracker and
written the ids back into `plans/phases.yaml`, `/deliver` self-services — it
reconstructs the band from tracker status + `forge orchestrate phases --ready`.
`/autopilot` simply invokes `/deliver --all` and returns; pair it with
`/goal "<product> delivered"` for hands-off, multi-turn completion.
