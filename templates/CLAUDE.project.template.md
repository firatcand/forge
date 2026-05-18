# {{PROJECT_NAME}}

## Stack
<!-- Auto-populated by /draft-spec — keep in sync with spec/SPEC.md -->

## Branch strategy
- `main` → production (protected, no direct push)
- `dev` → integration (protected, PRs only)
- `feat/{LINEAR-ID}-{slug}` → working branches in worktrees

## Commands
- Build: `npm run build`
- Test: `npm test`
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Dev: `npm run dev`

## Conventions
<!-- Project-specific. Examples: -->
- Functional components only, no class components
- Always handle errors explicitly — no silent catches
- New API routes must have input validation
- See `spec/` for full conventions

## Forge principles (auto-applied — see [Forge ETHOS.md](https://github.com/firatcand/forge/blob/main/ETHOS.md))
1. Boil the Lake — refuse weak inputs
2. Iron Law of Investigation — no fixes without RCA
3. Confusion Protocol — clarify, don't guess
4. Test-or-die — every PR ships with tests
5. Compound Learning — capture notable learnings
6. Multi-model Second Opinion — Codex on critical paths
7. Plan Mode Mandatory — no multi-file changes without /plan-task
8. 12-Factor Env Discipline — never commit secrets

## Source of truth

Forge projects are multi-artifact. Each artifact OWNS specific fields. When two artifacts seem to disagree, ask **"whose field is this?"** — not "which artifact ranks higher?" Most apparent collisions are two artifacts each owning different fields of the same decision.

| Artifact | Owns |
|----------|------|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements. Durable design-time truth. |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria. |
| `plans/phases.yaml` | Dependency graph (cached snapshot of the tracker). **Status fields are stale** until `/reconcile --pull` runs. |
| Tracker body (Linear / GitHub / Notion) | Live execution truth: status, assignee, sequencing, blockers, ownership. |
| Source code | Implementation. |

**Rule for AI agents:** any "is this task done?" / "what's the active queue?" / "what's ready to pick up?" question MUST be answered by querying the tracker directly — `mcp__linear-server__get_issue` / `list_issues` for Linear, `gh issue view/list` for GitHub, `ntn` for Notion. Never grep `plans/phases.yaml` for status. The dependency graph (`depends_on`, ACs, IDs) IS authoritative in `phases.yaml`; status fields (`status`, `completedAt`) are NOT.

**Tiebreaker** (only when artifacts actually collide on the same field, not different fields of the same decision): user explicit instruction > `spec/SPEC.md` > `spec/PRD.md` > `plans/phases.yaml` > tracker body > prior attempt logs.

## Skill ↔ verb contract

Skills (`/pickup-task`, `/plan-task`, `/implement`, `/ship`, etc.) own user-facing UX: question prompts, confirmation gates, plan display. CLI verbs (`forge orchestrate <verb>` — `claim`, `dispatch`, `complete`, etc.) own the state machine: idempotent transitions, lease management, atomic file writes.

**Rule:** skills NEVER mutate orchestrator state directly. Every state change goes through a verb. This keeps the state machine testable in isolation and means interactive flows (`/pickup-task`) and automated flows (`/forge orchestrate dispatch`) share one code path.

See `spec/SPEC.md` §Skill ↔ verb contract and `spec/ORCHESTRATOR.md` §CLI surface for the full state-machine ownership story.

## Ephemeral ADR workflow (v0.5 — not active in v0.4)

In-flight architectural decisions are drafted as **ephemeral ADRs** in `spec/decisions/<YYYY-MM-DD>-<kebab-slug>.md` using the scaffold at `templates/adr.template.md`. The `/update-spec --apply <slug>` skill propagates an accepted ADR to SPEC + PRD + `phases.yaml` + tracker bodies, then **deletes the ADR file**; rationale lives in the propagation commit message. SPEC remains the sole durable source of truth — no permanent ADR archive.

Not active in v0.4. The `/update-spec` skill, `apply-decision` CLI verb, and `spec/decisions/` directory all land in v0.5.

## Critical paths
<!-- Files matching these patterns trigger /codex auto-review on /ship -->
See CRITICAL.md
