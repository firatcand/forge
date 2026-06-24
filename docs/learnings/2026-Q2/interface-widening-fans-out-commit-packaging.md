# Widening a shared interface fans out — it dictates commit packaging
> 2026-05-30 · FORGE-167 · tags: [typescript, workflow, refactor]

## What we expected
To split the work into 3 themed, independently-green commits (trackers / factory / verbs).

## What happened
Adding `setClaimFence` to the narrow `ClaimableTracker` interface forced EVERY implementor
to update in the SAME commit — `NoopTracker` plus 9 test `StubTracker`s across claim, cancel,
overlap, complete, dispatch, event, guardrail-check, heartbeat, question-write. The verb
behavior changes (claim/cancel) live in those same test files, so the orchestrate-layer
units couldn't be split into per-feature green commits. We shipped 2 layer-themed commits
(tracker layer; orchestrate layer) instead of 3, each independently typechecking.

## Why
A widened interface is a global constraint: TypeScript fails compilation for every structural
implementor until all are updated. "Independently green" commits must therefore be cut along
the interface-change boundary, not along feature boundaries.

## Next time
When a task widens a shared interface/abstract, plan commit boundaries around the widening up
front: one commit carries the interface change + ALL implementor/stub updates. Don't promise a
finer-grained commit split than the type system allows. A second-order win: typecheck after
staging each commit's file set to confirm independent greenness before writing the message.
