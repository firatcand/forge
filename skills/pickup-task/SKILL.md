---
name: pickup-task
description: Claim the next available task from Linear (or local phases.yaml), create a git worktree, and inject relevant learnings.
tools: Read, Edit, Bash(git*), Bash(gh*)
subagent: learning-curator
---

# /pickup-task

## Args

- `[phase]` — default: current active phase
- `[type-filter]` — optional, filter by owner_type

## Steps

1. Query Linear (via MCP) for issues in current Cycle that are:
   - Status: Todo
   - All `blocked_by` issues are Done
2. If multiple match, list and ask user to pick. If one, auto-pick.
3. Set Linear issue status → "In Progress"
4. Compute branch name: `feat/{LINEAR-ID}-{kebab-case-title}`
5. Create git worktree:
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   WORKTREE_PATH="../${PROJECT_NAME}-worktrees/${LINEAR-ID}"
   git worktree add "${WORKTREE_PATH}" -b "${BRANCH_NAME}" main
   ```
6. Delegate to `learning-curator` to retrieve relevant learnings:
   - Tags matching task type
   - Created in last 90 days
7. Output:

```
✓ Worktree created: ../my-project-worktrees/TLOG-101
✓ Linear issue TLOG-101 → In Progress
✓ Branch: feat/TLOG-101-bootstrap-nextjs

Acceptance criteria:
  - Email + Google OAuth working
  - Migrations run cleanly
  - Vercel preview deploy on PR

Relevant learnings (3):
  - 2026-Q2/nextjs-supabase-typegen.md
  - 2026-Q2/vercel-env-vars-runtime.md
  - 2026-Q1/git-hooks-prettier-conflict.md

Next:
  cd ../my-project-worktrees/TLOG-101
  claude
  > /plan-task
```
