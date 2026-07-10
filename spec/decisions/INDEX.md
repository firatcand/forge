# Decision index

> Ephemeral ADRs are deleted after `/update-spec --apply`; this index is the
> durable, browsable record of each applied decision (FORGE-163). Each
> decision's full rationale lives in the SPEC sections it touched + the apply commit.

- 2026-07-10 — `orchestrator-ship-auto-merge` — retired the blanket "No auto-merge of PRs" non-goal (SPEC §Out of scope, PRD §Feature 2 non-goals + §PRD-additions, CONTEXT §Non-goals); defined opt-in platform-gated auto-merge (`ship.merge_policy`, default `approval`; `auto` requires dual-host review + fail-closed honesty probe + final-SHA binding); added the non-terminal `merge_pending` state (`shipped` = RepoHost-confirmed merged-to-base at the reviewed head SHA); PR operations live in the RepoHost abstraction (ORCHESTRATOR §RepoHost — tracker ⊥ repo host). Convention: `.forge/CONTEXT.md` §Ephemeral ADR workflow. Applied manually (skill layer FORGE-93 pending); epic FORGE-189, ticket FORGE-230, implementation FORGE-231…235.
