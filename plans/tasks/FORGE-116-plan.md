# FORGE-116 — `/wrap-up` end-of-task housekeeping skill (+ `gc --remove-worktrees`)

> Status: implementing (Codex pre-opinion "revise" applied) · Attempt 019eb745-d72c-7225-83c9-769280f89440
>
> **Pre-opinion deltas (mandatory):**
> 1. (HIGH) `status --json` does NOT list per-task states — candidate discovery runs through the verb's OWN planner: `gc --remove-worktrees --dry-run --json` returns the eligible/refused task list; the skill consumes that. No status changes.
> 2. (HIGH) NO force flag in this ticket — CleanupOptions.force is too broad (bypasses gitignored-loss AND forces worktree removal). The gitignored-loss refusal surfaces verbatim with manual guidance (remove the offending files, re-run). Splitting force into narrow options is a follow-up.
> 3. (MED) Eligibility: `--task` allows ready_for_review / reviewed / shipped / cancelled / failed; BATCH mode allows only terminal (shipped / cancelled / failed); refuse unclaimed, ACTIVE states, abandoned — both modes.
> 4. (MED) Lease gate via readLease + classifyLeaseHealth: refuse `alive` AND `expiring_soon`; allow `stale`; RE-CHECK immediately before each cleanup; malformed lease → refuse (never treat as absent).
> 5. (MED) Worktree mode is a MUTUALLY EXCLUSIVE early mode in gc (never falls through to legacy migration/divergence); runOrchestrateGc becomes async.
> 6. (LOW) `deleteBranch: false` always — cleanup()'s branch deletion is unconditional -D, incompatible with the skill's -d-then-confirm--D policy. Verb removes worktrees only.
> 7. Marker shape is `{version, taskId, branch, createdAt, createdBy}` — use marker.branch (never assume feat/<id>); validate marker.taskId === dirname.
> 8. cleanup() throws NOT_FOUND — wrapper converts ONLY missing-worktree into the planned no-op; everything else propagates.
> 9. Tests: worktree-mode tests need a REAL git repo fixture (workspace.test.ts patterns), not gc's temp-.forge harness alone. Add flag-validation tests (missing --task value, conflicting modes, unknown flags rejected for this mode).
> 10. Contract test verifies actual handler parsing (invoke the registered handler / parse path), not just source-string grep.
> Surface verification: neither `gc --remove-worktree` nor `status --shipped` exists today. `workspace.cleanup(taskId, opts)` IS the engine (manifest-checked, gitignored-loss-guarded, branch-delete option). ORCHESTRATOR.md:607 names `gc --remove-worktrees` (plural) as the intended wrapper — this ticket builds it. No user-decision forks: the ticket prescribes the whole flow; skill↔verb split per contract.

## What ships

| Artifact | Content |
|---|---|
| `src/cli/orchestrate/gc.ts` | New flags: `--remove-worktrees [--task <id>]`. Wraps `workspace.cleanup` per task. SAFETY GATES (verb-side, non-negotiable): refuse when the task's state is ACTIVE (claimed/dispatched/running/blocked_on_question/awaiting_respawn — cleanup only for terminal/ready_for_review-and-merged flows is the SKILL's judgment; verb refuses ACTIVE outright); refuse when lease is live; surface workspace.cleanup's GITIGNORED_LOSS refusal verbatim (its `--force` story stays inside CleanupOptions — expose `--force-gitignored`). Without `--task`: iterate every `.forge/worktrees/*` whose task state is terminal (shipped/cancelled/failed), reporting per-task results. `--dry-run` composes with it (plan only). |
| `skills/wrap-up/SKILL.md` | The 6-step ticket flow: (1) scope detection — inside a worktree → task id from `.forge/worktree-task.json` marker (more reliable than branch-name parsing; fall back to branch regex), from main → list candidates by reading `forge orchestrate status --json` filtered to `shipped` + still-present worktree dirs, prompt pick-one-or-all; (2) PR-merged gate via `gh pr view <branch> --json state,mergedAt` — abort unmerged, NOTHING deleted; (3) `forge orchestrate reconcile --pull` (tracker Done → phases.yaml); (4) preview plan (worktree path, branch, main delta `git log main..origin/main --oneline`) + explicit confirmation (suggest-don't-force); (5) execute: `forge orchestrate gc --remove-worktrees --task <id>` → `git branch -d <branch>` (`-D` only after a second explicit confirm) → `git switch main && git pull --ff-only` (refuse if `git status --porcelain` non-empty on main; show the dirt); (6) one-line report. `--all` mode: same flow, single batched confirmation listing every task. |
| `test/unit/cli/orchestrate/gc.test.ts` | Extend: remove-worktrees happy path (terminal task → cleanup called, worktree gone), ACTIVE-state refusal, live-lease refusal, missing worktree = clean no-op, batch mode skips active + reports, --dry-run plans without deletion, gitignored-loss surfaces refusal. Reuse the existing gc test harness + workspace fixtures (worktree create/cleanup tests exist). |
| `test/unit/skills/wrap-up-contract.test.ts` | FORGE-93-pattern contract test: frontmatter; safety clauses pinned (unmerged-abort, confirmation-before-destruction, ff-only refusal on dirty main, -D second confirm); every referenced verb/flag exists in the real sources (gc remove-worktrees flag, reconcile --pull, status --json). |
| Registry/help | gc synopsis updated; EXPECTED_BANDS unchanged (gc already registered). CONTEXT template line for gc regenerates from registry. |

## Out of scope

- Codex/Gemini host variants (ticket: future-task).
- `status --shipped` flag: not needed — `status --json` already carries per-task states; the skill filters. (If it turns out status --json lacks a task-state listing, add the minimal field, not a flag.)
- Remote branch deletion (GitHub auto-deletes on merge per repo settings; skill notes it).

## Risks / notes

- workspace.cleanup deletes the worktree DIRECTORY + optionally branch; verify its exact CleanupOptions (deleteBranch, force) and let the skill drive branch deletion via git directly per the ticket's step 5 wording (verb removes worktree; branch deletion is a git op the skill owns — keeps gc's surface minimal). DECISION: verb does worktrees only; skill does branch + main ff.
- The integration-test AC ("dispatch → mock-merge → /wrap-up → verify") is host-skill-driven; the deterministic equivalent = gc unit/e2e coverage (worktree gone, state respected) + contract test pinning the skill's gh/git steps. Note this AC interpretation in the ticket on completion (FORGE-110 precedent).
- node_modules symlinks I've been planting in worktrees: cleanup's manifest check flags unexpected gitignored files — the refusal path is correct behavior; skill surfaces it and suggests removing the symlink first. Test covers it.
