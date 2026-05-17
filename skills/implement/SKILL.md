---
name: implement
description: Execute the approved plan from /plan-task. Refuses to run without an approved plan unless --quickfix flag.
tools: Edit, Read, Write, Bash(*)
---

# /implement

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

- `plans/tasks/{LINEAR-ID}.plan.md` exists and was committed
- OR `--quickfix` flag with justification

## Execution

1. Read plan
2. Execute step-by-step, committing after each logical unit
3. Use conventional commit messages
4. **Mid-implementation forks:** If a decision surfaces that wasn't in the plan, apply the fork severity filter from `/plan-task` (architectural / blast radius ≥ module / medium-high reversibility / changes next 3+ steps). If it qualifies, **STOP and emit `AskUserQuestion`** following `skills/_shared/question-format.md`. Do not auto-pick and document later — the user must see the fork before the code lands.
5. Record each surfaced question and its answer in the commit message body (single line: `Decision: <fork> → <choice> per user answer`) so the trail is visible in git history, not just the conversation.
6. Run `npm run typecheck` (or equivalent) after each major change

## Output

Summary of files changed, commits made, any deviations from plan, and the list of mid-implementation forks the user was asked about (with the answer applied).
