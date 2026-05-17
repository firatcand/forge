---
name: worktree-guard
description: Shared preflight contract for task-scoped mutating skills. Refuses to run when the session is in the main checkout on the default branch.
---

# Worktree Guard

## Problem

Multiple parallel Claude Code sessions can sit in the same main repo cwd. If they each run `git checkout`, `git commit`, or `git push` from there, they clobber a single shared `HEAD`. Branch state bleeds across sessions; PRs get pushed from the wrong branch.

`/pickup-task` already creates an isolated worktree per task. The guard enforces the contract: **task-scoped mutating skills must run from a worktree, not the main checkout.**

## Binding

When `/pickup-task` (or `forge` programmatically) creates a worktree, it writes `.forge/worktree-task.json` inside the new worktree:

```json
{
  "version": 1,
  "taskId": "FORGE-101",
  "branch": "feat/FORGE-101-foo",
  "createdAt": "2026-05-17T18:00:00.000Z",
  "createdBy": "forge/workspace.create"
}
```

This marker is the binding. Its presence tells the guard "you're in a real worktree." Its absence on the default branch tells the guard "refuse."

## Canonical guard snippet

Every task-scoped mutating skill (`plan-task`, `implement`, `qa`, `fix`, `review`, `ship`) inlines this snippet as its first step under a `## Preflight: worktree guard` heading. Skills that intentionally run from the main checkout (`sync-status`, `decompose`, `push-to-tracker`, `setup-repo`, `init`) do **not** guard.

```bash
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
if [ -z "$TOPLEVEL" ]; then
  echo "✗ worktree-guard: not inside a git repository" >&2
  exit 1
fi
BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo 'main')"
if [ -f "$TOPLEVEL/.forge/worktree-task.json" ]; then
  echo "✓ worktree-guard: $TOPLEVEL ($BRANCH)"
elif [ "$BRANCH" = "${DEFAULT_BRANCH:-main}" ]; then
  echo "✗ worktree-guard: refusing to run on default branch '$BRANCH' from $TOPLEVEL" >&2
  echo "  Parallel Claude Code sessions on the main checkout clobber each other's HEAD." >&2
  echo "  → cd into an existing worktree, or run /pickup-task to create one." >&2
  exit 1
else
  echo "⚠ worktree-guard: no .forge/worktree-task.json at $TOPLEVEL (branch: $BRANCH)" >&2
  echo "  Proceeding, but this worktree may be manually-created or stale. Re-run /pickup-task to refresh." >&2
fi
```

## Three outcomes

| State | Behavior |
|-------|----------|
| Marker present | OK — task-scoped worktree, proceed |
| No marker + on default branch | REFUSE — exit 1 with diagnostic |
| No marker + on a feature branch | Warn but proceed (manual/legacy worktree) |

## Why the warning case isn't fatal

Some users `cd` into a manually-created branch directory (no `/pickup-task` involved). That's a valid workflow — but the guard surfaces the missing marker so they can re-run `/pickup-task` to register the binding.

## Stale-marker mitigation

A marker can point at a deleted or reused worktree if state isn't kept fresh. The guard checks `git rev-parse --show-toplevel` first — if `TOPLEVEL` doesn't match the marker's recorded path, the snippet still allows the operation (the marker is informational, not authoritative for path). Authority comes from git's own worktree resolution.
