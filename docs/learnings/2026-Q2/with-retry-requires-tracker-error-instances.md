# withRetry only retries TrackerError instances
> 2026-05-15 · FORGE-76 · tags: [tracker, retry, base-tracker, error-handling, type-discipline]

## What we expected
Wrapping any throwing function in `BaseTracker.withRetry` would automatically retry on transient failures. A new strict helper (`lookupExistingLabelStrict`) that threw a raw Linear provider error was wrapped in `withRetry` expecting retries to fire on ECONNRESET / 503.

## What happened
No retries fired. The raw provider error surfaced immediately. `BaseTracker.withRetry`'s default `isRetriable` is `(err) => err instanceof TrackerError && isRetriableTrackerErrorCode(err.code)`. A raw Linear error is not a `TrackerError` instance → `isRetriable` returns false on the first throw → retries never run. The error was only normalized in the outer catch after `withRetry` had already given up. Claims leaked silently.

## Why
`withRetry` is type-strict by design: it cannot classify an arbitrary thrown value as retriable unless that value is already in the `TrackerError` taxonomy. Normalization must happen inside the helper, before the throw reaches `withRetry`'s catch. The existing GitHubTracker wrappers (e.g., `readIssueLabels`) all normalize internally — that is why retry works there.

## Next time
Any helper called from inside `withRetry` must normalize its own throws via `this.normalizeError(op, err, classify*(err))` before re-throwing. If normalization inside the helper is impractical, pass a custom `isRetriable` callback that understands raw provider errors. Consider adding a loud `console.warn` in `withRetry` when a non-`TrackerError` is caught and not retried, so future authors notice the contract at runtime.
