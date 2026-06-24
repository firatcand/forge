# Worktree hydration runbook: the four paths to copy after `git worktree add`

> 2026-05-13 · FORGE-64 · tags: [worktree, pickup-task, dogfooding, runbook, follow-up]

## What we expected
`/pickup-task` per the skill text copies `plans/phases.yaml` into a fresh worktree (the FORGE-62 fix). That should be enough for `/plan-task` to read scope and start working.

## What happened
On FORGE-64, `/plan-task` still ran into input blindness — the planner needed `spec/SPEC.md` and `spec/ORCHESTRATOR.md` to design against; both are gitignored and absent from the fresh worktree. The skill copy step also doesn't include `plans/tasks/*.plan.md` (so the next `/implement` precondition would fail) or `docs/learnings/2026-Q2/*` (so the learning-curator finds nothing to inject). Manual `cp` of all three trees brought the worktree up to a usable state.

## Why
`worktrees-blind-to-gitignored-context.md` flagged the root cause structurally; this is the concrete operational follow-up. The exhaustive hydration set is: `spec/*.md` (BRIEF, CONTEXT, DESIGN, PRD, SPEC — ORCHESTRATOR.md happens to be tracked), `plans/phases.yaml`, `plans/tasks/*.plan.md`, and `docs/learnings/**/*.md`. Anything less and the downstream skills hit a wall they can't resolve themselves.

## Next time
Fold the full hydration set into `pickup-task`'s SKILL.md so the next worktree is usable out of the box. Until then, the runbook is one line:
```
cp spec/*.md "$WT/spec/" ; cp plans/phases.yaml "$WT/plans/" ; cp plans/tasks/*.plan.md "$WT/plans/tasks/" 2>/dev/null ; cp -r docs/learnings/* "$WT/docs/learnings/"
```
Also: write new learnings to the **main worktree's absolute path**, not `./docs/learnings/`, so they survive worktree cleanup. The inverse-failure half of the original learning bites just as hard as the input-blindness half.

## Closed by FORGE-81 (2026-05-18)

The write-to-main-path prescription is now enforced by `/learn` itself. The skill resolves `MAIN_ROOT` via `git rev-parse --git-common-dir` (matching the idiom `/pickup-task` already uses on its hydration side), writes the canonical record to `${MAIN_ROOT}/docs/learnings/{quarter}/{slug}.md`, then mirrors to the worktree path when `pwd -P != MAIN_ROOT`. Contract codified in `spec/SPEC.md §Learnings store`; markdown-content and mechanism tests in `test/unit/skills/learn.contract.test.ts` and `test/integration/skills/learn.test.ts`.
