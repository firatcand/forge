# When a new skill reveals an existing spec violation, fix both in the same PR
> 2026-05-18 · FORGE-98 · tags: [architecture, skills, spec]

## What we expected
ORCHESTRATOR.md §80-98 says "skill MUST NOT write to `.forge/worktrees/`". The plan was to write the new dispatch skill the same way the existing `/pickup-task` skill did — direct `git worktree add` from a bash block inside the skill.

## What happened
Codex 2nd-pass on the plan caught it: `/pickup-task` was already violating ORCHESTRATOR.md §80-98. The new skill couldn't legitimately follow that precedent. Resolution: add a new `forge orchestrate ensure-worktree` CLI verb owning that path, then refactor `/pickup-task` to call it. Both changes landed in the same PR.

## Why
When a new feature surfaces an existing-but-undetected spec violation, the right move is to fix the inconsistency in-PR, not add a second violator. Spec-vs-code drift compounds; each additional violator raises the cost of a future reconciliation pass.

## Next time
When a planned skill needs a capability the spec restricts to CLI verbs, first audit whether existing skills already do the restricted thing. If they do, refactor in the same PR via a new verb. Do not grandfather in violations.
