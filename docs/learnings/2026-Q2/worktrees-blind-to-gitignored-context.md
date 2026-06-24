# Worktrees are blind to gitignored project context — in both directions
> 2026-05-11 · FD-7 · tags: [worktree, forge-dogfooding, skills, memory, gotcha]

## What we expected
`/pickup-task FD-7` would spin up a fresh worktree from `origin/main` and the planning + implementation skills would have everything they need to execute, same as in the main checkout. We also expected gitignored work product written inside a worktree (learnings, plans) to be visible to future sessions.

## What happened
Forge's `.gitignore` deliberately keeps project meta local — `spec/{BRIEF,PRD,SPEC,DESIGN,CONTEXT}.md`, `plans/tasks/*.plan.md`, and `docs/learnings/**/*.md` are all untracked (dogfooding hygiene: we use forge to build forge but don't want our specs in npm + GitHub). This produced **four concrete failures** in a single FD-7 task:

1. `/plan-task` had to author the plan with 5 blocking [INFER] questions because `spec/SPEC.md` wasn't in the worktree (had to be manually copied across).
2. `/implement`'s "plan must be committed" precondition was unsatisfiable since `plans/tasks/*.plan.md` lives at a gitignored path.
3. Any future task referencing SPEC sections from a worktree hits the same input wall.
4. **Inverse failure**: when the FD-7 worktree was removed after merge, two newly-written learnings inside `docs/learnings/2026-Q2/` were destroyed along with the worktree. Gitignored work product written from a worktree session is **not** linked back to the main worktree — it dies with the worktree.

## Why
The publish-hygiene gitignore and the worktree-per-task workflow were designed independently. Each is correct in isolation — specs shouldn't ship to npm, and worktrees should branch cleanly from `origin` and be cheaply destroyable. The interaction means worktrees see the tracked framework code but not the project context the skills assume is present (input blindness), and any local-only state produced inside a worktree is orphaned on worktree removal (output loss).

## Next time
Two structural fixes, both worth implementing:

1. `/pickup-task` should copy or symlink gitignored project-meta INTO new worktrees on creation (`spec/*.md`, `plans/`, `docs/learnings/`).
2. `/learn` and any other skill that writes gitignored work product should target the **main worktree's path**, not the current working directory, so that output survives worktree removal.

Cleaner architectural fix that subsumes both: move project specs / plans / learnings outside the repo root entirely (e.g., `~/.forge/projects/<slug>/{spec,plans,learnings}/`) so they're worktree-orthogonal by construction. Until either lands, the workaround for the input side is manual `cp` after `git worktree add`, and for the output side, writing files to the absolute main-worktree path explicitly.

## Closed by FORGE-81 (2026-05-18)

The output-side gap (item #2 in "Next time") is now closed: `/learn` resolves the main checkout via `git rev-parse --git-common-dir`, writes the canonical record to `${MAIN_ROOT}/docs/learnings/{quarter}/{slug}.md` first, then mirrors to the worktree path so same-session `Read` still works. The dual-write contract is documented in `spec/SPEC.md §Learnings store`. The cleaner-architecture idea (moving the store out of the repo root) is preserved as a separate epic — the dual-write fix is the minimal, fully-reversible step that keeps the canonical store invariant without that surface area.
