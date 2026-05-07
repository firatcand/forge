---
name: ship
description: Push branch, run final gates (tests, secrets scan, conventional commit), open PR with Linear issue ID, mark issue In Review.
tools: Bash(*), Read
---

# /ship

## Gates (all must pass)

1. **Tests**: `npm test` (or detected equivalent) passes
2. **Type check**: `npm run typecheck` (if applicable) passes
3. **Lint**: `npm run lint` (if applicable) passes
4. **Secrets scan**: `gitleaks detect` on the diff
5. **Conventional commit**: at least one commit on this branch follows `feat|fix|chore|docs(scope): message`
6. **Test-or-die**: new code has new tests; bug fixes have regression tests
7. **Multi-model review**: if diff touches CRITICAL.md paths, `/codex review` was run

If any gate fails, list what's missing. Do not proceed.

## Push and PR

1. `git push origin HEAD`
2. `gh pr create --base dev --title "[LINEAR-ID] {title from issue}" --body "{description}"`
3. PR body template:
   - What changed (3-5 bullets)
   - Why
   - How to test
   - Linked: closes #LINEAR-ID
4. Linear native sync: issue auto-moves to "In Review"

## Output

PR URL. Linear issue link. Reminder to run `/learn` if anything notable happened.
