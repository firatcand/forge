# Worktree hydration gap: `node_modules` not copied
> 2026-05-17 · FORGE-114 · tags: [pickup-task, worktree, hydration, dx]

## What we expected
A fresh worktree created by `/pickup-task` (hydrating spec/, plans/, docs/learnings/) would be ready to run `npm test` immediately.

## What happened
First `npm test` in the worktree failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. Had to run `npm install` (199 packages, ~2s) before any test could run. The hydration runbook covers gitignored product-meta but not build-tool dependencies, even though both are gitignored and the test runner relies on the latter.

## Why
The runbook was correctly scoped to product-domain gitignored content (spec/, plans/, learnings/). `node_modules/` was excluded as a build artifact, not product meta. The downstream consequence is that `/implement` cannot run tests until deps are installed — costs a few minutes and a tool call the first time you hit it.

## Next time
Four options worth evaluating: (1) auto-`npm install` as last hydration step (~2s, predictable); (2) symlink `node_modules/` from main worktree (fast, but brittle across branches); (3) document the manual step in `/pickup-task` output; (4) leave it — forge supports any stack and the cost is small. Recommended: document the manual step + offer an opt-in `--install` flag rather than baking npm-specific behavior into forge core.

See also: [[worktree-hydration-runbook]], [[worktrees-blind-to-gitignored-context]]
