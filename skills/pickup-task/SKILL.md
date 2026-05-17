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
   # Validate the ticket ID against the same rules as src/core/workspace.ts sanitizeIssueId.
   # The skill produces a filesystem path from LINEAR_ID, so we abort on anything
   # that could escape `.forge/worktrees/` or yield a malformed worktree dir.
   if [[ -z "${LINEAR_ID}" ]] || \
      [[ ${#LINEAR_ID} -gt 64 ]] || \
      [[ "${LINEAR_ID}" =~ [^A-Za-z0-9._-] ]] || \
      [[ "${LINEAR_ID}" == -* ]] || \
      [[ "${LINEAR_ID}" == */* ]] || \
      [[ "${LINEAR_ID}" == *\\* ]] || \
      [[ "${LINEAR_ID}" == *..* ]]; then
     echo "ERROR: ticket id '${LINEAR_ID}' is not a valid sanitized id (see src/core/workspace.ts sanitizeIssueId)" >&2
     exit 1
   fi

   # Anchor on the main checkout root, not pwd or current-worktree toplevel.
   # If the user runs /pickup-task from inside an existing worktree,
   # `git rev-parse --show-toplevel` would return that worktree's root and
   # the new worktree would be nested. --git-common-dir always resolves to
   # the main checkout's .git (file vs dir), so its parent is the main root.
   GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
   REPO_ROOT="$(cd "$(dirname "${GIT_COMMON_DIR}")" && pwd)"
   WORKTREE_PATH="${REPO_ROOT}/.forge/worktrees/${LINEAR_ID}"

   git worktree add "${WORKTREE_PATH}" -b "${BRANCH_NAME}" main

   # Write the worktree-task marker — binds this worktree to its task ID
   # for the worktree-guard preflight in /implement, /ship, /qa, etc.
   # Contract: skills/_shared/worktree-guard.md.
   mkdir -p "${WORKTREE_PATH}/.forge"
   cat > "${WORKTREE_PATH}/.forge/worktree-task.json" <<EOF
{
  "version": 1,
  "taskId": "${LINEAR_ID}",
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
   # Source paths are relative to ${REPO_ROOT} (the main checkout), not pwd:
   # if the user invoked /pickup-task from a sibling worktree, pwd would
   # point at the wrong tree and the cp commands would silently no-op.
   #
   # All four copies are best-effort: a missing source tree is not fatal
   # (a fresh forge project has no plans/tasks/ yet, no spec/ during bootstrap).
   #
   # Root cause:    docs/learnings/2026-Q2/worktrees-blind-to-gitignored-context.md
   # Hydration set: docs/learnings/2026-Q2/worktree-hydration-runbook.md

   # Hydration uses `find -exec` rather than `cp <glob>` because globs expanded
   # after a quoted variable (e.g. cp "${REPO_ROOT}"/spec/*.md ...) re-split on
   # whitespace at the shell level — if the user's repo path contains a space
   # ("/Users/foo bar/repos/forge"), the cp command silently mis-applies args.
   # `find` handles the entire path as one argument to -exec; safe for paths
   # containing spaces, newlines, or other shell metacharacters.

   # plans/phases.yaml — task graph + scope source-of-truth (read by /plan-task)
   if [ -f "${REPO_ROOT}/plans/phases.yaml" ]; then
     mkdir -p "${WORKTREE_PATH}/plans"
     cp "${REPO_ROOT}/plans/phases.yaml" "${WORKTREE_PATH}/plans/"
   fi

   # spec/*.md — BRIEF, PRD, SPEC, DESIGN, CONTEXT (read by /plan-task).
   # ORCHESTRATOR.md is tracked but cp overwrites with identical content — harmless.
   if [ -d "${REPO_ROOT}/spec" ]; then
     mkdir -p "${WORKTREE_PATH}/spec"
     find "${REPO_ROOT}/spec" -maxdepth 1 -type f -name '*.md' -exec cp {} "${WORKTREE_PATH}/spec/" \;
   fi

   # plans/tasks/*.plan.md — required by /implement's plan-must-exist precondition
   if [ -d "${REPO_ROOT}/plans/tasks" ]; then
     mkdir -p "${WORKTREE_PATH}/plans/tasks"
     find "${REPO_ROOT}/plans/tasks" -maxdepth 1 -type f -name '*.plan.md' -exec cp {} "${WORKTREE_PATH}/plans/tasks/" \;
   fi

   # docs/learnings/ — required by step 6 (learning-curator). MUST happen before step 6.
   if [ -d "${REPO_ROOT}/docs/learnings" ]; then
     mkdir -p "${WORKTREE_PATH}/docs/learnings"
     cp -r "${REPO_ROOT}/docs/learnings/." "${WORKTREE_PATH}/docs/learnings/"
   fi
   ```
6. Delegate to `learning-curator` to retrieve relevant learnings (runs AFTER step 5
   hydration so the curator sees the just-copied learnings tree, not an empty one):
   - Tags matching task type
   - Created in last 90 days
7. Output:

```
✓ Worktree created: .forge/worktrees/TLOG-101
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
  cd .forge/worktrees/TLOG-101
  claude
  > /plan-task
```
