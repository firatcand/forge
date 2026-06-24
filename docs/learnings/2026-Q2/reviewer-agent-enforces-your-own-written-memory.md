# The code-reviewer agent can enforce your own written-down memory against you

> 2026-05-17 · FORGE-94 · tags: [testing, code-review, memory, ac-as-unit-test, trackers]

## What we expected
Freshly written round-trip tests for `updateIssueBody` asserting `assert.match(captured, /<!-- forge:task=... -->/)` were sufficient: the footer pattern appears in the output, so the round-trip is correct.

## What happened
The code-reviewer agent flagged the tests as a "structure exists implies behavior correct" smell — exactly the failure mode documented in memory note `feedback_ac_as_unit_test.md`. The tests should have called `parseForgeFooters` on the captured output and asserted `result.forgeTaskId === expected`, not just checked that the raw string contains the footer pattern. The reviewer read the ACs and the test source independently and connected them.

## Why
Writing down a rule in a memory file is only half the loop. The other half is a review step that reads your ACs and your tests side by side and asks whether the tests actually exercise the AC's claimed behavior. That connection is invisible when the author and the reviewer are the same person in the same context — you rationalize the test as complete because you wrote it. An external agent with a cold read on both artifacts makes the gap visible.

## Next time
After writing tests, do a one-pass reviewer prompt: "Given these ACs and these test bodies, does each test fail when the behavior is wrong, or only when the structure is wrong?" That's cheaper than a full review cycle and specifically targets the structure-existence smell. The smell is endemic to footer/annotation round-trip tests — anywhere you're verifying presence of a marker string rather than re-parsing the output.
