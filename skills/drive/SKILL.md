---
name: drive
description: Drive one tracker ticket end-to-end — claim, plan, implement, verify, cross-review, and ship — autonomously, pausing only for architectural decisions. The per-ticket recipe; pair with native /goal "<ticket> is merged" for unattended multi-turn completion.
tools: Bash(*), Read, Edit, Write, Task
---

# /drive

`/drive <ticket-id>` drives **one** tracker ticket as far toward "merged + Done"
as a single invocation can — claim, plan, implement, verify, cross-review, ship,
merge, mark Done, wrap up — pausing only for architectural decisions or when a
gate cannot be satisfied. It is the per-ticket recipe that codifies the proven
v0.4/v0.5 hardening-loop gauntlet (the exact loop this repo's own batches were
delivered by, by hand) into a reusable, settings-configurable forge skill that
orchestrates the EXISTING per-task skills.

## This is a per-turn recipe — NOT a loop (ADR)

`/drive` does **all it can in one invocation and then RETURNS**. It MUST NOT
self-loop: no `sleep`, no `watch`, no `while true`, no `--follow`, no
`gh pr checks --watch`. Whenever the next step is an asynchronous wait — CI
running, a human decision pending — `/drive` reports the state and returns.

The repeat-until-done behavior is owned by the **native `/goal` driver**. You run:

```
/goal "<ticket-id> is merged"
```

and the host re-invokes `/drive <ticket-id>` each turn until the ticket is merged
and Done. Keeping the loop in native `/goal`/`/loop` (not here) is what lets every
round run as a fresh, fully-budgeted interactive turn — this is the autopilot ADR
decision (`spec/decisions` / the native-/goal ADR that reframed this skill from
`/goal` to `/drive`). `/drive` is the recipe; `/goal` is the engine.

## Re-entrancy — resume, never redo

Because `/goal` re-invokes `/drive` many times for the same ticket, `/drive` must
be **idempotent per stage**: on each entry it reconstructs where the ticket
already is and resumes from the furthest completed stage. It never re-claims an
already-claimed ticket and never redoes a committed stage.

### Stage signals — durable first, note second

`/drive` infers a coarse current **stage** from DURABLE signals (the source of
truth), then reconciles its scratch note against them:

- **unclaimed** — tracker status is not In Progress and no worktree exists →
  start at step 1 (`/pickup-task`).
- **planned** — an approved/committed plan file exists for the ticket → skip
  planning; go to implement.
- **implemented** — implementation commits exist on the branch beyond the plan →
  go to verify + review.
- **in review** — a PR exists (`gh pr view`) → go to the merge-policy step.
- **parked** — the ticket is `blocked_on_question` (a human decision is pending)
  → do **NOT** resume the review/fix loop; report that it is parked for a human
  and return. A parked ticket is resumed only after its question is answered.

### Inconsistent states — recover or park, never double-claim

Durable signals can disagree (a prior turn died mid-stage, a worktree was removed,
the tracker drifted). Resolve these EXPLICITLY before doing any work — never fall
through to a fresh `/pickup-task` that would re-claim or clobber:

