# Schema-validate yaml at the boundary; the hand-rolled cast is a partial-write bug waiting to happen
> 2026-05-21 · FORGE-153 · tags: [backend, schema, zod, codex-review, partial-write-safety]

## What we expected
For `forge upgrade`, settings.yaml is "trusted" because it's written by `forge init` and validated against `SettingsSchema` at every load via `loadSettings()`. The upgrade verb does its own `yamlParse()` because it needs to mutate the working copy and re-serialize a minimal YAML (the schema-defaulted object would expand every default on round-trip). I cast the parse output to a hand-rolled `SettingsShape` interface listing only the fields I touched, figuring schema validation would happen elsewhere if needed.

## What happened
Codex's round-1 review caught that a user hand-editing `.forge/settings.yaml` to add an unknown agent kind — `enabled_root_files: [claude, cursor]` — would slip past the cast and reach the refresh loop at `for (const agent of settings.agents.enabled_root_files)`, where `ROOT_FILE_BY_AGENT[agent]` returns `undefined`, then `resolve(cwd, undefined)` throws. The throw happens AFTER step 4 has written `.forge/.version` and `.forge/CONTEXT.md`, leaving the repo in a half-upgraded state with no exit-3 clean refusal.

## Why
Casting `as SomeShape` is a type-system lie — it tells TypeScript to trust the runtime value without runtime evidence. For files that originate outside the program's write path (user edits, third-party tools, future schema versions on the same disk), the cast is exactly as safe as parsing unverified attacker input. The shape exists in the schema for a reason; bypassing it for "convenience" trades a 3-line `safeParse` call for partial-write states that are nearly impossible to test against the full matrix of malformed inputs.

The fix is `SettingsSchema.safeParse(raw)` at the top of the function, returning exit 3 with the schema's own error path/message on failure — `agents.enabled_root_files.1: Invalid enum value. Expected 'claude' | 'codex' | 'gemini', received 'cursor'`. Now refusal happens before ANY disk mutation, so the repo state is preserved cleanly even on the malformed-input path.

The working snapshot can still be the raw parsed YAML (so re-serialization stays minimal); the validated schema object only exists to gate the function entry. Both can coexist.

## Next time
Any verb that reads a YAML/JSON file owned by the *user* (settings, config, content) and writes back: run the schema at the entry. The cast is never worth it. The cost of `safeParse` is 3 lines + 1 import. The cost of a partial-write state is silent corruption that surfaces in production.

Rule of thumb: **at the boundary, validate. In the body, trust the validated type.** Pairs with [[validator-narrower-than-preserver-causes-silent-corruption]] (the inverse failure mode: validation that's narrower than the preservation step) and [[strict-schema-as-deliberate-exclusion-guard]].
