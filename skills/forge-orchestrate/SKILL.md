---
name: forge-orchestrate
description: Per-round dispatch loop for forge's orchestrator. Lists ready tasks, asks user to approve, then claims, dispatches, and spawns worker subagents via the host's Task tool. Polls open questions and surfaces them for user answers. Suggest-don't-force — no automatic claim, no internal long-polling.
tools: Read, Bash(*)
---

# /forge orchestrate

> **Status queries always hit the tracker. `plans/phases.yaml` is a stale cache.** See your project `CLAUDE.md` §Source of truth.

The user-facing dispatch loop for forge's orchestrator. Drives one **round**
per invocation:

1. List ready tasks (read-only) → 2. user approves → 3. claim + dispatch the
selected tasks → 4. spawn worker subagents via the host's Task tool → 5. poll
open questions for that run → 6. surface each to the user → 7. record answers
→ 8. ask user whether to continue with another round.

No daemon. No automatic dispatch. The skill exits after each round; the user
re-invokes `/forge orchestrate` to start the next round.

Drift-routed questions, `drift_event_id`, and `routing_hint` are **dropped in
v0.4** per `docs/plans/team-mode-minimum-architecture.md` §3. Workers emit
plain questions only; the skill consumes them via `questions --open --json`.

## Preconditions

- `.forge/settings.yaml` exists with a `tracker:` block
- `plans/phases.yaml` exists and validates (run `/reconcile --pull` first if not)
- `templates/worker-prompt.template.md` exists (shipped with the framework)

## Step 0 — Start a run

A "run" is a single supervisor session. Every subsequent verb call needs the
run_id so questions and dispatch records stay scoped to this session.

```bash
forge orchestrate run start --json
```

Parse `data.run_id` and keep it in your skill context for the rest of the
invocation. If you need a friendly name, pass `--name "<short label>"`.

## Step 1 — List ready tasks (read-only)

```bash
forge orchestrate phases --ready --run "${RUN_ID}" --limit 5 --json
```

Parse `data.tasks[]`. Each entry has `task_id`, `title`, `phase`, `priority`,
`estimate`, `depends_on`, and an `overlap` object showing whether the task's
write globs collide with anything already in-flight.

If `data.tasks.length === 0`, print `"No ready tasks."` and exit 0.

## Step 2 — Ask the user which tasks to dispatch

Use `AskUserQuestion` (contract: `skills/_shared/question-format.md`):

- Re-ground with project + branch + "Pick tasks to dispatch this round."
- Show one option per ready task: `<task_id>: <title> (P<priority>, <estimate>)`
- Add three meta-options: `all`, `skip`, `stop`
- Highlight any task with `overlap.classification !== "isolated"` as a yellow
  flag in the description (concurrent dispatch may collide on write paths)

If the user picks `stop`, exit 0 immediately — no further work.
If the user picks `skip`, jump to Step 5 (poll open questions only).
If the user picks a single `task_id` or `all`, proceed to Step 3.

**Suggest-don't-force.** Never auto-pick. Even when one task is "obviously
next," the user must say so.

## Step 3 — For each selected task: ensure-worktree → claim → dispatch → render → spawn

**Order matters** — `ensure-worktree` runs BEFORE `claim` so a worktree
failure (disk full, conflicting marker) doesn't leak a held claim:

