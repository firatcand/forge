---
name: ship
description: Push branch, run final gates (tests, secrets scan, conventional commit), open PR with Linear issue ID, mark issue In Review.
tools: Bash(*), Read
---

# /ship

## Preflight: worktree guard

Task-scoped mutating skill — must run from a worktree, not the main checkout. Contract: `skills/_shared/worktree-guard.md`.

```bash
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
if [ -z "$TOPLEVEL" ]; then
  echo "✗ worktree-guard: not inside a git repository" >&2
  exit 1
fi
BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo 'main')"
if [ -f "$TOPLEVEL/.forge/worktree-task.json" ]; then
  echo "✓ worktree-guard: $TOPLEVEL ($BRANCH)"
elif [ "$BRANCH" = "${DEFAULT_BRANCH:-main}" ]; then
  echo "✗ worktree-guard: refusing to run on default branch '$BRANCH' from $TOPLEVEL" >&2
  echo "  Parallel Claude Code sessions on the main checkout clobber each other's HEAD." >&2
  echo "  → cd into an existing worktree, or run /pickup-task to create one." >&2
  exit 1
else
  echo "⚠ worktree-guard: no .forge/worktree-task.json at $TOPLEVEL (branch: $BRANCH)" >&2
  echo "  Proceeding, but this worktree may be manually-created or stale." >&2
fi
```

## SPEC-changes signal (informational — never blocks the ship)

After the worktree guard and before the gates, surface whether `spec/` changed
since THIS task was claimed (FORGE-164 — the push-time half of the FORGE-114
mitigation). This is strictly informational: it NEVER blocks the ship; it just
makes a stale-claim risk visible in the PR.

```bash
# TASK_ID is the current task (from .forge/worktree-task.json).
forge orchestrate spec-diff "$TASK_ID" --json
```

- If the `data` field is non-null (commits touching `spec/` landed since the
  claim), do two things:
  1. Print the rendered block to the operator.
  2. Add a `### ⚠ SPEC changes since this task was claimed` section to the PR
     body (see the template below) listing the commit summaries, plus a pointer
     to `forge orchestrate spec-diff --all-active` for OTHER affected tasks.
- If `data` is null, omit the section entirely — no SPEC drift to report.

To see every active task whose claim predates a spec/ change (not just this one):

```bash
forge orchestrate spec-diff --all-active --json
```

This is a cockpit view for the operator; it always exits 0 and never gates.

## Gates (all must pass)

1. **Tests**: `npm test` (or detected equivalent) passes
2. **Type check**: `npm run typecheck` (if applicable) passes
3. **Lint**: `npm run lint` (if applicable) passes
4. **Secrets scan**: `gitleaks detect` on the diff
5. **Conventional commit**: at least one commit on this branch follows `feat|fix|chore|docs(scope): message`
6. **Test-or-die**: new code has new tests; bug fixes have regression tests
7. **Multi-model review**: if diff touches CRITICAL.md paths, `/second-opinion review-impl` was run

If any gate fails, list what's missing. Do not proceed.

## Push and PR

1. `git push origin HEAD`
2. `gh pr create --base dev --title "[LINEAR-ID] {title from issue}" --body "{description}"`
3. PR body template:
   - What changed (3-5 bullets)
   - Why
   - How to test
   - Linked: closes #LINEAR-ID
   - **`### ⚠ SPEC changes since this task was claimed`** — ONLY when the
     SPEC-changes signal above returned a non-null `data`. List the commit
     summaries and add: "Other active tasks may also be affected — run
     `forge orchestrate spec-diff --all-active`." This section is informational;
     it documents the risk, it does not block the merge.
4. Linear native sync: issue auto-moves to "In Review"

## Output

PR URL. Linear issue link. Reminder to run `/learn` if anything notable happened.

After the PR is open, emit the second-opinion suggestion hint:

```bash
forge second-opinion suggest ship
```

Prints `💡 Suggested next: /second-opinion review-impl (run with FORGE_AUTO_SECOND_OPINION=0 to disable)`.
Silent when `FORGE_AUTO_SECOND_OPINION=0` is set or `second_opinion.auto_enabled: false` in `.forge/settings.yaml`.
Independent of the CRITICAL.md hard-gate in §Gates.7 — that runs `/second-opinion` automatically; this is a soft suggestion for the user to invoke `/second-opinion review-impl` after the fact.
