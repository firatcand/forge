# Smoke-testing a bundled binary still needs `npm install --omit=dev` — `dependencies` are external by design

> 2026-05-13 · FORGE-67 · tags: [ci, bundling, smoke, packaging, tsdown, external-deps]

## What we expected
The smoke job in the new CI workflow would `download-artifact` the `dist/` output from the build job and run `node dist/bin/forge.cjs --version` directly — no checkout, no `npm ci`. The plan called this "no checkout: the bundled artifact must be self-contained. If the smoke binary needs any source file outside dist/, that is a bundler bug we want this job to catch." Locally the same command worked.

## What happened
Both smoke matrix legs failed on first CI run with `Error: Cannot find module 'chalk'` from `dist/schemas-Di0DNjC3.cjs`. Build itself passed cleanly — the artifact existed, was the expected size, and was structurally valid. The local smoke had passed only because `node_modules/` was populated from a prior `npm ci` that the runner didn't have.

## Why
tsdown (correctly) marks anything in `package.json` `dependencies` as **external** in CJS output — it doesn't bundle them. The reasoning is npm-package-hygiene: end users install `@firatcand/forge` and npm resolves chalk/zod/inquirer into *their* `node_modules/`. If tsdown bundled chalk too, every consumer that also depends on chalk would ship it twice (once via forge's bundle, once via their own install) and the dual-format pitfalls multiply. The CJS bundle's `require('chalk')` is correct *for the npm consumer model* — but a CI smoke job that skips `npm install` is not that model. It's a clean-room runner where externals don't exist.

The "self-contained dist/" framing was the wrong mental model. The right framing is: smoke replicates the **end-user invocation path**, which is `npm install <pkg> && node node_modules/<pkg>/dist/bin/x.cjs`. So the smoke job needs `npm ci --omit=dev` before exercising the binary.

## Next time
For any node-package CI smoke job: `npm ci --omit=dev` before running the bundled entrypoint. `--omit=dev` (not full `npm ci`) keeps the install scope honest — devDependencies wouldn't be present in a user install either, so anything pulled in by them is a packaging-leak smell the smoke job will catch.

Two specific pitfalls to flag in plans / reviews:
1. "The bundle should be self-contained" is a true statement only for `--bundle-all` builds (which most production CLIs aren't and shouldn't be). For `dependencies`-external builds, smoke must install runtime deps.
2. Local smoke that works in a worktree with `node_modules/` populated is no signal at all — the runtime deps are accidentally present. The reliable local smoke is `rm -rf node_modules && npm ci --omit=dev && node dist/bin/x.cjs --help`. Worth adding to CONTRIBUTING.md as the "before-push smoke" recipe.

Pairs with `ship-gates-missed-build-step.md` (the broader divergence class) and `chalk-v5-cjs-bundle-double-wrap.md` (chalk-specific bundler footgun that makes this whole class of bug high-stakes).
