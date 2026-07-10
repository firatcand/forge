# Applied decisions index

One line per applied ephemeral ADR. The ADR file is deleted on apply (see
CLAUDE.md §Ephemeral ADR workflow); durable rationale lives in the SPEC/PRD
sections each decision touched plus the propagation commit message.

- 2026-07-10 `orchestrator-ship-auto-merge` (FORGE-230, epic FORGE-189) — retired the blanket "No auto-merge of PRs" non-goal (SPEC:1376, PRD:263+575, CONTEXT:278). Defined opt-in platform-gated auto-merge: `ship.merge_policy` (default `'approval'` = human merges); `'auto'` requires dual-host review + fail-closed branch-protection honesty probe + final-SHA binding (merged head == reviewed SHA). Added non-terminal `merge_pending` state between `reviewed` and `shipped` (`shipped` now means merged-to-base). PR operations live in a new RepoHost abstraction — tracker ⊥ repo host. Threat model §human-merge-gate rewritten; residual auto-mode risk explicitly accepted by owner. Codex plan review: v1 rejected (4 CRITICAL), v2 accepted. Implementation: FORGE-231…235.
