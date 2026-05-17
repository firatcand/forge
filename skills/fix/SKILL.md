---
name: fix
description: Apply a fix based on /investigate output. Refuses to run without recent investigation.
tools: Edit, Read, Bash(*)
---

# /fix

## Preflight: worktree guard

Task-scoped mutating skill — must run from a worktree, not the main checkout. Contract: `skills/_shared/worktree-guard.md`.

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
  echo "  Proceeding, but this worktree may be manually-created or stale." >&2
fi
```

## Preconditions

`plans/tasks/{LINEAR-ID}.investigation.md` must exist and be < 24 hours old.

## Process

1. Read investigation
2. Apply minimal fix matching root cause
3. Add regression test that reproduces the original bug (Test-or-die)
4. Verify fix + test passes
5. Commit with conventional message: `fix(scope): brief description`

## After 3 failed attempts

Stop. Demand fresh `/investigate`. Do not thrash.
