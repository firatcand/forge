# Plan rationale comments rot the moment you deviate from another part of the plan
> 2026-05-21 · FORGE-153 · tags: [workflow, plan-task, code-comments, plan-discipline]

## What we expected
When a plan doc has detailed step-by-step TDD code and rationale comments, the natural impl flow is to copy the rationale into the code as comments (so future maintainers see *why*). When I deviated from one part of the plan — tightening edit-detection to only fire when `versionsMatch=true` — I documented that deviation explicitly in the commit message and plan §"deviations" list. The OTHER rationale comments in the plan (e.g., "stamp .version FIRST as sentinel for crash-safety") I left as-is because they seemed orthogonal to my deviation.

## What happened
Codex's round-1 review caught that the "stamp .version FIRST" rationale was load-bearing AND wrong — but only after my deviation. The sentinel-first crash-safety argument assumed the next upgrade would see SHA-mismatch and silently overwrite (the plan's original edit-detection). My deviation tightened edit-detection so SHA-mismatch with matching versions is now a refusal. Post-crash that's exactly the state sentinel-first produces. So the deviation broke the sentinel rationale, and I never audited the interaction.

Three layers of failure:
1. I treated the plan's rationale comments as orthogonal facts, not load-bearing claims that depend on the surrounding logic.
2. My commit message said "deviation #1: edit-detection tightening" but didn't list "audited all rationale comments that depend on this."
3. 17 unit tests + 13 e2e tests didn't have a crash-state fixture, so the interaction was invisible to the test suite.

## Why
A plan doc's rationale comments are written against an idealized impl where every other comment is also true. Deviating from one comment changes what's true elsewhere — often in non-obvious ways. The deviation list documents what *you* changed; it doesn't document what *the rest of the plan now claims falsely*.

The atomicity argument was specifically: "if crash, next run sees SHA mismatch and re-runs idempotently." That's true under the ORIGINAL edit-detection (refuses only on real edits, defined narrowly). Under the TIGHTENED edit-detection (refuses on any SHA mismatch when versions match), the next run sees the same mismatch as a "user edit" and refuses with exit 1. Same input, opposite output, because the surrounding predicate flipped.

## Next time
When deviating from a plan, do a second pass over the plan's other rationale comments and ask: "does my deviation invalidate this?" For each comment that touches the same data flow or predicate, write a one-line audit note in the commit body — either "still holds because X" or "this comment is now wrong, here's the new rationale."

For complex verbs (multiple writes, version comparisons, edit detection), add a crash-state test BEFORE the post-review round: bootstrap an inconsistent on-disk state and assert recovery behavior. The cost is one test; the alternative is shipping a bug Codex finds in review (which is cheap) or production finds at adoption time (which is not).

Pairs with [[re-derive-why-before-accepting-second-opinion-polish]] (similar pattern, opposite direction: when a reviewer suggests a change, audit whether their rationale matches your current code).
