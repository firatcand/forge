# When a skill needs typed runtime dispatch, the answer is always a CLI verb
> 2026-05-21 · FORGE-89 · tags: [skills, cli, architecture, iharness, foundation]

## What we expected
The `/second-opinion` skill could call `IHarness.runReview` directly — either by inlining the adapter logic or by shelling out to a known path.

## What happened
Skills are markdown — they cannot import TypeScript. The only sound path to typed runtime logic is a `forge orchestrate <verb>` subcommand. Fork #1 at /plan-task surfaced this immediately; option A (CLI verb wrapping `IHarness.runReview`) was the only choice consistent with the skill↔verb contract already in CLAUDE.md. The verb landed at ~244 LOC with full tests.

## Why
The skill↔verb contract exists precisely for this: skills own user-facing prompts and confirmation gates; CLI verbs own state-machine transitions and typed dispatch. Mixing them makes the state machine untestable in isolation.

## Next time
Whenever a skill body needs conditional dispatch, typed parameters, or adapter selection: write a CLI verb, call it from the skill via `forge orchestrate <verb>`. Bash-in-markdown is never the right place for branching logic. The contract is in CLAUDE.md §Skill ↔ verb contract.
