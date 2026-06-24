# Integration tests spawning dist/bin silently false-pass on stale builds
> 2026-05-18 · FORGE-98 · tags: [testing, tsx, FORGE-122]

## What we expected
The integration test spawned `node dist/bin/forge.cjs` with a `before()` hook that ran `npm run build` if dist was missing. The test passed in CI and locally; it appeared to validate current source.

## What happened
Codex review caught it: reverting a source filter and re-running the test still passed — because `dist/bin/forge.cjs` was stale. The hook only rebuilds when dist is absent, not when source has changed. The test was silently validating old code. Fix: switch to `tsx`-based subprocess via `test/helpers/spawn-tsx.ts` (the FORGE-122 helper). Source changes are picked up on every invocation; adversarial regressions take effect immediately.

## Why
A `before()` hook of the form `if (!existsSync(distBin)) build()` triggers only on the first run in a clean environment. Every subsequent run hits stale dist. The test gives a green signal while testing nothing about the current source.

## Next time
For any integration test that spawns the forge CLI, use `tsxBin + entry` from `test/helpers/spawn-tsx.ts` instead of `node distBin`. The FORGE-122 helper resolves tsx via `createRequire` so it works from worktrees too. Reserve dist-based subprocess testing for smoke tests explicitly gating `npm run build` output.