```bash
# 3a. Idempotent worktree create + hydration (CLI owns .forge/worktrees/).
ENSURE_OUT=$(forge orchestrate ensure-worktree --task "${TASK_ID}" --json)
# Parse data.worktree_path; on WORKTREE_CONFLICT, log [skip] and continue to next task.

# 3b. Atomic claim (tracker CAS + local lease).
CLAIM_OUT=$(forge orchestrate claim "${TASK_ID}" --run "${RUN_ID}" --json)
# On VERSION_CONFLICT / ALREADY_CLAIMED-from-different-run: another supervisor won.
# Log [skip] FORGE-X claimed by another run, continue to next task. Worktree
# from 3a remains — that's fine, it's idempotent on the next attempt.

# 3c. Register the worker attempt (writes manifest, transitions state to 'dispatched').
DISPATCH_OUT=$(forge orchestrate dispatch "${TASK_ID}" \
  --claim "${CLAIM_ID}" --run "${RUN_ID}" \
  --worktree "${WORKTREE_PATH}" --json)
# On LEASE_STOLEN: log [skip], suggest `forge orchestrate gc` to reconcile.

# 3d. Render the worker prompt (read-only; sources context from phases.yaml,
# CLAUDE.md, settings.yaml, attempt manifest, prior attempts, answered Qs).
RENDER_OUT=$(forge orchestrate render-worker-prompt \
  --task "${TASK_ID}" --attempt "${ATTEMPT_ID}" --json)
# On TASK_NOT_IN_PHASES: print "task missing from phases.yaml — run /reconcile --pull",
# then `forge orchestrate cancel ${TASK_ID} --reason "task not in phases"` to
# unwind the dispatch. Continue to next task.
# On TEMPLATE_NOT_FOUND / PHASES_NOT_FOUND: same pattern — surface, suggest cancel, move on.

# 3d-bis. Route the worker to a concrete host:model (FORGE-210). Composes the
# task's model_tier stamp + critical-path / retry escalation, the model catalog,
# and live per-host availability into one decision (with warn-downgrade). Passing
# --attempt records a `model_routed` audit event on the held lease.
ROUTE_OUT=$(forge orchestrate route \
  --task "${TASK_ID}" --attempt "${ATTEMPT_ID}" --json)
# Parse data.host / data.model / data.tier_effective / data.downgraded / data.warning.
# This verb is ADVISORY — it returns the decision; the skill enforces it at spawn
# (3e). On NO_MODEL_AVAILABLE: surface data.error.message, log [skip], move on.
# Surface data.warning (the downgrade notice) to the user when data.downgraded.
```

Parse `data.question_budget` from the render response. The rendered prompt
already injects the matching `--question-budget-soft` / `--question-budget-hard`
flags into its `forge orchestrate question` examples, plus a soft-cap warning
when the task has crossed its soft budget. Do not strip or rewrite those lines.

**Worker escalation discipline (FORGE-216).** Every `forge orchestrate question`
a worker writes should carry options-with-tradeoffs (`--options-file`), a
recommendation (`--recommended-option-id`), a what-happens-if-unanswered, AND a
typed classification (`--classification-file <path>`, a `DecisionClassification`
JSON) so `/inbox` + statusline can group by `category`. Pick the BEST-FIT
category: `schema_shape`, `compat_policy`, `enforcement_mode`, `scope_cut`,
`provider_choice`, `release`, `security_tradeoff` for delivery decisions; the
code-shaped values (`public_api`, `scope`, `naming`, `deprecation`,
`error_semantics`, `file_lifecycle`) for code decisions; `other` as the fallback.
Without `--classification-file` the verb defaults to `category: "other"`.

**3e. Spawn the worker subagent via the host's Task tool.**

The CLI does NOT spawn — it only writes the manifest and renders the prompt.
The skill calls the host's `Task` tool (Claude Code) or its equivalent (Codex
native subagents) with:

- `prompt`: the `data.prompt` string from `render-worker-prompt`
- `subagent_type`: the worker agent for this host (e.g., `general-purpose` on
  Claude, or a host-specific type per `data.host` from the render verb)
- `model`: the routed model from `route` (3d-bis `data.model`). This is the
  ENFORCEMENT point for the advisory route: for a Claude worker, pass it as the
  Task tool's `model` param; for a forge-owned codex spawn, it flows through
  `DispatchOpts.model` → `codex exec --model`. Threading the routed model all the
  way through the manifest for a fully-forge-owned interactive dispatch is
  Autopilot I6 (FORGE-192) — not yet wired here.
