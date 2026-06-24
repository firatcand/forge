# Integration tests need production-shaped inputs
> 2026-05-16 · FORGE-77 · FORGE-82 · tags: [testing, integration, tracker, github, limits, ac-discipline]

## What we expected
Integration tests passing meant the prefix change (`claimed:agent-` → `forge:claimed-by:`) was safe end-to-end. Green CI across unit and integration suites was treated as a ship signal.

## What happened
Tests passed with short literal runIds (10–20 chars); production runIds are UUIDv7 (36 chars). The new prefix produces a 53-char label — GitHub's hard cap is 50. `claim()` throws unhandled because `classifyGitHubError` doesn't recognise the resulting "name is too long" stderr. The regression was caught only by an explicit post-ship probe using `crypto.randomUUID()`.

## Why
Integration test fixtures used aesthetically-short literal strings (`'agent-aaa'`, `'e2e-orchestrator'`) that bear no resemblance to the production input format (UUIDv7). Unit tests had the same problem but worse — fully mocked, so the GitHub label limit was invisible. Limit/cap regressions are only visible when test inputs match the production input domain in shape AND size. The old prefix `claimed:agent-` (14 chars) + UUIDv7 (36 chars) = exactly 50, so it happened to fit; the 3-char prefix expansion was all it took to break.

## Next time
For any test that uses a literal value where production code will receive a generated value (UUIDs, ULIDs, timestamps, hashes, encoded payloads), use the actual generator in the test. Trace each input back to its production source — "what generates this in prod?" — and use the same generator or a same-length/same-charset stand-in. Structural correctness and connectivity alone are insufficient; the test suite must exercise the full input domain to catch size and character-set limits.
