---
name: ship
description: Push branch, run final gates (tests, secrets scan, conventional commit), open PR with Linear issue ID, mark issue In Review.
tools: Bash(*), Read
---

# /ship

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

## Gates (all must pass)

1. **Tests**: `npm test` (or detected equivalent) passes
2. **Type check**: `npm run typecheck` (if applicable) passes
3. **Lint**: `npm run lint` (if applicable) passes
4. **Secrets scan**: `gitleaks detect` on the diff
5. **Conventional commit**: at least one commit on this branch follows `feat|fix|chore|docs(scope): message`
6. **Test-or-die**: new code has new tests; bug fixes have regression tests
7. **Multi-model review**: if diff touches CRITICAL.md paths, `/codex review` was run

If any gate fails, list what's missing. Do not proceed.

## Push and PR

1. `git push origin HEAD`
2. `gh pr create --base dev --title "[LINEAR-ID] {title from issue}" --body "{description}"`
3. PR body template:
   - What changed (3-5 bullets)
   - Why
   - How to test
   - Linked: closes #LINEAR-ID
4. Linear native sync: issue auto-moves to "In Review"

## Output

PR URL. Linear issue link. Reminder to run `/learn` if anything notable happened.
