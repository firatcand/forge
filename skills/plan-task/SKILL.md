---
name: plan-task
description: Run Plan mode for the current task. Outputs structured plan; required before /implement.
tools: Read, Write, Edit
---

# /plan-task

## Steps

1. Read Linear issue (or phases.yaml task) for current branch
2. Determine task type → delegate to relevant specialist subagent (frontend-dev, backend-dev, db-architect, etc.)
3. Specialist enters Plan mode: research codebase, propose approach
4. Write structured plan to `plans/tasks/{LINEAR-ID}.plan.md`:
   - Files to change (predicted)
   - Component tree / data flow
   - State / data flow
   - Edge cases
   - Test strategy
   - Open questions (Confusion Protocol triggers)
5. Show plan to user, wait for approval
6. On approval: commit plan, unlock /implement
