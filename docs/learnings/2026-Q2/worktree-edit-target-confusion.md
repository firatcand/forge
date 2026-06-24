# Worktree edit target confusion
> 2026-05-18 · FORGE-105 · tags: [worktrees, tooling-gotcha]

## What we expected
Edit tool calls with absolute paths under the worktree directory would go to the worktree checkout.

## What happened
First-round Edit calls used `/Users/firatcandogan/repos/forge/src/...` (main checkout) instead of `.forge/worktrees/FORGE-105/src/...`. Main was polluted with uncommitted changes; worktree stayed unedited. Tests "passed" because they ran against the worktree (no changes there to fail). Recovery required `cp` main → worktree + `git restore` on main. ~15 min lost.

## Why
Muscle memory defaults to the canonical repo path. The Edit tool resolves absolute paths literally — no smart re-anchoring to the active worktree.

## Next time
Every Edit/Write `file_path` in a worktree session must start with `.forge/worktrees/{LINEAR-ID}/`. Run a quick `pwd` check before the first Edit call to confirm cwd.
