# Fixture canonicality masks correctness bugs
> 2026-05-22 · FORGE-154 · tags: [testing, fixtures, code-review]

## What we expected
14 unit tests + 5 e2e tests covering `stripMethodologySections` would catch any behavioral regression, including a `.replace(/\n{3,}/g, '\n\n')` applied to the whole document after stripping.

## What happened
All tests passed. Codex caught — by reasoning, not running — that the `.replace` would silently rewrite user-owned product whitespace for any input with triple newlines. The fixture (`test/fixtures/legacy-claudemd.md`) was extracted verbatim from the template that originated the feature; that template has no triple newlines anywhere. The cleanup step was always a no-op against the fixture. No test could have caught it because no test injected non-canonical input.

## Why
The fixture's strength (canonical reference) is its weakness (no input diversity). A single canonical fixture proves the happy path. A "polish" step added "to keep output tidy" without an explicit user requirement has no aligned test coverage — because the fixture that proves the happy path also makes the polish step invisible.

## Next time
1. For any transformation with a "cleanup" pass at the end, write at least one fixture variant that triggers the cleanup. The dirty fixture proves the cleanup doesn't overreach.
2. Specifically suspect "while we're here" code — steps added for tidiness without an explicit requirement rarely have aligned tests.
3. When adding a test for a new transformation, ask: "would this test pass even if the cleanup step were wrong?" If yes, add a non-canonical input variant.

See also: [[ac-as-unit-test-vs-it-already-exists]] (same failure mode — asserting on structure, not on behavior against realistic inputs).
