---
name: qa
description: Run test suite, browser checks, and verify acceptance criteria. Bootstrap test framework if missing.
tools: Bash(*), Read, Edit
subagent: qa-engineer
---

# /qa

Delegate to `qa-engineer` subagent.

## Process

1. Detect test framework — if absent, offer to bootstrap (Vitest + Playwright defaults)
2. Run unit + integration tests
3. For UI tasks: run Playwright on key flows from PRD
4. Verify acceptance criteria from Linear issue are met
5. Report failures; auto-suggest fixes for trivial ones

## Test-or-die enforcement

If task is a bug fix and there's no regression test, REFUSE to pass /qa. Generate the regression test first.
