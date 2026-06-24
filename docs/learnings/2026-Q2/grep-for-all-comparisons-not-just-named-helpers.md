# Reviews focus on named helpers; fix passes must grep for all comparisons
> 2026-05-15 · FORGE-78 · tags: [code-review, refactoring, ownership-checks]

## What we expected
Fixing "missing field X in ownership check" by updating the named helpers would be complete — reviewers had identified all the callsites.

## What happened
Reviewers found two sites: `assertLeaseOwnership` in `leases.ts` and its twin `assertLeaseOwnershipFromFile` in `state-machine.ts` (split to avoid a circular dep). The fix agent applied the `run_id` check to both — then while implementing, found a third inline ownership comparison inside `heartbeat` itself that neither review round caught. The inline check was performing the same logical work as the helper without calling it.

## Why
Reviewers grep for named helpers and their callsites. Inline comparisons that duplicate helper logic (the "should-be-a-helper-but-isn't" pattern) are invisible to that search strategy.

## Next time
When fixing a class of bug (e.g., "missing field X in ownership check"), after updating named helpers, grep for the comparison shape itself (e.g., `claim_id !==`) to catch inlined duplicates. Pin this as a checklist item for any "tighten invariant" fix pass.
