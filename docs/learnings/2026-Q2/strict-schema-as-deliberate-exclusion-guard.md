# Use .strict() as a guard when a field is deliberately excluded from a schema
> 2026-05-18 · FORGE-113 · tags: [schema, zod, architecture, design-intent]

## What we expected
Zod's default `.object()` behaviour (`.strip()`) would be fine — unknown keys are silently dropped, so the absent field causes no runtime harm.

## What happened
`tracker_revision` was deliberately dropped from `SourceSchema` (see [[re-derive-why-before-accepting-second-opinion-polish]]). With `.strip()`, any hand-edit, stale tool output, or older `/reconcile` version that re-added the key would be silently accepted and discarded — the omission would be invisible. Making `SourceSchema` `.strict()` turns that silent acceptance into a parse-time rejection, making the deliberate exclusion self-enforcing.

## Why
`.strip()` is the right default for forward-compat tolerance (accept future fields gracefully). `.strict()` is the right choice when the schema is intentionally narrower than the world — i.e., the absence of a field is a design decision, not an oversight.

## Next time
When excluding a field deliberately, add `.strict()` at the schema definition and leave a comment naming the excluded field. This turns intent into enforcement and prevents silent re-introduction by any future author or tool. Conversely, if a schema must tolerate fields it doesn't know about yet, `.strip()` (the default) is the explicit right call — make that choice consciously too.
