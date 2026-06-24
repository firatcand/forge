# gh CLI flag spelling vs GitHub API enum

> 2026-05-12 · FORGE-15 · tags: [testing, multi-model-review, cli-integrations, integration, backend]

## What we expected
Unit tests with a sequenced mock returning `ok()` regardless of argv would catch the major bug classes in a CLI wrapper. A careful code-reviewer agent pass over the diff against the plan would catch any remaining contract drift.

## What happened
`GitHubTracker.updateState(id, 'cancelled')` shelled out `gh issue close --reason not_planned` — the GitHub REST API's snake_case enum value. The `gh` CLI rejects this; its `--reason` flag only accepts `"not planned"` (with a space), `completed`, or `duplicate`. Every cancel path would have thrown in production. 45 unit tests passed and the code-reviewer agent missed it because the mock returned `ok()` regardless of args. Codex caught it by actually shelling out (`gh issue close --help` and then a live `gh issue close ... --reason not_planned`) to read accepted values and confirm the error message.

## Why
CLI tools often translate between human-readable flag values and the underlying API enum. GitHub's REST API uses `not_planned` (snake_case); the `gh` CLI normalizes to `"not planned"` (space-separated). Mocks that ignore argv only validate call shape, not call content — so a flag-spelling bug is invisible to them.

## Next time
When mocking CLI tools in unit tests, either (a) validate argv against the real tool's flag spec (e.g., a closed list of accepted `--reason` values), OR (b) weight integration tests that exec the real binary as required-locally-before-PR for any non-trivial CLI wrapper. For forge specifically, treat `FORGE_E2E_GITHUB=1`-gated integration tests as mandatory on tracker-adapter PRs even when they don't run in CI. Broader principle: **mocks verify call shape; only the real binary verifies call content.** Multi-model review (codex) is high-leverage precisely because it doesn't trust mocks — it shells out to verify.
