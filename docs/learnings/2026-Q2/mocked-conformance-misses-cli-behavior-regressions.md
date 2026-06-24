# Mocked conformance suite misses CLI behavior regressions
> 2026-05-18 · FORGE-135 · tags: [testing, harnesses, integration]

## What we expected

FORGE-88 shipped `IHarness` adapters with a mocked-subprocess conformance suite covering the full dispatch lifecycle, plus env-gated real-CLI integration smokes (`FORGE_E2E_CODEX=1`, `FORGE_E2E_GEMINI=1`). Combined, this should catch any CLI surface regression in `codex` or `gemini`.

## What happened

The PR shipped with `CodexHarness.runReview` and `dispatchSubagent` that hung indefinitely on `codex-cli 0.130.0`. Neither test layer caught it:

- The mocked conformance suite uses a DI-injected `spawnSubprocess` stub that never blocks on stdin — the real-CLI bug (blocking stdin read before processing the prompt arg) was structurally unreachable.
- The env-gated integration smokes intentionally exercised only `healthCheck()` + `detectVersion()` to "save tokens." Those call `codex --version`, which exits before any stdin read — so the bug never surfaced.

Bug surfaced live during `/review` on the FORGE-88 PR. Cost ~30 min to repro, diagnose, and fix.

## Why

The smoke file's header rationalized excluding dispatch tests: *"We do NOT run a full dispatch here — that would spend tokens on every CI run."* The premise was wrong on two counts: (1) trivial-prompt dispatch costs ~$0.05, not "every CI run" (it's env-gated, run manually or nightly); (2) the value of catching a CLI-surface regression at PR time vastly outweighs $0.05 per check.

Mocks verify shape. Real-CLI smokes verify *behavior*. When the dependency is a closed-source CLI that ships behavior changes between minor versions, shape-only coverage is a false floor.

## Next time

Any harness or adapter that wraps an external CLI **must** have at least one env-gated real-CLI test that exercises the full dispatch path, not just version/health probes. Token cost is a poor reason to skip it — gate it on an env var and skip in default CI; run in nightly or before merge.

A useful smell: if your integration test file's header argues for *why it doesn't test something*, that something is exactly what will break in production.

The FORGE-135 fix added the missing dispatch + runReview smokes (`test/integration/harnesses/codex.test.ts`, `gemini.test.ts`) that would have caught the regression.