- **In Progress (claimed) but no worktree** → do NOT re-claim. Recover the
  worktree idempotently with `forge orchestrate ensure-worktree --task-id <id>`
  (re-hydrates the existing claim's worktree). If the claim is held by a
  *different* run / the lease is foreign, **park** (report the conflict; let the
  human or `gc` reconcile) rather than stealing it.
- **Worktree exists but tracker is NOT In Progress** → ownership has drifted
  (stale worktree, or the ticket was moved/cancelled on the tracker). Reconcile
  first — `forge orchestrate reconcile --pull` and re-read the tracker — then
  decide: if the ticket is terminal (Done/Cancelled), report + stop (don't keep
  building a dead ticket); if it's genuinely ready again, continue from the
  durable stage. Do not blindly continue on a stale worktree.
- **Note disagrees with durable signals** → durable signals win (a committed PR
  beats a stale `review_rounds` note); rewrite the note to match reality.

### Worktree-local drive note

A markdown recipe cannot remember the review↔fix round count across `/goal`
re-invocations, so `/drive` keeps its OWN scratch file in the task worktree:

```
<worktree>/.forge/drive-note.json
```

Shape: `{ "stage": "...", "review_rounds": <int>, "last_verdict": "pass|changes_requested|null", "updated_at": "<iso8601>" }`.

This is the skill's private scratch — it is **NOT** `.forge/orchestrator/` state,
so writing it does NOT violate the skill ↔ verb contract (the contract bans
hand-mutating *orchestrator* state, which all goes through CLI verbs). `/drive`
reads the note on entry to recover `review_rounds`, then **trusts the durable
signals above** for the stage if they disagree (a committed PR beats a stale
note). It rewrites the note (with `updated_at`) after each stage transition.

## Cross-review rule — the implementer never reviews its own code

The cross-review in step 8 is run by the **OTHER** model lineage — the configured
`agents.review_host_cli` (Codex or Gemini), via `forge orchestrate second-opinion`
— precisely because the model that wrote the code must not be the model that
clears it. This dual-lineage gate is the whole point of cross-review.

## Skill ↔ verb contract

`/drive` owns the UX (stage inference, orchestration of the per-task skills, the
merge decision, escalation prompts). Every change to **orchestrator** state goes
through a CLI verb — `forge orchestrate question` (escalate/park),
`forge orchestrate doctor` (drift check), `forge orchestrate second-opinion`
(cross-review). `/drive` NEVER writes into `.forge/orchestrator/` directly. (Its
own `<worktree>/.forge/drive-note.json` scratch is not orchestrator state.)

## cwd discipline — the session's hard-won rule

A subagent inherits the main-repo cwd and can silently edit `main` instead of the
worktree. So **every** subagent prompt `/drive` issues MUST begin with a cwd +
branch assertion before any edit:

```bash
cd <worktree> && git rev-parse --abbrev-ref HEAD
```

The branch must be the ticket's `feat/<ticket-id>-<slug>` before any file is
touched. `/drive` verifies the branch in the returned report against its own
measured numbers — it does not trust a subagent's self-report.

---

## The recipe (one invocation, resume-aware, then return)

Each numbered stage is skipped if the stage signals show it is already complete.

### 1. Resume-aware start

Read the ticket's CURRENT state from the tracker and the durable signals above.
If unclaimed, run **`/pickup-task`** — it claims the ticket via the tracker (sets
In Progress), creates and hydrates the worktree, and pins the session into it.
If already claimed and in a worktree, continue from the furthest completed stage.
Initialize `<worktree>/.forge/drive-note.json` if absent.

### 2. cwd discipline

Resolve `<worktree>` and assert the branch (see above). Every subsequent subagent
prompt is prefixed with the `cd <worktree> && git rev-parse --abbrev-ref HEAD`
assertion. Never edit outside the worktree.

### 3. Plan

Run **`/plan-task`** — a specialist subagent in Plan mode produces a structured
implementation plan. **Architectural forks → AskUserQuestion** (the Confusion
Protocol; will be typed via FORGE-216's question taxonomy when it lands). The
approved plan is committed; that committed plan file is the "planned" stage
signal.

### 4. Plan pre-opinion

Run **`/second-opinion review-plan`** (via `forge orchestrate second-opinion`,
routed to `agents.review_host_cli`). Fold its findings into the plan. Silent /
skipped if `second_opinion.auto_enabled: false` or `review_host_cli` is null.

### 5. Implement

Run **`/implement`** with the approved plan, via a cwd-asserted subagent. Route
the implement subagent by model: `forge orchestrate route --task ${TASK}
--attempt ${ATTEMPT} --json` → read `data.host` / `data.model` and pass `data.model`
as the subagent's `model` (for a codex spawn it flows through `DispatchOpts.model`
→ `codex exec --model`). The cwd-asserted prompt still comes FIRST. The route is
advisory — surface `data.warning` when `data.downgraded` is true. On
`NO_MODEL_AVAILABLE`, escalate rather than silently falling back.

### 6. Gate verify (independent)

Run the project gate yourself — `settings.verify` commands if present, else
typecheck + test + lint + build — and `forge orchestrate doctor --scope
spec-code`. **Trust your own measured numbers, not the implementer's
self-report.** If the gate fails, loop back to a fix subagent (counts against the
review loop cap) or escalate.

### 7. QA

Run **`/qa`** — runs the test suite + browser checks, verifies the ticket's
acceptance criteria, bootstraps the test framework if missing, and adds a
regression test for any bug fix. A QA failure routes back to a fix subagent
(within the cap) or escalates.

### 8. Review + cross-review loop (the pass + no-blocks gate)

Run the dual-lineage review:

1. **`/review`** — the PRIMARY review: code-reviewer, security-auditor on
   CRITICAL.md paths, design-reviewer on UI. (In-session subagent, subscription-
   billed.)
2. **`/second-opinion review-impl`** — the CROSS-review by the OTHER model
   (`review_host_cli`), via `forge orchestrate second-opinion`. The implementer
   never reviews its own code (see the cross-review rule above).

**Review gate (R1 — there is no numeric threshold).** forge's `ReviewVerdict`
emits only `verdict: pass | changes_requested` and `findings[].severity: block |
improvement` — there are NO numeric axis scores. The gate is therefore:

> **PASS = `verdict === 'pass'` AND zero `block` findings**, across BOTH the
> primary `/review` and the cross-review second-opinion.

If the gate is not met: spawn a cwd-asserted **fix** subagent to address the
`block` findings — route it the same way as the implement subagent (`forge
orchestrate route --task ${TASK} --attempt ${ATTEMPT} --json` → pass `data.model`
to the subagent; retry escalation means the fix subagent will often route a tier
HIGHER than the original implement). Increment `review_rounds` in the drive note,
and re-run review.
Repeat up to `drive.review_loop_cap` (default 4) rounds. If the cap is hit
without a pass, **escalate** — do NOT merge:

```bash
forge orchestrate question <ticket-id> --attempt <attempt-id> \
  --decision-key arch:drive:<ticket-id-lowercased> \
  --question "<the unresolved blocking findings + the decision needed>" \
  --recommended-option-id <id> \
  --what-happens-if-unanswered "Ticket stays parked until you decide."
```

This surfaces via AskUserQuestion and parks the ticket to `/inbox`; the next
`/goal` turn sees `blocked_on_question` and does not resume the loop.

**`review_host_cli: null` policy (R5).** When no review host is configured the
cross-review is impossible. Then:

- **Non-critical change** (no CRITICAL.md path touched) → proceed on `/review`
  (primary) alone, and DOCUMENT in the PR body that the cross-review was skipped
  because `review_host_cli` is null.
- **CRITICAL.md-touching change** → **park/escalate before merge** (same
  `question` verb above). Never silently pass the dual-lineage gate on a critical
  path. (Mirrors review-compose's park-on-missing-second-opinion logic.)

### 9. Ship

Run **`/ship`** — push the branch, run the final gates (tests, secrets scan,
conventional commit), open the PR, mark the ticket In Review.

### 10. Merge policy (single CI check per invocation — no watch)

If `drive.merge_policy: 'approval'`, the PR is opened and PARKED for a human:
report the PR URL, write the drive note (`stage: "in review"`), and return — do
NOT merge.

If `drive.merge_policy: 'auto'` (default), check CI status **once** — no polling,
no `--watch`:

```bash
gh pr view <pr> --json statusCheckRollup
```

- **pending** → report "CI pending" and RETURN. The native `/goal` driver
  re-invokes `/drive` later, which re-enters here and re-checks. (R3: a single
  status check per invocation reconciles full-drive with no-self-loop.)
- **green** → merge:

  ```bash
  gh pr merge <pr> --squash
  ```

  If the branch is behind base, update it (`gh pr update-branch <pr>`) and RETURN
  (the next turn re-checks CI on the rebased branch).
- **red** → spawn a cwd-asserted fix subagent (within `review_loop_cap`) or
  escalate via the `question` verb. Do NOT merge a red PR.

### 11. Tracker Done

On a confirmed merge, set the ticket Done through the tracker — suggest, don't
force; via the proper tracker surface (every state change through the right
channel).

### 12. Wrap-up

Run **`/wrap-up`** — remove the task worktree, delete the local branch, reconcile
the tracker into phases.yaml, and return to a clean `main`. Its own merged-PR
safety gates apply (nothing is removed until the PR is confirmed merged).

---

## HITL knobs (`.forge/settings.yaml` → `drive:`)

| Knob | Default | Meaning |
|------|---------|---------|
| `drive.review_loop_cap` | `4` | Max review↔fix rounds before escalating to a human (park to `/inbox`). |
| `drive.merge_policy` | `'auto'` | `auto` = merge on green CI; `approval` = open PR and park for a human merge. |

There is intentionally **no** `review_threshold` knob (R1): forge's
`ReviewVerdict` has no numeric scores, so the gate is the pass + no-`block`
findings rule above, not a number.

The block is fully defaulted (`.default({})`), so a `settings.yaml` with no
`drive:` section yields `{ review_loop_cap: 4, merge_policy: 'auto' }`.

## Escalation → /inbox

Every cap-hit, red-CI-unfixable, missing-cross-review-on-critical-path, or
architectural fork escalates through `forge orchestrate question`, which parks the
ticket to `/inbox` for a human decision and surfaces it via AskUserQuestion.
`/drive` never merges past an unresolved escalation.

## Native-/goal pairing

`/drive <ticket-id>` does one turn's worth of work and returns;
`/goal "<ticket-id> is merged"` re-invokes it each turn until done. Run them
together for hands-off, multi-turn completion of a single ticket. Do not wrap
`/drive` in your own loop — the engine is native.

## Future integration points

- **FORGE-192 (Autopilot I6)** — threading the routed model through the manifest /
  render-worker-prompt for a fully-forge-owned interactive dispatch. Today `route`
  (FORGE-210, consumed in steps 5 + 8) is advisory: the skill reads it and passes
  the model to its own subagent spawn; codex spawns enforce it via `--model`.
- **FORGE-216** — the question taxonomy will type the architectural-fork
  AskUserQuestion prompts.
- **Numeric review scoring** — a future ticket could extend `ReviewVerdict` +
  the second-opinion harness + the parser with axis scores and reinstate a
  `review_threshold` knob. Not built now (R1).
