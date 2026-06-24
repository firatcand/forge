# Asymmetric zod refinement as migration pattern
> 2026-05-20 · FORGE-22 · tags: [schemas, migration, discipline]

## What we expected

Adding a new optional discriminator (`failure_reason`) to `TaskStateRecord` with a strict zod refinement — *present iff state === 'failed'* — was the textbook way to enforce the invariant. Either both hold or neither does.

## What happened

The `iff` refinement broke any pre-existing `state === 'failed'` record that lacked the new field. The FSM transition `running:retries_exhausted → failed` had existed in the table for weeks; even without a producer in this PR, adopters or earlier test states could have legitimate failed records. Codex 3rd-pass flagged it as migration-unsafe at confidence 9. Fix in `164800b`: loosen to `failure_reason → state === 'failed'` (implies, not iff). Adopters with bare failed states continue to parse; readers default to `'fatal'` when reason is absent.

## Why

Bidirectional invariants are stricter than they read. `iff` quietly bakes in TWO migration requirements — every old write must be rewritten with the new field, AND no future caller may forget it. The producer-side discipline only covers one direction; the schema must be asymmetric to support a phased rollout. Codex saw this because it reasoned about *existing on-disk records*; unit tests only saw freshly-written ones.

## Next time

Default zod refinements to one-directional `(implies)` over bidirectional `(iff)` unless a producer ships in the same release that backfills the new field. The asymmetric form expresses the load-bearing invariant — "if the new field appears, it can only mean X" — without demanding a migration sweep. A producer can later tighten back to `iff` once all writers are updated.
