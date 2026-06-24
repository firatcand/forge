# /ship gates pass tests + typecheck but skip `npm run build`
> 2026-05-12 · FORGE-19 · tags: [ship-gates, ci, build, testing, gotcha, foundation, process]

## What we expected
`npm run typecheck` (tsc) + `npm test` (node:test + tsx) green = shippable. /ship's gate list codified that assumption, and 271/271 tests passed.

## What happened
Top-level `await` at `src/bin/forge.ts:97` typechecked fine (valid TS) and ran fine under tsx (ESM-native, supports TLA). But `npm run build` (tsdown → CJS) failed with `[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'cjs' output format`. Only caught because codex pass 1 ran `npm run build` as part of review verification — otherwise we'd have published a broken CJS bin.

## Why
The test runner (`node --test --import tsx`) executes TS source directly through tsx; it never touches the built CJS bundle. Any bundler-output-only failure — TLA-in-CJS, ESM/CJS interop wrappers, dynamic import shape, dual-format export collisions — slips past both `tsc --noEmit` and `npm test`. /ship inherited that blind spot.

## Next time
1. Add `npm run build` as a /ship gate before push.
2. Add an artifact smoke step: `node dist/bin/*.cjs --version && node dist/bin/*.cjs --help`. Catches TLA-in-CJS and the chalk-double-wrap class together.
3. Update `/Users/firatcandogan/.claude/skills/ship/SKILL.md` to list: "Build (`npm run build` if present) — green AND artifact smoke (`node dist/bin/*.cjs --version`)".
