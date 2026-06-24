# Ticket AC list is a snapshot — check merged sibling PRs before planning
> 2026-05-17 · FORGE-115 · tags: [workflow, pickup-task, plan-task]

## What we expected
Linear AC bullets accurately represent the remaining scope at pickup time. Implement against them verbatim.

## What happened
FORGE-115's AC was authored at 13:21. PR #160 (worktree-marker contract + skill preflight guards) merged at ~16:00, covering territory that overlapped three of FORGE-115's AC bullets. By pickup time (16:56), part of the scope was already shipped. Implementing against the raw ticket would have re-done or misread already-landed work.

## Why
A ticket is authored once; the codebase moves continuously. Sibling PRs can partially pre-implement, partially conflict with, or reframe a ticket's scope between authoring and pickup. Linear has no mechanism to auto-update AC bullets when adjacent work lands. Treating the ticket as ground truth causes redone work, missed deltas, or incorrect "done" assessments.

## Next time
At the start of `/plan-task`, run:

```bash
gh pr list --state merged --limit 20 --json number,title,mergedAt
```

Grep for the ticket ID, related component names, and the same files the ticket touches. If anything overlaps, add a "scope reality check post-#N" subsection to the plan that explicitly names what was pre-shipped, what changed, and what remains. This mirrors the Codex "rebased onto current main" precondition — extend it to plan-time, not just review-time.
