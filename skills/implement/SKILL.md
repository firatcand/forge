---
name: implement
description: Execute the approved plan from /plan-task. Refuses to run without an approved plan unless --quickfix flag.
tools: Edit, Read, Write, Bash(*)
---

# /implement

## Preconditions

- `plans/tasks/{LINEAR-ID}.plan.md` exists and was committed
- OR `--quickfix` flag with justification

## Execution

1. Read plan
2. Execute step-by-step, committing after each logical unit
3. Use conventional commit messages
4. If you encounter a Confusion Protocol trigger not in the plan, STOP and ask
5. Run `npm run typecheck` (or equivalent) after each major change

## Output

Summary of files changed, commits made, any deviations from plan.
