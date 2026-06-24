# Convergent refactor: same helper extracted to two different homes

> 2026-05-30 · FORGE-95 · tags: [foundation, process, git]

## What we expected
A clean rebase before merge. The plan-time research even noted `src/cli/orchestrate/tracker-factory.ts` existed and judged it "distinct — no conflict."

## What happened
PR #253 (FORGE-167) and this branch *independently* extracted the same `createTracker` + `TrackerHandle` block out of `reconcile.ts` — #253 into the existing `src/cli/orchestrate/tracker-factory.ts`, this branch into a NEW `src/trackers/factory.ts`. Both deleted the identical block and re-pointed the import to different paths → git conflict, plus latent duplication (two `createTracker` defs) that a naive resolution would have shipped. The two append-hotspots (`CHANGELOG.md` `[Unreleased]`, `schemas/index.ts` barrel) conflicted too, trivially.

## Why
The "distinct, no conflict" judgment was true only at the branch point: `tracker-factory.ts` then held just the claim-only `ClaimableTracker`. #253 concurrently grew it to hold exactly the helper I was extracting. Two devs spotting the same DRY opportunity once a second caller appears is a *predictable* collision, not bad luck — and the second-to-merge always eats it.

## Next time
Before extracting a shared helper, grep for an existing factory/module for that concern and extract INTO it — don't create a new file. Assume the obvious refactor may be in flight on a parallel branch. For the cheap append-hotspots (CHANGELOG `[Unreleased]`, barrel `index.ts`), expect a conflict and resolve by union. Resolve a convergent refactor in two steps: (1) take the other branch's version of the touched file during rebase, (2) a dedicated follow-up commit to fold your unique bits into the surviving module + delete the duplicate — keep mechanical conflict resolution separate from semantic de-duplication.
