# createRequire resolves test-spawned binaries from any worktree
> 2026-05-18 · FORGE-122 · tags: [testing, infra, worktree, node-resolution]

## What we expected
Tests that spawn the project's own CLI via `execa(tsxBin, [entry, ...args])` should work from any checkout — main or worktree. The ticket's suggested fix was `createRequire(import.meta.url).resolve('tsx/dist/cli.mjs')`.

## What happened
1. `tsx/dist/cli.mjs` is **not** in tsx's `package.json#exports`. The package only exports `tsx/cli` (mapping to `./dist/cli.mjs` internally). The ticket's literal subpath threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. The correct specifier was `tsx/cli`.
2. `execa('node', ['--import', 'tsx', entry, ...], { cwd: tmp })` looks tempting but **fails from `cwd: tmp`** — Node's package resolution walks up from `cwd`, not from the entry file. Tests that pass a fake consumer dir as cwd (e.g., `forge init` e2e) get `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`.
3. `createRequire(import.meta.url).resolve('tsx/cli')` from a helper file inside the test tree DID work — Node walks up from the helper file's filesystem path, traversing out of `<worktree>/.forge/worktrees/<id>/` into the main checkout's `node_modules/tsx`. Independent of spawn cwd.

## Why
Worktrees inherit git refs but not `node_modules/`. Any "find this binary" approach that anchors on `cwd` or on the worktree's directory tree breaks. `createRequire(import.meta.url)` anchors on the FILE doing the resolution — which lives inside the repo regardless of whether it's main or a worktree — so the walk-up always reaches the main checkout's installed deps.

## Next time
- For test helpers that spawn dev-time binaries: put the resolver in a helper file under `test/helpers/` and use `createRequire(import.meta.url).resolve('<pkg>/<exported-subpath>')`. Never hardcode `node_modules/.bin/<x>` — it breaks from worktrees.
- When picking the subpath specifier, read `node_modules/<pkg>/package.json#exports`, not `#bin`. `#bin` is what `npm install` symlinks to disk; `#exports` is what `import`/`require` accept. They look the same but the resolver only trusts `exports`.
- Lint-guard the regression: a one-line `grep` script wired into CI for the legacy literal (`scripts/lint-test-helpers.mjs` is the pattern in this repo).
