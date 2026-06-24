# Parallel multi-task workflow: predict barrel conflicts upfront
> 2026-05-11 · FD-{8,11,13} · tags: [worktree, parallel-workflow, gotcha, process]

## What we expected
Fanning out 3 parallel feature tasks (FD-8 schema, FD-11 logger, FD-13 workspace manager) into separate worktrees would let plan → implement → review → ship run truly in parallel. Each task touches a different domain — schema, logger, workspace — so inter-task interference should be near-zero.

## What happened
Three PRs merged smoothly except FD-13, which hit an `add/add` merge conflict on `src/core/index.ts`. Both FD-11 and FD-13 had been asked to create the new `src/core/` barrel as part of their public-API deliverable, so each branch created `src/core/index.ts` from scratch with non-overlapping but parallel exports. Git treats two branches both creating the same path as an `add/add` conflict regardless of content overlap.

Resolution was mechanical (concatenate both export blocks), but it cost an unnecessary merge cycle on the slowest PR: `git fetch → git merge origin/main → resolve → commit → push → wait for GitHub mergeable recompute → merge PR`. About 5 minutes of avoidable serialization. The 3-way parallel benefit shrunk by ~30%.

## Why
"Different domain" doesn't prevent file collisions when **public-API barrels are shared**. Each task's plan correctly listed `src/core/index.ts` under "Files to change/create," but no global view intersected the plans before parallel kickoff. Per-worktree diff stats showed zero overlap pre-merge — overlap only materializes when the second branch tries to land. The orchestrator (the parallel-pickup driver) needs the pre-flight check; the per-task plan agent can't see it.

## Next time
When fanning out N parallel tasks, BEFORE kicking off plan-task agents:

1. **Intersect "Files to change/create" across tasks.** Two tasks creating the same NEW path → add/add conflict guaranteed.
2. **For files in the intersection that don't exist on main yet**: nominate one task to own creation, have the others modify (not create). Or pre-create the file on main with a stub so all parallel tasks `modify` rather than `add`.
3. **For files in the intersection that already exist (e.g., `src/index.ts`)**: usually trivial — additions at different positions auto-merge cleanly. Note in the plan that a small rebase is expected on the second merge.
4. **Document the planned merge order** in the parallel-pickup question so the user (and the orchestrator) knows which PR rebases.

**Alternative architectural fix that eliminates the class entirely**: prefer per-feature barrels and skip cross-cutting `src/core/index.ts`. Consumers import directly: `import { banner } from '@firatcand/forge/core/logger'`. Costs slight ergonomic friction (longer paths, requires `exports` map in package.json) but two parallel tasks creating sibling files under `src/core/` never collide. Worth considering for the v0.4 architecture pass.
