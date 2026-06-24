# Codex's state_version + lease-identity refinement was load-bearing for safety
> 2026-05-15 · FORGE-78 · tags: [orchestrator, race-conditions, planning, multi-model-review]

## What we expected
Consulting Codex on the rename vs unlink+link planning fork would yield a recommendation — pick one, move on.

## What happened
Codex returned a refinement beyond the binary choice: add `state_version` (monotonic counter) + `updated_by: { run_id, claim_id, generation }` to TaskState. Three review rounds later, a residual nanosecond race in steal was deemed acceptable precisely because this refinement provided defense-in-depth — every state mutation calls `assertLeaseOwnership`, which reads fresh from disk and catches a silently-stolen lease before it can corrupt state. Without `state_version` + `updated_by`, that race would be a real correctness bug.

## Why
The planning-fork question framed the choice as binary. Codex reasoned about the state diagram and identified what either option needed to be safe — a distinct level of analysis the implementer hadn't asked for.

## Next time
When consulting a second model on a planning fork, ask not just "which option?" but "what would you add to harden either option?" The refinement is often more valuable than the choice.
