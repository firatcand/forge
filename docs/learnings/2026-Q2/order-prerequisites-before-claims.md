# Put idempotent prerequisites before state-mutating claims
> 2026-05-18 · FORGE-98 · tags: [architecture, state-machine, error-handling]

## What we expected
The dispatch plan had `claim → ensure-worktree → dispatch`. If ensure-worktree failed, the claim would be left held — a leak only `gc` could reconcile. The default reflex was to add explicit rollback in the skill: if ensure-worktree fails, call `forge orchestrate cancel <task>`.

## What happened
Codex 2nd-pass flagged the rollback branch as a design smell and a blocker. The order was inverted to `ensure-worktree → claim → dispatch`. Worktree creation has no dependency on claim; only dispatch does. With the inverted order, a worktree failure skips the task cleanly — no state has been mutated yet, so no rollback is needed.

## Why
Idempotent prerequisites (worktree create) should run before state-mutating operations (claim, dispatch). Rollback code is a smell that signals the fallible step ran too early. Reordering eliminates the failure mode at the source rather than patching it downstream.

## Next time
When designing a multi-step state machine, ask first: "can I reorder so the fallible-but-idempotent steps come before the stateful claims?" Often yes. Rollback is the last resort, not the default.
