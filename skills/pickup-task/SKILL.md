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

1. Query the configured tracker (via the Tracker interface) for active issues in the current cycle that are:
   - Status: Todo
   - All `blocked_by` issues are Done
2. If multiple match, list and ask user to pick. If one, auto-pick.
3. Set Linear issue status → "In Progress"
4. Compute branch name: `feat/{LINEAR-ID}-{kebab-case-title}`
5. Create git worktree, write the task binding marker, then hydrate gitignored project meta the worker needs:
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   WORKTREE_PATH="../${PROJECT_NAME}-worktrees/${LINEAR-ID}"
   git worktree add "${WORKTREE_PATH}" -b "${BRANCH_NAME}" main

   # Write the worktree-task marker — binds this worktree to its task ID
   # for the worktree-guard preflight in /implement, /ship, /qa, etc.
   # Contract: skills/_shared/worktree-guard.md.
   mkdir -p "${WORKTREE_PATH}/.forge"
   cat > "${WORKTREE_PATH}/.forge/worktree-task.json" <<EOF
{
  "version": 1,
  "taskId": "${LINEAR-ID}",
  "branch": "${BRANCH_NAME}",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "createdBy": "skills/pickup-task"
}
EOF

   # Hydrate gitignored project meta into the fresh worktree.
   #
   # WHY: spec/, plans/, and docs/learnings/ are gitignored as a forge dogfooding
   # rule — we use forge to build forge but don't ship internal product docs in
   # the published npm package. Fresh worktrees inherit only tracked files, so
   # without this hydration:
   #   - /plan-task can't read spec/SPEC.md to design against architecture
   #   - /implement can't find plans/tasks/{ID}.plan.md (precondition fails)
   #   - learning-curator (step 6) finds zero learnings
   #
   # All four copies are best-effort: a missing source tree is not fatal
   # (a fresh forge project has no plans/tasks/ yet, no spec/ during bootstrap).
   #
   # Root cause:    docs/learnings/2026-Q2/worktrees-blind-to-gitignored-context.md
   # Hydration set: docs/learnings/2026-Q2/worktree-hydration-runbook.md

   # plans/phases.yaml — task graph + scope source-of-truth (read by /plan-task)
   if [ -f plans/phases.yaml ]; then
     mkdir -p "${WORKTREE_PATH}/plans"
     cp plans/phases.yaml "${WORKTREE_PATH}/plans/"
   fi

   # spec/*.md — BRIEF, PRD, SPEC, DESIGN, CONTEXT (read by /plan-task).
   # ORCHESTRATOR.md is tracked but cp overwrites with identical content — harmless.
   if compgen -G "spec/*.md" > /dev/null; then
     mkdir -p "${WORKTREE_PATH}/spec"
     cp spec/*.md "${WORKTREE_PATH}/spec/"
   fi

   # plans/tasks/*.plan.md — required by /implement's plan-must-exist precondition
   if compgen -G "plans/tasks/*.plan.md" > /dev/null; then
     mkdir -p "${WORKTREE_PATH}/plans/tasks"
     cp plans/tasks/*.plan.md "${WORKTREE_PATH}/plans/tasks/"
   fi

   # docs/learnings/ — required by step 6 (learning-curator). MUST happen before step 6.
   if [ -d docs/learnings ]; then
     mkdir -p "${WORKTREE_PATH}/docs/learnings"
     cp -r docs/learnings/. "${WORKTREE_PATH}/docs/learnings/"
   fi
   ```
6. Delegate to `learning-curator` to retrieve relevant learnings (runs AFTER step 5
   hydration so the curator sees the just-copied learnings tree, not an empty one):
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
