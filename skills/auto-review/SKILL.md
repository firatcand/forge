---
name: auto-review
description: Drain the orchestrator review-queue — for each task awaiting review, run the code-reviewer, optionally a Codex/Gemini second opinion on CRITICAL.md paths, compose a verdict, and advance it to reviewed or escalate an architectural finding to you. Interactive session only.
tools: Bash(forge*), Bash(git*), Task, Read
---

# /auto-review

Drain the orchestrator **review-queue**: for each task sitting in
`ready_for_review`, run the review, compose a single verdict, and either advance
the task to `reviewed` or escalate an architectural finding to you for a
decision.

## This is a per-turn recipe — NOT a loop

This skill performs **one drain pass over the head of the queue per
invocation**: it reviews exactly one task, acts on it, and returns. It does
**not** sleep, poll, watch, or `while`-loop, and it never runs in headless mode.

The repeat-until-empty behavior is owned by the **native `/goal` driver** — you
run `/goal "the review-queue is empty"`, and the host re-invokes this recipe
each turn until `forge orchestrate review-queue --json` reports an empty queue.
Keeping the loop in `/goal` (not here) is what lets every round run as a fresh,
fully-budgeted interactive turn.

## Interactive session only — billing invariant

This skill runs **only in an interactive session**, for two reasons:

1. **Escalation needs structured input.** An architectural finding is surfaced
   to you through the host's `AskUserQuestion` / `Task` tooling — there is no
   non-interactive path for a human decision.
2. **Billing invariant.** The primary review runs as an **in-session subagent
   under your subscription** via the host `Task` tool. This skill NEVER shells
   out to `claude -p`, `claude --print`, the Anthropic API, or any headless
   metered invocation. The only external reviewer it may call is the configured
   `second-opinion` host (Codex/Gemini), and only on a critical path.

## Skill ↔ verb contract

This skill owns the UX (queue read, review orchestration, the compose decision,
confirmations). Every state change goes through a CLI verb:
`forge orchestrate complete` (advance) or `forge orchestrate question`
(escalate/park). The skill NEVER mutates orchestrator state by hand and NEVER
writes into `.forge/orchestrator/` directly.

---

## Per-round flow (one task, then return)

### 1. Read the head of the queue

```bash
forge orchestrate review-queue --json
```

If `data.tasks` is empty, report **"review-queue empty"** and stop — the `/goal`
driver sees the empty queue and ends. Otherwise take the head task and note its
`task_id`, `current_attempt_id`, and `write_globs`.

### 2. Capture the diff (in the task worktree)

```bash
git diff origin/main...HEAD > /tmp/auto-review-<task_id>.diff
```

If the diff exceeds **1MB**, skip the second opinion and escalate (the diff is
too large to review safely in one pass) — go to step 6's escalate branch.

### 3. Primary review — in-session subagent (subscription-billed)

Spawn the `code-reviewer` agent (`agents/code-reviewer.md`) through the host
**`Task`** tool. Require it to return a fenced-JSON `ReviewVerdict`
(`{version, verdict, findings, host}`).

The in-session primary reviewer is Claude, so the verdict file it writes carries
`host: "claude"` (the `ReviewVerdict` schema now permits `claude` for the
primary review; the `second-opinion` verb still only emits `codex`/`gemini`).
Write the verdict the subagent returns to `/tmp/auto-review-<task_id>.primary.json`.

If the subagent's output is unparseable, treat it as `changes_requested` and
stop the round (do not guess).

> **Codex-primary (deferred):** when the primary host is Codex rather than
> Claude, the primary review would instead be obtained through the Codex
> adapter. That adapter touchpoint is **deferred** — this skill ships the
> Claude-primary path only.

### 4. Architectural-path detection

```bash
git diff --name-only origin/main...HEAD
```

For each changed path:

```bash
forge orchestrate guardrail-check --path <p> --json
```

