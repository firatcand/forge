# Worktrees are also blind to node_modules — same root cause, different shape

> 2026-05-14 · FORGE-66 · tags: [worktrees, tooling, pickup-task, ship-gates]

## What we expected

After `git worktree add` and `/pickup-task` hydration (which now covers `plans/phases.yaml`, `spec/*.md`, `plans/tasks/*.plan.md`, `docs/learnings/`), the fresh worktree would be ready to run `npm test` and `npm run typecheck` directly. Ship gates would just work.

## What happened

`npm test` reported 8+ test files marked `✖ test failed` with no useful error detail. `npm run typecheck` failed with `sh: tsc: command not found`. `npm run lint` failed with `Missing script: "lint"` (separate issue — that script genuinely isn't defined yet). The test failures and the missing tsc both vanished after a single `npm install` in the worktree.

## Why

`git worktree add` only checks out **tracked** files. `node_modules/` is gitignored (correctly — deps are derivable from `package-lock.json`, not source of truth). Fresh worktrees therefore have no bin shims, no test runner, no compiled deps. The cryptic `✖ test failed` lines come from `node --test` trying to import packages that don't exist; the real error gets swallowed.

This is the **same root cause** as the FORGE-66 hydration problem in a different shape: worktrees inherit only tracked content. FORGE-66 fixes the *meta* half (spec/plans/learnings — gitignored because they don't belong in the npm package). The *deps* half — `node_modules/` — is a separate category because deps are rebuild-able, not source-of-truth, so they shouldn't be `cp`'d; they should be `npm ci`'d.

## Next time

- Treat "what does a fresh worktree need beyond tracked files" as a single concern with two sub-categories: **hydrate** (gitignored source-of-truth — spec/plans/learnings, copied) vs **rebuild** (gitignored derived artifacts — node_modules, regenerated via `npm ci`).
- `/pickup-task` should either run `npm ci` after worktree creation, or echo a one-line "run `npm ci` in the worktree before tests" reminder. Tracked in FORGE-{next}.
- Ship gates need to surface the actual error when `tsc`/test runner is missing — current `node --test` failure mode is a debugging tarpit ("✖ test failed" with no detail). Could be a node-test-runner issue or a wrapper bug.
- If you see widespread `✖ test failed` with no detail in a fresh worktree, check `node_modules/` exists before debugging tests.
