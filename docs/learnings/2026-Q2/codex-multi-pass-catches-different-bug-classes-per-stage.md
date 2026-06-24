# Codex multi-pass catches different bug classes per stage
> 2026-05-20 · FORGE-22 · tags: [process, multi-model-review]

## What we expected

A single Codex pass on the plan would surface enough findings to lock the design. The diff pass would be a confirmation step.

## What happened

Three passes produced disjoint findings:

- **Plan pass 1** (8 findings) caught architecture-level mismatches against the existing surface — the FSM didn't have the transitions I claimed; the `Tracker.Issue` lacked the fields I planned to read; settings used different keys than I named.
- **Plan pass 2** (7 findings) caught the *secondary* architectural shape now that the gross errors were fixed — e.g., the spec amendment was actually 2 lines not 1, the planner needed an action-discriminated union, row 4 auto-recovery was unimplementable without an `Issue` schema change.
- **Diff pass** (7 findings, 2 BLOCKs) caught **runtime races and result-shape gaps** that no plan-level review could see — the heartbeat-renewal TOCTOU on `adminReleaseLeaseByIdentity`, the row-13 tie-sort canonical-deletion path, the schema-iff migration trap. These required *reading the actual code* not the prose plan.

## Why

Plan reviews catch problems in the *intent*. Diff reviews catch problems in the *execution*. Codex doesn't carry context across passes, so each one re-reads the artifact under review from scratch and finds whatever's most visible at that level. Pass 2 found different things than pass 1 because pass 2's input (rev-2) was structurally different from rev-1.

## Next time

Budget three Codex passes for any CRITICAL.md-touching change: pre-plan (architecture), post-plan (design coherence), post-impl (runtime/race). Don't collapse the post-impl pass into a "confirmation" — it's the only one that catches TOCTOU and concurrency bugs. Confidence ≥ 9 BLOCKs on the diff pass are real every time we've seen them; treat them as merge gates.
