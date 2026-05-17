---
name: plan-task
description: Run Plan mode for the current task. Outputs structured plan; required before /implement.
tools: Read, Write, Edit
---

# /plan-task

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

## Steps

1. Read Linear issue (or phases.yaml task) for current branch
2. Determine task type → delegate to relevant specialist subagent (frontend-dev, backend-dev, db-architect, etc.)
3. Specialist enters Plan mode: research codebase, propose approach
4. **Detect architectural forks.** Before drafting the plan, enumerate every decision the implementation will require. For each one, classify it (see Fork severity filter below). Anything that passes the filter is a question — not a silent decision.
5. **Ask per fork, not in bulk.** For each qualifying fork, emit an `AskUserQuestion` call following `skills/_shared/question-format.md` — re-ground, simplify, recommend, options with concrete trade-offs. Batch up to 4 questions per `AskUserQuestion` call; iterate as new forks surface during deeper research. **Do not bundle 11 forks into a "Questions decided" table for the user to rubber-stamp.**
6. Write structured plan to `plans/tasks/{LINEAR-ID}.plan.md`:
   - Files to change (predicted)
   - Component tree / data flow
   - State / data flow
   - Edge cases
   - Test strategy
   - **Questions asked & answers applied** (not "decisions decided" — list each question, who answered, and the resulting branch in the plan)
7. Show plan to user, wait for approval
8. On approval: commit plan, unlock /implement

## Fork severity filter

A decision becomes a question (via `AskUserQuestion`) when **any** of these apply:

| Dimension | Triggers a question when… |
|-----------|---------------------------|
| `decision_type` | architectural — touches public API, schema, dependency graph, file lifecycle, deprecation strategy, naming of a shipped surface |
| `blast_radius` | module / project / external (i.e. affects other tasks, other adopters, or shipped code — not isolated to one function) |
| `reversibility` | medium or high — locks in a vendor, contract, migration path, or shipped behavior |
| `plan_branch` | answer materially changes the next 3+ steps of the plan tree |

A decision can be **silently auto-decided** by the agent only when **all** of these hold: routine / local / fully reversible within this task / does not change the plan tree.

When in doubt, ask. The cost of an extra question is small; the cost of an unsurfaced fork is rework.

See `skills/_shared/question-format.md` for the canonical question structure.
