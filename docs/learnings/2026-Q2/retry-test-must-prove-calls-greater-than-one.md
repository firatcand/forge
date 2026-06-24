# Retry test must prove calls greater than one
> 2026-05-15 · FORGE-76 · tags: [testing, retry, claim, tracker, ac-discipline]

## What we expected
Wrapping `lookupExistingLabel`-style calls in `withRetry` would mean transient `listIssueLabels` failures retry automatically. A test asserting `listCalls > 0` was expected to prove retry behavior.

## What happened
The test passed but proved nothing. `listCalls > 0` is trivially true whether the operation succeeded on attempt one, failed without retrying, or retried and recovered. Meanwhile `withRetry` was not retrying at all — the wrapped helper threw a raw provider error, not a `TrackerError`, so `isRetriable` returned false on the first throw. Codex 4th-pass caught it.

## Why
A retry assertion must discriminate between "called once" and "called multiple times". `> 0` cannot do this. The correct shapes are: (a) all-attempts-fail — assert `calls === configuredAttempts` to prove the retry loop ran to exhaustion, or (b) fail-then-succeed — assert `calls === 2` and that the operation returned the correct result, proving the retry path both ran and recovered.

## Next time
Any test claiming to verify retry behavior must assert exact call count. Ship two complementary cases: (1) all-fail asserts `calls === attempts`; (2) fail-once-then-succeed asserts `calls === 2` and correct return value. The fail-then-succeed pattern is the stronger guard — it proves the retry produced the right result, not just that the loop was entered.
