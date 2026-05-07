---
name: fix
description: Apply a fix based on /investigate output. Refuses to run without recent investigation.
tools: Edit, Read, Bash(*)
---

# /fix

## Preconditions

`plans/tasks/{LINEAR-ID}.investigation.md` must exist and be < 24 hours old.

## Process

1. Read investigation
2. Apply minimal fix matching root cause
3. Add regression test that reproduces the original bug (Test-or-die)
4. Verify fix + test passes
5. Commit with conventional message: `fix(scope): brief description`

## After 3 failed attempts

Stop. Demand fresh `/investigate`. Do not thrash.
