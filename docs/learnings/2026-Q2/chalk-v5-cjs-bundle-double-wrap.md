# chalk v5 + tsdown CJS interop: rolldown double-wraps the namespace
> 2026-05-12 · FORGE-19 · tags: [bundler, tsdown, rolldown, cjs-interop, chalk, gotcha, ship-gates, foundation]

## What we expected
chalk v5 (pure ESM) consumed by tsdown's dual ESM+CJS output would Just Work — tsdown advertises seamless ESM-only consumption from a CJS bundle. ESM unit tests (271/271 via tsx) and `npm run typecheck` were green, so we treated the bundle as shippable.

## What happened
`node dist/bin/forge.cjs init` crashed with `chalk.default.bold is not a function`. Traced to rolldown's `__toESM(chalk, 1)` helper: with `isNodeMode=1` it always sets `target.default = mod`, and `__copyProps` then skips the `default` key via the hasOwnProperty short-circuit. Result: `wrapped.default` is the original `require('chalk')` namespace, not the chalk fn — so `wrapped.default.bold` is undefined while the real bold sits at `wrapped.default.default.bold`. ESM tests never hit the bundle so they all passed.

## Why
Node v22+ added `require()` for ESM and returns the namespace as-is. Rolldown's interop helper predates that and re-wraps aggressively regardless of `mod.__esModule`. The bug only surfaces when CJS bundle code reads `.default.X` on an ESM-only dep.

## Next time
1. Add `node dist/bin/forge.cjs <smoke-cmd>` to /ship gates — `npm test` runs tsx (ESM-native) and cannot catch CJS-only interop.
2. When pulling in an ESM-only dep, audit the CJS bundle output before runtime adoption.
3. Workaround pattern: alias the import to a local const to bypass rolldown's rewrite-on-import — see `src/core/logger.ts:1-8` (PR #76) for the unwrap.
4. Longer-term: swap to `picocolors` (dual-format, zero deps) or set `noExternal: ['chalk']` in `tsdown.config.ts`.
