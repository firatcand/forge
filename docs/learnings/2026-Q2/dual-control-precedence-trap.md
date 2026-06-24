# opts.confirm vs FORGE_INIT_NONINTERACTIVE: dual-control precedence trap
> 2026-05-12 · FORGE-19 · tags: [testability, api-design, precedence, testing, gotcha, process]

## What we expected
Adding `opts.confirm` to `InitOptions` for testability/override would make the prompt mechanism injectable. Combined with env-driven `FORGE_INIT_NONINTERACTIVE`, callers (especially tests) could pick: "scripted confirm" via opts.confirm, or "auto-default" via env var. Both controls would compose cleanly.

## What happened
When a caller passed BOTH (`opts.confirm` provided + `FORGE_INIT_NONINTERACTIVE=1`), the env var silently won. `runPreflight` short-circuited on its `nonInteractive` flag at `preflight.ts:64` and `:83`, bypassing the supplied confirm entirely. The plumbing implied an override but didn't deliver one. Codex pass 2 caught this MED; pass-1 regression tests covered each control individually (interactive + confirm OK; nonInteractive + no-confirm OK) but missed the combined case.

## Why
Two parallel controls on the same decision without an explicit precedence rule = hidden coupling. The orchestrator built `confirmFn` from either source but unconditionally forwarded `nonInteractive` downstream, and preflight treated `nonInteractive` as a hard bypass rather than a fallback default.

## Next time
1. When adding testability plumbing alongside env-driven config, encode precedence at the call site (e.g. `nonInteractive: nonInteractive && !opts.confirm`) and document it on the option type.
2. Regression tests must cover the CROSS-PRODUCT of injection points — at minimum the 4 corners of a 2x2 truth table when two parallel controls exist.
3. Smell: if your option type has both `nonInteractive: boolean` AND `confirm?: Fn`, ask "who wins when both are set?" before merging.
