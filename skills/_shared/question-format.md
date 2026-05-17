---
name: question-format
description: Canonical format for forge skills that emit AskUserQuestion. Required for all skills that pause for user decisions.
---

# Question Format

When a forge skill needs to ask the user a question (architectural fork, scope decision, naming, etc.), it must use this format. The format applies to `AskUserQuestion` calls in Claude Code and to equivalent pause-and-ask prompts in Codex CLI, Cursor, or Gemini sessions.

## The five required parts

| # | Part | Why |
|---|------|-----|
| 1 | **Re-ground** | The user hasn't looked at the window in 20 minutes. State project, branch, current task in 1-2 sentences. |
| 2 | **Simplify** | Explain in plain English a smart 16-year-old could follow. No internal jargon, no raw function names. Use analogies and concrete examples. Say what it does, not what it's called. |
| 3 | **Recommend** | One sentence: `RECOMMENDATION: Choose [X] because [reason]`. Default to the more complete option (Boil the Lake). |
| 4 | **Options** | `A) ... B) ... C) ...` — 2 to 4 mutually exclusive choices. Show effort on both scales when relevant: `(human: ~1hr / CC: ~10min)`. |
| 5 | **Trade-off per option** | Every option carries both a benefit and a concrete trade-off — what this choice costs, makes harder, locks in, or trades away. |

## Trade-off rules

- **Be concrete.** "Locks us to Vendor X for 2 years", "doubles migration time", "requires a follow-up refactor in module Y" — not "harder to maintain", "may have issues", "less flexible."
- **Tie to stated constraints.** If the user has named timeline, team size, irreversibility tolerance, or existing code constraints, ground the trade-off in those.
- **Surface irreversibility.** If one option is harder to back out of than another, call that out: *"reversible in a sprint"* vs *"locks the API contract for shipped users."*
- **Surface blast radius.** Say who or what else this affects: *"changes the public CLI surface — adopters get a different install flow"* vs *"isolated to this module."*

## Escape hatch — no fake trade-offs

If the options are genuinely equivalent on cost and risk and differ only in style or naming, **say so explicitly**:

> No meaningful trade-off — this is a naming preference.

Do not invent contrast. Forced trade-offs train the user to ignore the trade-off line, which defeats the purpose.

## Example — good

> **Project:** forge / `feat/FORGE-101-worktree-guard`
>
> **Task:** Decide how the worktree-guard preflight validates "you're in a real worktree."
>
> The guard needs a marker that says "this directory was created by `/pickup-task`." Two ways to put it on disk:
>
> **A. Marker file inside the worktree** (`.forge/worktree-task.json`)
> - Pro: source of truth lives with the worktree; survives reboots.
> - Trade-off: adds an untracked file the cleanup function must whitelist. ~5 extra lines in `cleanup()`.
>
> **B. State directory in main repo** (`.forge/orchestrator/tasks/{ID}/worktree.json`)
> - Pro: main repo can list all active worktrees centrally.
> - Trade-off: state in main repo can go stale if the worktree is deleted manually. Adds a second source of truth that must be kept in sync.
>
> RECOMMENDATION: A — single source of truth, smaller blast radius. The cleanup whitelist is a one-line addition.

## Example — bad (forced contrast)

> A. Use `taskId` field — pro: clear. trade-off: longer than `id`.
> B. Use `id` field — pro: short. trade-off: ambiguous.

Both trade-offs are made up. The right answer here:

> No meaningful trade-off — this is a naming preference. Defaulting to `taskId` for clarity.

## When to ask vs decide

A question is worth asking when **any** of these apply (per Confusion Protocol, ETHOS §3):

- The decision is architectural (touches public API, schema, dependency graph, file lifecycle).
- The decision is hard to reverse (locks in vendor, contract, or migration).
- The blast radius is module-level or larger (affects other tasks, other adopters, shipped code).
- The plan tree materially branches on the answer (i.e. the next 3-5 steps change).

Decisions that **do not** require asking: routine internal naming, local refactors with no API impact, trivial style choices, anything fully reversible within the current task.

## Failure modes the format prevents

- **Decision-bundling.** Burying 11 decisions in a "Questions decided" table and asking for one approval lets the user rubber-stamp without seeing forks. Per-fork questions force visibility.
- **Benefits-only options.** Without trade-offs, the user reads two pro lists and picks the one that sounds better — usually the agent's recommendation. The trade-off is what creates real choice.
- **Jargon-only phrasing.** "Should we use a Trie or a HashMap?" excludes a user who knows the domain but not the data structure. The Simplify step makes the choice legible.
