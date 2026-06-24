# Fix validates itself via dogfooding: the implementation IS the test

> 2026-05-18 · FORGE-81 · tags: [dogfooding, skills, learn, worktree, meta, validation]

## What we expected
Implement /learn dual-write contract → write contract + mechanism tests → ship. Three discrete phases, tests would be the canonical proof of correctness.

## What happened
Halfway through implementation I had to append "Closed by FORGE-81" addenda to two existing root-cause learnings in `docs/learnings/2026-Q2/`. Because `docs/learnings/` is gitignored, editing those files in the worktree alone would have orphaned the addenda on worktree removal — the exact bug being fixed. The natural action was to mirror them to `${MAIN_ROOT}` via `cp` from the worktree. The fix validated itself before any unit test ran. Then again at `/learn` time — this very learning landed via the new dual-write contract before the PR was even merged.

## Why
A fix to a workflow rule constrains the implementer too, not just future users. The auto-mode classifier even helped enforce this: it denied a sloppy `cp plan.md → main/plans/` ("polluting main from worktree") and then allowed the explicitly-scoped `cp learnings/*.md → main/docs/learnings/` ("applying the canonical-store contract"). Same mechanic, different intent — and the right read on each.

## Next time
When fixing a behavioral skill or workflow invariant, ask up front: *does this rule constrain my own next actions during this very implementation?* If yes, follow it by hand. The shape of the manual follow-along IS the shape of the fix — and it's the strongest validation you'll get before the tests run. Write the implementation's own actions into the test plan as a checkpoint, not an afterthought.
