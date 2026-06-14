---
name: inbox
description: Drain parked decisions — read a tagged digest of every blocked_on_question task's open questions, pick which to answer now, deep-dive each via AskUserQuestion, and record the answer through the answer verb. One pass, suggest-don't-force, no self-loop.
tools: Bash(forge*), Read
---

# /inbox

`/inbox` is the single interactive surface for draining **parked decisions** —
tasks sitting in `blocked_on_question` because a worker (or a review/drive
escalation) hit a fork it could not resolve autonomously and wrote a
`forge orchestrate question`. The skill reads the inbox, shows a tagged digest,
lets the user pick which question(s) to answer now, deep-dives each one via
`AskUserQuestion` (per `skills/_shared/question-format.md`), and records the
chosen option through the **answer verb**. It does one pass and returns.

## This is one pass — NOT a loop

`/inbox` reads the current parked set, drains what the user picks, and RETURNS.
It MUST NOT self-loop: no `sleep`, no `watch`, no `while`, no `--follow`, no
`--watch`. A newly-parked question that arrives after this pass is surfaced the
next time the user runs `/inbox` (or by `/statusline`). There is no daemon.

## Skill ↔ verb contract

`/inbox` owns the UX — the digest, the pick, the per-question deep-dive prompt.
The **answer verb owns the state write.** Recording an answer goes through
`forge orchestrate answer`; `/inbox` NEVER writes into `.forge/orchestrator/`
directly. The parked worker's own next heartbeat picks the answer up and
transitions `blocked_on_question → awaiting_respawn` — `/inbox` does **not**
transition task state itself.

`/inbox` spawns no subagents (no `Task` tool): the deep-dive is a direct
`AskUserQuestion` to the user, and the only mutation is the answer verb.

---

## Step 1 — Read the inbox (read-only)

```bash
forge orchestrate inbox --json
```

Parse the envelope's `data`:

- `data.parked_tasks[]` — each parked task: `task_id`, `state`
  (`blocked_on_question`), and `open_questions[]`. Each open question carries
  `question_id`, `decision_key`, `question` (the prompt text), `options[]`
  (each with `id`, `label`, optional `description`), `recommended_option_id`
  (optional), `classification` (with `decision_type` + `category`), and
  `created_at`.
- `data.by_category` — a sparse `{ category: count }` tally of open questions
  across all parked tasks (only categories with ≥1 open question appear).

## Step 2 — Digest

If there are no open questions across any parked task (every
`open_questions[]` is empty, or `parked_tasks` is empty), print
`Inbox empty — no parked decisions.` and STOP.

Otherwise print a TAGGED digest. For each parked task, list its open questions:

```
<task_id> [<state>]
  [<question_id>] <decision_key> (<decision_type>/<category>) · <age>
    Q: <question text>
```

where `<age>` is derived from `created_at` (e.g. `3h`, `2d`). Close with a
one-line category summary from `by_category`:

```
By category: <cat>=<n>, <cat>=<n>
```

**Sort hint.** Surface the highest-stakes decisions first — architectural /
low-reversibility / wide-blast-radius questions (read `classification`:
architectural `decision_type`, and categories like `schema_shape`,
`compat_policy`, `enforcement_mode`, `provider_choice`, `security_tradeoff`
typically rank above local naming / scope calls). This is presentation order
only — it changes nothing on disk.

## Step 3 — Pick

Let the user choose which question(s) to answer now. They may drain several in
one pass, or just one — **suggest-don't-force**: never auto-answer, and the user
is not required to clear the whole inbox. If they pick nothing, return cleanly.

## Step 4 — Deep-dive each picked question (AskUserQuestion)

For each picked question, present via `AskUserQuestion` following ALL FIVE
required parts in `skills/_shared/question-format.md`:

1. **Re-ground** — name the task (`task_id`) and the `decision_key` so the user
   knows exactly which fork this is (they've been away).
2. **Simplify** — restate the worker's `question` in plain English (what it
   actually does, not internal jargon); include the `context` if present.
3. **Recommend** — if `recommended_option_id` is set, mark that option as the
   recommended default with a one-line reason.
4. **Options** — present **EVERY** option in `open_questions[].options` (the
   schema allows up to 10). Map each displayed choice back to its exact
   `option.id` — NEVER drop an option. `AskUserQuestion` shows up to 4 choices,
   so when a question has more than 4 options, list ALL of them (`id` + `label`)
   in the prompt body and have the user pick by id (or use AskUserQuestion for
   the first few plus "Other" and resolve the user's pick to the exact
   `option.id`). The id passed to `answer` MUST be one of the question's option ids.
5. **Trade-off per option** — surface each `options[i].description` as that
   option's concrete trade-off line (no fake trade-offs).

## Step 5 — Answer (the verb owns the write)

Resolve the user's selection — whether an AskUserQuestion choice or a typed
option id (for >4-option questions) — back to the matching `options[N].id`, then
record it through the answer verb:

```bash
forge orchestrate answer "<question_id>" --option "<option_id>"
```

Add `--note "<supervisor note>"` when the user wants to attach rationale.

**No `--json` flag** — the answer verb returns plain text
(`Answered <id> with option <id>.`); correlate the result back to the question
by its `question_id` alone, not by parsing structured output.

Handle the verb's failures:

- **`DUPLICATE_ID`** (a concurrent supervisor / driver already answered this
  question) → print `[skip] <question_id> already answered` and move on to the
  next picked question. Not an error for this pass.
- **`NOT_FOUND`** (the question id no longer exists) or **invalid option** (the
  chosen option id isn't one of `options[]`) → surface the verb's error to the
  user; do not silently swallow it.

## Step 6 — Report

After draining the picked questions, print a one-line summary and RETURN:

```
✓ /inbox: 2 answered, 1 skipped (already answered). Parked workers pick up
  their answers on the next heartbeat (blocked_on_question → awaiting_respawn).
```

State explicitly that `/inbox` did NOT transition any task state — the answer
verb wrote the answer and each parked worker advances itself on its next
heartbeat.

## What the skill must NOT do

- Never write into `.forge/orchestrator/**` directly — the answer verb owns
  every state write.
- Never self-loop — no `sleep` / `watch` / `while` / `--follow` / `--watch`.
  One pass per invocation, then return.
- Never auto-answer — every answer is an explicit user choice via
  `AskUserQuestion` (suggest-don't-force).
- Never pass `--json` to the answer verb — it has no JSON mode; it returns plain
  text and is correlated by `question_id`.
