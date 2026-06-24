# Post-merge main-sync assumes a clean main checkout — false under parallel worktrees
> 2026-05-30 · FORGE-168 · tags: [foundation, orchestration, git, worktrees]

## What we expected
After merging the PR, the routine `git rebase origin/main` in the main checkout would fast-sync main by one commit.

## What happened
The rebase aborted: "cannot rebase: You have unstaged changes." The main checkout carried an unrelated 1-line uncommitted edit (`agents/learning-curator.md`, an `opus-4 → sonnet-4-6` model fix) — not from this session. Three other worktrees were active, so a parallel session likely owned it. Synced safely with a path-scoped `git stash push -- <file>` → rebase → `git stash pop`.

## Why
Multiple worktree sessions share ONE main checkout working tree. Any session (or a half-done manual fix) can leave it dirty, and `git rebase` refuses on a dirty tree. The merged-PR cleanup flow silently assumed an exclusive, clean main.

## Next time
The future `/wrap-up` skill (FORGE-116) must NOT blind-rebase the main checkout. Either (a) path-scoped stash → rebase → pop, or (b) detect a dirty main and skip the sync with a clear message — never `reset --hard` or `stash` the whole tree (would swallow another session's WIP). Also: a stale `model:` in committed agent frontmatter silently breaks the named subagent at runtime (this is what made `learning-curator` unable to read the hydrated store earlier) — see [[feedback_subagent_model_override]]; the durable fix is correcting the frontmatter, not just passing `model:` per-call.
