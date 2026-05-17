---
name: qa
description: Run test suite, browser checks, and verify acceptance criteria. Bootstrap test framework if missing.
tools: Bash(*), Read, Edit
subagent: qa-engineer
---

# /qa

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

Delegate to `qa-engineer` subagent.

## Process

1. Detect test framework — if absent, offer to bootstrap (Vitest + Playwright defaults)
2. Run unit + integration tests
3. For UI tasks: run Playwright on key flows from PRD
4. Verify acceptance criteria from Linear issue are met
5. Report failures; auto-suggest fixes for trivial ones

## Test-or-die enforcement

If task is a bug fix and there's no regression test, REFUSE to pass /qa. Generate the regression test first.
