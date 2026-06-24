# Pass review diffs via stdin, not argv
> 2026-05-28 · FORGE-166 · tags: [infra, integration, testing]

## What we expected
`/second-opinion review-impl` on a real change to just work — it had passed three times during `review-plan` earlier in the same session.

## What happened
Every call with a 700–1380 line diff failed instantly with `SPAWN_FAILED` (marked retriable, so two blind retries also failed). A 1-line probe payload succeeded, which isolated it to payload size. Root cause: `codex.ts`/`gemini.ts` `runReview` concatenated the prompt + the **entire diff** into a single `argv` argument; a large diff pushed that arg past the OS exec arg-size limit, so `execa`/`posix_spawn` threw and surfaced as a generic `SPAWN_FAILED` with no hint about the real cause.

## Why
Command-line arguments have a hard OS size cap (ARG_MAX / single-arg limits). Any payload that can grow unboundedly (a diff, a rendered prompt, a file) must not ride in argv. The fix was already sign-posted in `subprocess.ts` (the FORGE-135 comment anticipated a `SpawnOpts.stdinPayload`): route the diff through **stdin** (execa `input`), which codex/gemini append as a `<stdin>` block, keeping the argv prompt bounded. Preserve `stdin: 'ignore'` when there's no payload so the FORGE-135 empty-stdin hang can't return.

## Next time
When a subprocess call fails with `SPAWN_FAILED` (not `NON_ZERO_EXIT`), suspect the payload size before retrying — probe with a tiny payload to confirm. Never put unbounded content in argv; pipe it via stdin. Interim workaround while a review harness is unfixed: pass an empty `--diff` and instruct the reviewer to self-generate the diff with `git diff origin/main` (it has shell + file access).
