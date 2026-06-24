# Bug-fix scope balloons during investigation — anchor back to the bug
> 2026-05-18 · FORGE-135 · tags: [process, scoping, investigation]

## What we expected

Investigate codex hang → diagnose → write a small fix → ship. ~1 hour.

## What happened

Investigation correctly identified the stdin bug in ~10 minutes. But it also surfaced a *neighboring* problem: `CodexHarness.runReview` spawns `codex exec` from Node, which contradicts the subscription-only invariant in `spec/PRD.md:524` and `spec/ORCHESTRATOR.md:65`. From there, scope expanded twice:

1. First proposal: adopt `openai/codex-plugin-cc` + delete `CodexHarness.runReview`. Ticket FORGE-135 created with full plugin-adoption scope (estimate: 3 points, 9 acceptance criteria, "supersedes FORGE-89", "partially reverts FORGE-88").
2. User redirected: "What's the trade-off between plugin and our own version?" Surfaced the singularity goal — one review interface for Codex AND Gemini.
3. User redirected again: "keep the harness and fix these stdni issues." Final scope: just `stdin: 'ignore'` + tests + doc. 1 commit, 5 files, 146 lines.

Final scope ~6× smaller than peak proposal. The eventual shipped fix was the original investigation's "Proposed fix" verbatim.

## Why

Investigation discovers neighboring problems. The bias is to "fix everything we now see" — but each addition compounds risk, increases blast radius, and delays the bug fix. The right behavior is to **file the neighboring problems separately and stay narrow on the original bug**.

Two specific mistakes I made:

- Surfaced the architectural concern (`spec invariant violation`) as a *coupled* fix in the same ticket, instead of as a separate "follow-up ticket if interested?" question.
- Drafted the FORGE-135 ticket body around the bigger proposal before getting alignment on scope. The body then needed two rewrites as scope contracted.

## Next time

When investigation surfaces an architectural concern adjacent to the bug:

1. Finish writing the bug-only fix proposal.
2. Surface the architectural concern as a *separate* sentence: "Side observation: X. Want a follow-up ticket, or out of scope?"
3. Don't draft the bigger ticket until the user picks the bigger scope.
4. If they pick smaller — minimum-over-expansion is the strong default for solo work, per `feedback_user_prefers_minimum_over_expansion.md`.

A useful smell: if the ticket title needs rewriting because scope contracted, the original ticket was scoped to the *proposal*, not the *agreement*. Write tickets to the agreement.
