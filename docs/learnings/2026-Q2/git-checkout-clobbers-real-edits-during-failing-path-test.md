# git checkout -- <file> clobbers all unstaged edits, not just your test injection
> 2026-05-17 · FORGE-112 · tags: [testing, git, gates, ci]

## What we expected
`git checkout -- package.json` would undo only the temporary `spec/` injection added to `files[]` to prove the npm-pack gate catches leaks.

## What happened
It reverted the entire file to HEAD, silently discarding the legitimate (unstaged) `"test:pack"` script line added earlier in the same session. The subsequent `npm run test:pack` then failed with "script not found" — not because the gate was broken, but because the runner entry was gone.

## Why
`git checkout -- <file>` is a file-level operation. It has no concept of which hunks are "test scaffolding" vs. "real work". Any unstaged change in the file is lost. This surfaced during an AC failing-path test (see `feedback_ac_as_unit_test.md` — "run each AC bullet as a failing test against live code"), which is exactly the workflow that requires a temporary breakage-then-revert cycle.

## Next time
Commit real edits before any "prove it fails" injection. Then `git checkout` has an unambiguous, safe target. If committing first is inconvenient, mirror the injection precisely in reverse (e.g., `node -e` JSON manipulation) instead of using a file-level revert. `git stash push --keep-index -- <file>` is a third option but adds cognitive overhead.
