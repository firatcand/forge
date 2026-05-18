---
name: pickup-task
description: Claim the next available task from Linear (or local phases.yaml), create a git worktree, and inject relevant learnings.
tools: Read, Edit, Bash(*), Bash(git*), Bash(gh*)
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
5. Create the worktree + hydrate gitignored project meta via the CLI verb:

   ```bash
   forge orchestrate ensure-worktree --task "${LINEAR_ID}" --json
   ```

   The verb (`src/cli/orchestrate/ensure-worktree.ts`) owns:
   - Task-ID sanitization (same rules as `src/core/workspace.ts#sanitizeIssueId`)
   - Repo-root resolution via `git rev-parse --git-common-dir` so the worktree
     lands under the main checkout (not a sibling worktree, which would nest)
   - `git worktree add` at `.forge/worktrees/<sanitized-id>/`
   - `.forge/worktree-task.json` marker (binds worktree to task ID for
     worktree-guard preflight in `/implement`, `/ship`, `/qa`)
   - Hydration of `spec/*.md`, `plans/`, `docs/learnings/`, `CLAUDE.md`,
     `CRITICAL.md`, and `.forge/settings.yaml` from the main checkout — these
     are gitignored as a dogfooding rule but workers need them at runtime
   - Idempotence: if the worktree already exists with a matching marker, no-op
     exit 0; conflicting marker exits 1 with `WORKTREE_CONFLICT`

   Architectural ownership per `spec/ORCHESTRATOR.md` §80-98: **only the CLI
   may create or remove worktrees**. Skills never run `git worktree add` directly.
   This was the previous behavior of `/pickup-task` (inline bash block) — it
   was refactored into the CLI verb under FORGE-98 to make `/forge orchestrate`
   and `/pickup-task` share the same code path.

   Parse the JSON envelope:

   ```json
   { "ok": true, "data": {
     "worktree_path": "/path/to/.forge/worktrees/FORGE-XX",
     "branch": "feat/FORGE-XX",
     "created": true,
     "hydrated": ["spec/SPEC.md", "plans/phases.yaml", "..."],
     "marker_path": "/path/to/.forge/worktrees/FORGE-XX/.forge/worktree-task.json"
   }}
   ```

   On `created: false` (idempotent re-pickup of a worktree that already exists),
   surface that to the user with "✓ Worktree already exists (resumed)" instead
   of "✓ Worktree created".

   On `WORKTREE_CONFLICT`, the worktree path is being used by a DIFFERENT task
   ID. Abort with the error message and instruct the user to `git worktree remove`
   the stale path or pick a different ticket.

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
