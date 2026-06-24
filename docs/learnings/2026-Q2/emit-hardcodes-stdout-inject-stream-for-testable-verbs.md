# emit() hardcodes process.stdout — inject a stream for testable verbs
> 2026-05-30 · FORGE-159 · tags: [testing, cli, design]

## What we expected
Reuse `src/cli/envelope.ts` `emit()` for the new `forge status` verb's `--json` / human output, per the plan.

## What happened
`emit()` writes directly to `process.stdout`/`process.stderr` with no injection point. Using it would force tests to monkeypatch `process.stdout.write` (the `doctor.test.ts` pattern the codebase otherwise avoids) instead of the clean injectable-PassThrough pattern (`status.test.ts`).

## Why
The envelope module separates shape (`ok()`/`fail()` constructors) from sink (`emit()`). Only the sink is the problem. Reusing the SHAPE keeps the `{ ok, data }` contract single-sourced; the sink can be a 3-line write to an injected stream.

## Next time
For a read-only verb that needs unit tests, accept `stdout?: NodeJS.WritableStream`, reuse `ok()` for the envelope shape, and write the json/human form to the injected stream yourself rather than calling `emit()`. Consider a follow-up to give `emit()` an optional out-stream param so future verbs don't re-solve this.
