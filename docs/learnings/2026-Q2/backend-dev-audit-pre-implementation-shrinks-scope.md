# Backend-dev audit pre-implementation shrinks scope
> 2026-05-23 · FORGE-108 · tags: [discipline, planning, audit, scope-cut]

## What we expected
FORGE-108 reads like a meaty init-flow rewrite — three new prompts (primary/secondary host CLI, GitHub connected?), async/skippable external validation, settings.yaml output extensions. Estimate was "M". Implementation order in the plan was 9 steps. Mental model: a few hundred lines of new code, a handful of new tests.

## What happened
Delegated a pre-implementation audit to backend-dev before drafting the plan: "for each AC bullet, find the relevant code and verify the behavior matches, then surface the actual delta." Verdict: 4 of 6 ACs were already DONE in `src/cli/init/*` from prior work (FORGE-88, FORGE-152). Real delta was ~250 lines (1 new prompt step, 1 new probe, 1 schema field, 1 PRD wording fix, +9 tests). The implementation order shrank from 9 steps to 3.

## Why
The original Linear AC text described the *aspirational* design from when the ticket was filed (2026-05-17), not the *current* state of the code after FORGE-88 and FORGE-152 had landed dependencies. Without the empirical audit, the plan would have been written from the AC text and proposed re-implementing wiring that already existed. The AC-as-unit-test discipline (`feedback_ac_as_unit_test.md` in memory) is "verify each AC bullet against live code before claiming it's done" — extended here to "verify each AC bullet against live code before claiming it needs to be DONE." Verification BEFORE implementation is just as load-bearing as verification AFTER.

## Next time
For any task with `Estimate: M` or larger, OR any task whose dependencies have shipped between filing and pickup, /plan-task should ALWAYS open with a backend-dev (or relevant specialist) audit step:
- Input: AC list + relevant source dir.
- Output: per-AC DONE / PARTIAL / MISSING / SPEC-DRIFT verdict with `file:line` evidence.
- Followed by: "real delta" enumeration as the basis for the plan.

The cost is one subagent call (~$0.02, ~90s). The downside risk is asymmetric: if you skip the audit and the scope is already 80% done, you waste hours writing duplicate code; if you skip and it's truly net-new, you lose 90 seconds. Always audit.

Adjacent pattern: AC text in a tracker is a snapshot from filing time. Dependencies landing between filing and pickup can silently move ACs from MISSING to DONE without the ticket body changing. Treat the AC body as a HYPOTHESIS about what's missing, not as a SPECIFICATION of what to build.

Related: `feedback_ac_as_unit_test.md` (memory), `spec-code-mismatch-reconcile-pattern.md` (sibling).
