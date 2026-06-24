# Faithful deviation from ticket prose — record the why, prove it with a test
> 2026-05-30 · FORGE-167 · tags: [process, testing, planning]

## What we expected
Ticket scope prose said: stamp the `forge:claim` footer "after lease acquire" in `claim.ts`.

## What happened
Stamping after lease acquire (before the state write) means the two rollback branches
(lease-conflict, state-write CAS fail) would each have to *un-stamp* a footer for a claim
that never committed. Stamping AFTER the committed `writeTaskState` instead yields an
identical success state, but no rollback path ever has to un-stamp. We deviated from the
prose, recorded the why as "Decision 3" in the plan, and proved it with a test asserting
`tracker.fences.length === 0` on the state-write-failure rollback path.

## Why
Ticket prose pins intent, not the optimal control-flow point. The footer is an advisory
mirror of a *committed* claim; binding it to the commit is more correct than to the prose.

## Next time
When code correctness favors a different step than the ticket's literal wording, deviate —
but write the rationale into the plan (`[[plan-rationale-rot-when-deviating]]`) and land a
test that asserts the property the deviation buys (here: no footer on a failed claim), so
the choice is legible in git history, not just the conversation.
