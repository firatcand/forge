# Forge.Next Backlog

Items deferred from current phases. Triaged before next phase planning. Not committed; serves as a memory aid so good ideas surfaced during execution don't fall out of context.

## Phase 3 enhancement candidates

### `touches:` field for tasks → file-overlap detection in `/pickup-task`

Add an optional `touches: [paths]` field to each task in `plans/phases.yaml`. `/pickup-task` filters out tasks whose `touches` overlap with currently-claimed-and-in-flight tasks.

**Why:** Today `/pickup-task` only checks the dependency graph. Two tasks with no explicit `depends_on` but touching the same file can be claimed in parallel by different sessions → merge conflict at PR time. Phase 2 dodges this via clean decomposition (each tracker adapter in its own file), but it's a real edge case for repos with less disciplined decomposition.

**Scope:** ~30 lines in `skills/pickup-task/SKILL.md` + an optional field in `src/schemas/phases.ts`. Warning emitted if no eligible non-overlapping task remains but blocked tasks exist.

**Acceptance sketch:**
- Schema accepts optional `touches: string[]` (glob-friendly).
- `/pickup-task` skips tasks whose `touches` overlap with any in-flight task's `touches`.
- Falls back to "no eligible task" with clear reason if everything overlaps.

## Ergonomic enhancements (sandbox + worktree polish)

### `/pickup-task` should print sandbox-grant snippet

When `/pickup-task` creates a worktree, its "Next:" output should detect whether the user's sandbox is enabled and, if so, print the `sandbox.filesystem.allowWrite` entry they need to add. Otherwise the first `git commit` inside the worktree fails with a cryptic EPERM and the user has to diagnose it.

**Detection logic:** read merged settings (`~/.claude/settings.json` + project `.claude/settings.json`). If `sandbox.enabled === true` and `~/repos/<project>/.git` is not already in `sandbox.filesystem.allowWrite`, append a one-line note to the existing "Next:" block:

> Note: sandbox is enabled. Add `"~/repos/forge/.git"` to `sandbox.filesystem.allowWrite` in `.claude/settings.json` so git operations succeed inside this worktree.

**Scope:** ~15 lines in `skills/pickup-task/SKILL.md` + a tiny settings-resolver helper. No new dependencies.

### `forge init` should scaffold `.claude/settings.json` with worktree-aware sandbox config

When `forge init` scaffolds a new project, drop a `.claude/settings.json` template that pre-grants write access to the project's `.git/` directory. Adopters who later run `/pickup-task` + `git worktree` don't hit mystery permission errors when they flip sandbox on.

**Template content:**

```json
{
  "sandbox": {
    "enabled": false,
    "filesystem": {
      "allowWrite": ["~/repos/<PROJECT_NAME>/.git"]
    }
  }
}
```

`enabled: false` is the safe default — opt-in. `allowWrite` pre-filled with the project's `.git` path so flipping `enabled: true` later Just Works for the worktree workflow.

**Scope:** ~5 lines added to scaffolding in P2-T06 (init flow). Parameterize `<PROJECT_NAME>` from the prompt answers.
