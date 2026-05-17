---
name: review
description: Run code-reviewer, security-auditor (if CRITICAL.md path touched), and design-reviewer (if UI task) on current diff.
tools: Read, Bash(git*)
---

# /review

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

## Process

1. Run `git diff main...HEAD` to get current diff
2. Always invoke `code-reviewer` subagent
3. If diff touches paths in CRITICAL.md, invoke `security-auditor`
4. If task type is "design" or "frontend", invoke `design-reviewer`
5. Aggregate findings; categorize by severity (block / improvement / nit)
6. Print summary; ask user to address blocks before /ship

## Output

Markdown summary of findings per reviewer, with file:line references.
