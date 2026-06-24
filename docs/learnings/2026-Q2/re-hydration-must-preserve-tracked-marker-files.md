# Re-hydration must preserve tracked marker files
> 2026-05-18 · FORGE-99 · tags: [worktree, gitignore, hydration]

## What we expected
Running `rm -rf spec/ && mkdir -p spec/ && find .../spec -name '*.md' -exec cp {} spec/ \;` to re-baseline against an advanced origin/main would refresh the spec tree cleanly.

## What happened
`git status` later showed `D spec/.gitkeep` — the tracked marker (which keeps `spec/` in git when contents are gitignored) had been deleted by the `rm -rf`. The re-copy only brought back `*.md` files per the find filter, not `.gitkeep`. Caught at commit-prep time via `git status -s`; restored via `git checkout HEAD -- spec/.gitkeep`. Without that catch, the commit would have silently deleted the marker, breaking the directory-keep convention.

## Why
Pickup-task hydration uses `find ... -name '*.md'` filters matching the content layer (gitignored docs) but skipping the structure layer (tracked markers). An `rm -rf` destroys both layers but the re-copy only restores one.

## Next time
Before any `rm -rf` of a directory mixing tracked and gitignored contents: (1) list tracked files via `git ls-files <dir>`, (2) preserve or restore them after the re-copy, or (3) re-hydrate tracked files via `git checkout main -- <dir>` and gitignored files via `cp` separately. Two-step is safer than one-step blind copy. This does not affect first-run worktree creation (fresh directory, no tracked files to lose) — only mid-session re-hydration.
