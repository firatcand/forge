# Test helper hardcoded default masks schema-default regression
> 2026-05-23 · FORGE-108 · tags: [testing, anti-pattern, codex-catch, schema, defaults]

## What we expected
The `scriptedNumberConfirm` test helper in `test/unit/cli/init.prompts.test.ts` was already returning `async () => true` for the `confirm` callback before this PR — we kept that behavior. The Sonnet code-reviewer didn't flag it. The Sonnet security-auditor didn't flag it. The helper has been in the codebase since FORGE-88 era and seemed fine.

## What happened
Added `github_connected: z.boolean().default(false)` to `InitAnswersSchema`. Added 8 new tests (some with explicit `confirmAnswers: [true]` / `[false]`, others without). All passed. Then Codex (`/second-opinion`) caught the bug both Sonnet reviewers had missed: existing `collectAnswers` tests that DIDN'T pass `confirmAnswers` were getting the helper's hardcoded `true`, which silently INJECTED `github_connected: true` regardless of what the production code did. If someone deleted `.default(false)` from the schema, NO test would catch it because the helper provides a value before the schema sees the data.

## Why
Test fakes have a contract: they should mirror the production code's BEHAVIOR for the parts they don't explicitly mock. `inquirer`'s real `confirm` returns `opts.default` when the user presses Enter. Our helper returned a hardcoded `true` regardless of `opts.default`. That means the helper was NEVER exercising the production-time default path — a whole class of regressions (any `.default()` on a boolean prompt) became silently undetectable.

The deeper anti-pattern: when test fakes have lower fidelity than production code, you build a confidence baseline against the fake, not against reality. Schema defaults are particularly invisible because they're declarative — there's no "function call" to trace through and verify the helper honors. The test passes whether the default exists or not, which is exactly the opposite of what a test should do.

## Next time
**Test-fake fidelity contract:** any test fake that wraps a prompt library MUST honor the prompt's options that the production code passes (defaults, validators, etc.) in the unscripted/fallback path. Hardcoded return values are only acceptable when the test explicitly opts in (`confirmAnswers !== undefined`).

Specific pattern:
```ts
// BAD (masks any schema .default() regression):
confirm: async () => true,

// GOOD (production fidelity in the fallback path):
confirm: async (opts: { default?: boolean }) => {
  if (confirmAnswers !== undefined) { /* scripted path */ }
  return opts.default ?? true; // mirror inquirer's "Enter accepts default" behavior
},
```

And pair each schema `.default()` with at least one regression-pin test that exercises the unscripted/default path. The new `FORGE-108 — collectAnswers defaults github_connected=false when prompt is unscripted` test is the pattern.

Why Sonnet missed this and Codex caught it: this is a "what's the test fake NOT doing" question. Code-reviewer scrutiny tends to ask "is this code correct" — it sees `return true` and thinks "fine, mock returns a constant." Codex's training on multi-pass review surfaces "what regression class does this make undetectable?" — a different question that requires reasoning about absent behavior, not present behavior.

Related: `codex-finds-bugs-tests-dont.md`, `mocked-conformance-misses-cli-behavior-regressions.md`, `structural-placebo-fake-must-store-what-it-receives.md`.
