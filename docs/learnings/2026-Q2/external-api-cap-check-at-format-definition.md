# External-API cap check belongs at format-definition time, not deploy time
> 2026-05-16 · FORGE-82 · tags: [testing, integration, trackers, gh-cli, external-api, error-classification]

## What we expected
Renaming the GitHub claim label prefix from `claimed:agent-` (14 chars) to `forge:claimed-by:` (17 chars) in FORGE-77 was a safe cosmetic change. CI stayed green, integration tests passed, PR merged.

## What happened
The new prefix + UUIDv7 runId = 17 + 36 = 53 chars, exceeding GitHub's 50-char label-name cap. `gh label create --force` returned HTTP 422; the 422 was swallowed; `gh issue edit --add-label` then failed with "label not found"; `claim()` threw instead of returning a `ClaimResult`.

## Why
All tests used short literal runIds (`'me'`, `'aaa'`, `'e2e-orchestrator'`) — none produced a label near the cap. The external constraint was never checked against the worst-case input size at the time the format was defined. The old prefix (`claimed:agent-` = 14 chars) happened to land at exactly 50 chars with a UUID, so expanding it by 3 was all it took.

## Next time
Whenever you define a wire-format string (label name, header value, URL slug, identifier), compute `len(prefix) + len(longest-realistic-payload)` and assert it fits the receiving system's documented cap — in the same commit. One shell line (`gh api repos/:repo/labels -F name=<longest-realistic-payload>`) is sufficient. Tests that use short literals instead of production-shaped inputs cannot catch this; see [integration-tests-need-production-shaped-inputs.md](integration-tests-need-production-shaped-inputs.md) and [spec-api-reality-check-before-design.md](spec-api-reality-check-before-design.md).
