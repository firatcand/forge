# Structural placebo: a test against a fake must assert what the fake received
> 2026-05-17 · FORGE-100 · tags: [testing, placebo, ac-as-unit-test, fakes]

## What we expected
The e2e test "round-trip: pull → push → re-pull yields no further updates" verifies body fidelity across a full round-trip. The test existed, ran green, and the test name implied the property was pinned.

## What happened
`FakeTracker.updateIssueBody` discarded the `body` argument — it tracked that the call happened but stored nothing. The round-trip assertion checked only that a second `--pull` produced no diff. That is trivially true: the diff scope is title + depends_on, which are unchanged regardless of what body reached the tracker. The property the test name advertised was never verified. Codex called this a "structural placebo" in the 2nd-pass review.

## Why
The test was written against the diff output, not against the fake's state. "No diff on second pull" is an easy assertion to write and passes even when the fake is hollow. The developer's mental model said "round-trip works" but the test only confirmed "second pull is quiet" — a narrower and easier property.

## Next time
Any test that invokes a fake should assert on what the fake received, not just that the call happened. "Fake received body X" is the spec; "function was called" is not. When writing a fake, always store the full argument set (not just the call count or primary key) so assertions can reach the data. Apply this to every `update*`, `write*`, `send*` fake method in the codebase.