Collect the paths whose envelope reports `matched_glob != null`. If any matched,
set `hasCriticalPath = true`.

### 5. Conditional second opinion

Only if `hasCriticalPath` is true **and** a review host is configured
(`review_host_cli != null`):

```bash
forge orchestrate second-opinion --task <task_id> --diff /tmp/auto-review-<task_id>.diff --prompt /tmp/auto-review-<task_id>.prompt --json > /tmp/auto-review-<task_id>.second.json
```

Otherwise omit the second opinion entirely (compose receives no
`--second-opinion`). The `second-opinion` verb's `--json` envelope can be fed
straight into `review-compose` — it unwraps the `{ok,data:{verdict}}` shape.

### 6. Compose the verdict

```bash
forge orchestrate review-compose \
  --primary /tmp/auto-review-<task_id>.primary.json \
  [--second-opinion /tmp/auto-review-<task_id>.second.json] \
  --branch <branch> --summary "<one-line summary>" \
  [--critical-path] [--second-opinion-available] --json
```

Act on `data.kind`:

- **`verdict`** — write the returned machine `Verdict` to
  `/tmp/auto-review-<task_id>.verdict.json`, then advance the task:

  ```bash
  forge orchestrate complete <task_id> --attempt <current_attempt_id> --verdict-file /tmp/auto-review-<task_id>.verdict.json --phase review
  ```

  (`ready_for_review` → `reviewed`; `changes_needed` → loops back to `running`.)

- **`escalate`** — an architectural block finding on a critical path; a human
  decides. Open a question (which surfaces via `AskUserQuestion` and parks the
  task):

  ```bash
  forge orchestrate question <task_id> --attempt <current_attempt_id> \
    --decision-key arch:auto-review:<task_id_lowercased> \
    --question "<the architectural finding + the decision needed>" \
    --options-file <path> \
    --recommended-option-id <id> \
    --what-happens-if-unanswered "Task stays parked until you decide." \
    --classification-file <path>
  ```

  (The `--decision-key` must be lowercase `a-z0-9._:-`, so lowercase the task id
  when building it. `--recommended-option-id` must match one of the question's
  options — the verb defaults to a `yes`/`no` set unless you pass an
  `--options-file`.)

  **Classification discipline (FORGE-216).** Pass `--classification-file <path>`
  (a `DecisionClassification` JSON) so `/inbox` + statusline can group the
  escalation by `category`. Pick the BEST-FIT value: `schema_shape`,
  `compat_policy`, `enforcement_mode`, `scope_cut`, `provider_choice`, `release`,
  `security_tradeoff` for delivery decisions; `public_api`, `scope`, `naming`,
  `deprecation`, `error_semantics`, `file_lifecycle` for code decisions; `other`
  when nothing fits. Without the flag the verb defaults to `category: "other"`.
  Every escalation should carry options-with-tradeoffs, a recommendation, and a
  what-happens-if-unanswered alongside the classification.

- **`park`** — a second opinion was required (critical path) but unavailable.
  Leave the task in the queue, report `data.reason`, and make **no** state
  transition. The next `/goal` turn re-evaluates it.

Then return — the `/goal` driver re-invokes for the next queue head.

---

## Host-adapter interface (4 touchpoints)

This skill is host-agnostic at the four boundaries where it talks to a model or
the orchestrator. Codex-primary variants are **deferred** (Claude-primary
ships now):

1. **Review-queue read** — `forge orchestrate review-queue --json` (host-neutral).
2. **Primary-review spawn** — host `Task` tool → `code-reviewer` subagent,
   subscription-billed. *(Codex-primary: deferred.)*
3. **Second-opinion dispatch** — `forge orchestrate second-opinion`, routed to
   the configured Codex/Gemini host; only on a critical path.
4. **Complete / question write** — `forge orchestrate complete` (advance) or
   `forge orchestrate question` (escalate/park). The skill never writes state
   directly.
