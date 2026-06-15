---
name: pickup-task
description: Claim the next ready task from the configured tracker (Linear / GitHub Issues / Notion), create a git worktree, and inject relevant learnings.
tools: Read, Edit, Bash(*), Bash(git*), Bash(gh*)
---

# /pickup-task

> **Status queries always hit the tracker. `plans/phases.yaml` is a stale cache.** See your project `CLAUDE.md` §Source of truth.

## Args

- `[phase]` — default: current active phase
- `[type-filter]` — optional, filter by owner_type

## Steps

1. **Query the tracker — never `plans/phases.yaml` — for status or dependencies.** Use the Tracker interface (`mcp__linear-server__list_issues` for Linear, `gh issue list` for GitHub, `ntn` for Notion) to find active issues in the current cycle that are:
   - Status: Todo (or Backlog with no blockers)
   - All `blocked_by` issues are Done — verify via `relations.blockedBy` (issue prose like `Depends on: forge#N` is unreliable)

   `phases.yaml` is a local execution snapshot derived from the tracker — every status, dependency, or blocker field in it can be stale. The tracker is authoritative for all execution metadata; see your project `CLAUDE.md` §Source of truth.
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

6. **Install dependencies in the fresh worktree.** `git worktree add` checks out
   tracked files only, and `node_modules/` is gitignored — it is NOT placed by
   `git worktree add` and NOT hydrated by `ensure-worktree`. Without this step the
   first `/plan-task` → build/test/lint commands fail with missing-module errors.

   Detect the package manager from the lockfile present in the worktree root and
   run the deterministic (frozen) install **inside the worktree**:

   | Lockfile (in worktree root) | Install command |
   |-----------------------------|-----------------|
   | `package-lock.json`         | `npm ci` |
   | `pnpm-lock.yaml`            | `pnpm install --frozen-lockfile` |
   | `yarn.lock`                 | `yarn install --immutable` |
   | `bun.lockb`                 | `bun install` |

   ```bash
   cd "${WORKTREE_PATH}"
   if   [ -f package-lock.json ]; then npm ci
   elif [ -f pnpm-lock.yaml ];   then pnpm install --frozen-lockfile
   elif [ -f yarn.lock ];        then yarn install --immutable
   elif [ -f bun.lockb ];        then bun install
   fi
   ```

   **Same-machine speed alternative:** instead of a full install you may symlink
   the main checkout's already-installed dependencies:

   ```bash
   ln -s "$(git -C "${WORKTREE_PATH}" rev-parse --git-common-dir)/../node_modules" \
     "${WORKTREE_PATH}/node_modules"
   ```

   This is faster but ties the worktree's deps to the main checkout's lockfile
   state — prefer a real `npm ci` when the task touches `package.json`.

   **Cleanup / `/wrap-up` interaction (FORGE-116 gc):** a symlinked OR installed
   `node_modules` is gitignored, so `forge orchestrate gc --remove-worktrees`
   (which calls `workspace.cleanup()` with no `--force`) will REFUSE the worktree
   with `GITIGNORED_LOSS` when it sees the `node_modules` symlink/dir, because that
   path is not in the hydration manifest. Pre-cleanup step: remove the
   `node_modules` symlink (or the installed tree) from the worktree **before**
   running `/wrap-up`. Handle both shapes: `[ -L node_modules ] && rm node_modules || rm -rf node_modules` (run INSIDE the worktree — never against the main checkout).
   `/wrap-up` surfaces the verbatim `GITIGNORED_LOSS` guidance if you forget.
7. **Recall relevant learnings via Loom** (FORGE-200). Runs AFTER step 5 hydration
   so the just-copied `docs/learnings/` tree + `plans/phases.yaml` are present.
   Loom replaces the old tag-guessing curator read with a dependency-aware graph
   query: it walks the task's `depends_on` ancestors, surfaces learnings linked
   via `learned_from`, and adds full-text matches — ranking graph-linked hits
   above FTS-only ones, each with a `why` provenance string.

   ```bash
   forge loom reindex --scope all --json   # rebuild the graph (idempotent)
   forge loom recall --task "${LINEAR_ID}" --json
   ```

   `recall` accepts either the phases id (`P2.5-T01`) or the tracker issue id.
   Parse the envelope and surface the hits:

   ```json
   { "ok": true, "data": {
     "task": "P2.5-T01",
     "hits": [
       { "id": "learning:docs/learnings/2026-Q2/race-condition.md",
         "kind": "learning", "title": "Lease race on concurrent claim",
         "score": 1000, "why": "linked via depends_on→P2.4-T03 learned_from",
         "source": "structural" }
     ],
     "learning_nodes": 12,
     "warnings": []
   }}
   ```

   On a fresh repo with no `loom.db` yet (or an empty graph), `recall` soft-fails:
   it returns `ok` with `hits: []` and a warning — surface "No prior learnings
   recalled" rather than treating it as an error. Show the top hits (id + title +
   `why`) to the implementer; an empty `docs/learnings/` legitimately yields
   `learning_nodes: 0`.
8. Output:

```
✓ Worktree created: .forge/worktrees/TLOG-101
✓ Linear issue TLOG-101 → In Progress
✓ Branch: feat/TLOG-101-bootstrap-nextjs

Acceptance criteria:
  - Email + Google OAuth working
  - Migrations run cleanly
  - Vercel preview deploy on PR

Loom recall (dependency-aware):
  - learning:docs/learnings/2026-Q2/nextjs-supabase-typegen.md
      (linked via depends_on→TLOG-088 learned_from)
  - learning:docs/learnings/2026-Q2/vercel-env-vars-runtime.md
      (FTS match on task title/description)

Next:
  cd .forge/worktrees/TLOG-101
  claude
  > /plan-task
```