- working directory hint: the `data.worktree_path` so the worker operates in
  isolation

The Task tool runs synchronously — it returns when the worker subagent
finishes its attempt (either by calling `forge orchestrate complete` or by
blocking on a question via `forge orchestrate question`).

Do not parse the subagent's output to drive state; the worker writes its own
state transitions through the CLI verbs. The skill's job is only to spawn
and move on.

## Step 4 — Repeat 3 for each selected task

If the user picked `all`, loop through `data.tasks[]` calling Step 3 for each.
Failures on one task don't abort the loop — the skill drops the failing task
and continues to the next.

After all selected tasks have been dispatched (and their workers returned),
proceed to Step 5.

## Step 5 — Poll open questions for this run

```bash
forge orchestrate questions --open --run "${RUN_ID}" --json
```

Parse `data.questions[]`. Each open question has:
- `question_id`, `task_id`, `decision_key`, `question` (the prompt), `context`
- `options[]` — each with `id`, `label`, and optional `description`
- `recommended_option_id` (optional — the worker's suggested default)
- `expires_at` (informational — verb decides budget)
- `classification` — for severity context

If `data.questions.length === 0`, skip to Step 6.

For each question, present via `AskUserQuestion`:

- Re-ground: which task it's from, what decision_key it is
- Show the worker's question + context
- Map each `options[i]` to an A/B/C/D UI option
- If `recommended_option_id` is set, mark that option as recommended

Translate the user's letter back to `options[N].id` and record the answer:

```bash
forge orchestrate answer "${QUESTION_ID}" --option "${OPTION_ID}" --json
```

On `DUPLICATE_ID` (another supervisor answered concurrently): log
`[skip] Q-X already answered`, move to next question.

## Step 6 — Continue or stop

After dispatching tasks and answering all open questions, ask one more time:

`AskUserQuestion("Continue with another round?" yes / no)`

- yes: jump back to Step 1
- no: exit 0 with a one-line summary

## Output template

```
✓ /forge orchestrate round complete:
  - 3 tasks dispatched (FORGE-99, FORGE-100, FORGE-101)
  - 1 question answered (FORGE-99 decision_key=worktree-naming)
  - Run: 01900000-0000-7000-8000-aaaaaaaaaaaa
```

## What the skill must NOT do

Per `spec/ORCHESTRATOR.md` §80-98:

- Never write to `.forge/orchestrator/**` directly — all state changes go
  through CLI verbs (`claim`, `dispatch`, `answer`, `complete`, `cancel`, `gc`)
- Never run `git worktree add` from the skill — use `ensure-worktree`
- Never auto-claim or auto-dispatch — every mutation requires explicit user
  approval via `AskUserQuestion`
- Never poll continuously — one round per invocation, then exit

## Edge cases

- **Empty ready list.** Step 1 returns no tasks → print message → exit 0.
- **All selected tasks fail at ensure-worktree.** Round produces no dispatch;
  still poll open questions in Step 5 (a previous round may have left some).
- **Subagent crashes / never returns.** Out of skill scope — the worker's
  lease will expire (heartbeat-driven) and `forge orchestrate gc` will
  reconcile on next invocation.
- **User invokes /forge orchestrate without ever picking a task** (always
  picks `stop`): exit cleanly with no state change.
- **render-worker-prompt fails after dispatch succeeded.** Manifest is
  written but no worker exists. Skill surfaces the error and prints
  `forge orchestrate cancel <task_id> --reason "<reason>"` as the suggested
  recovery — does NOT auto-cancel. User decides.

## Exit codes

- `0` — success (round complete, or user typed `stop` cleanly)
- `1` — preconditions failed (no settings.yaml, no phases.yaml, etc.)
- `2` — partial round failure (≥1 task dispatched but others errored;
  details in the summary). Skill still exits cleanly.
