# ACs that presuppose a runtime should be flagged as architectural forks at /plan-task
> 2026-05-21 · FORGE-89 · tags: [planning, skills, ac-design, foundation, process]

## What we expected
AC #10 ("show a per-session deprecation warning, suppressed for the rest of the session") could be implemented inside the skill body like any other behaviour.

## What happened
SKILL.md is markdown loaded by Claude Code — there is no persistent runtime between invocations. Hosting "seen this session" state would require a marker file in `/tmp` (race-y across multi-window sessions) plus ~20 lines of bash per skill load. The AC was dropped at /plan-task as fork #4 and replaced with "warn every invocation", noted in the PR body.

## Why
The AC author assumed a skill runtime with session scope. Skills have none. Attempting to emulate it in bash inside markdown is fragile, untestable, and doesn't survive concurrent windows.

## Next time
Before writing AC bullets for skill behaviour, ask: "where does this state live?" If the answer is not a file, a DB row, or a CLI verb's state machine, the AC presupposes a runtime that doesn't exist. Surface it at /plan-task as an architectural fork and get user sign-off on the downgrade — don't silently emulate it.
