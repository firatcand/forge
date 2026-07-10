# forge — CONTEXT (v-next)

> Synthesized: 2026-05-09 · Amended: 2026-05-17 (closed-loop workflow control, simplified) · **Re-amended: 2026-05-17 PM (team-mode minimum architecture — supersedes morning amendment in several places)**
> Source: spec/BRIEF.md, spec/PRD.md, spec/SPEC.md, spec/DESIGN.md, docs/plans/team-mode-minimum-architecture.md (canonical), docs/plans/closed-loop-workflow-redesign.md (superseded)
> Status: validated by /ingest-spec; amended via surgical edits 2026-05-17 (AM and PM); v0.5-deferred prose audited 2026-05-20 (FORGE-132)
> Next: /decompose unlocked (Phase 2.5 + new Phase 3)

## Amendments (2026-05-17 PM — team-mode minimum architecture)

Driven by [docs/plans/team-mode-minimum-architecture.md](../docs/plans/team-mode-minimum-architecture.md) and the PRD's PM amendment of the same date. After four Codex consult rounds the closed-loop drift workflow was rolled back to a minimum-viable shape. PRD.md and SPEC.md carry parallel amendment blocks; CLAUDE.md §Source of truth carries the canonical authority matrix.

**Sections in this CONTEXT that are now partially or fully superseded (read this amendment before trusting them):**

| Section | Status |
|---|---|
| §v-next scope: "six features" header + Feature 5 + Feature 6 | **Partially superseded** — v0.4 ships four features; Features 5 + 6 deferred to v0.5 |
| §The closed-loop drift workflow (lines ~53-80) | **Mostly v0.5** — drift workflow, ephemeral ADR *lifecycle*, `/update-spec` skill, drift events remain v0.5. **Exception:** the `apply-decision` verb + apply-journal shipped in FORGE-95 (2026-05-30) |
| §Locked architectural decisions Q12 (6-level precedence) | **Superseded** — replaced with authority-by-field (see below and CLAUDE.md §Source of truth) |
| §Locked architectural decisions Q13 (ephemeral ADRs) | **Deferred to v0.5** — only templates/adr.template.md ships in v0.4 (FORGE-92); full lifecycle lands in v0.5 |
| §Module layout: v0.5-deferred file paths | **Stripped** (per FORGE-132 audit) — see updated layout below for the authoritative v0.4 surface |

**Sections that stay as written:**

| Section | Status |
|---|---|
| §What forge is, §The problem, §Target user | Unchanged |
| §v-next scope Features 1-4 | Unchanged structurally; Feature 4 settings.yaml note slightly annotated for v0.4 vs v0.5 block ownership |
| §The two-host review pattern | Unchanged |
| §Locked architectural decisions Q1-Q11, S1-S6, HC | Unchanged |
| §Stack summary | Unchanged |
| §Migration sequence | Unchanged structurally; PR-9 footnote added for v0.4-vs-v0.5 doctor scope |
| §Non-goals, §Definition of done, §CLI design system summary | Unchanged |
| §What's blocked / open, §Known unknowns | Unchanged |

### Authority by field (replaces the 6-level precedence chain)

The morning's linear precedence rule (`user > SPEC > PRD > phases > tracker > attempts`) is replaced with a matrix of ownership by concern. Authoritative version lives in [CLAUDE.md §Source of truth](../CLAUDE.md); short form:

| Artifact | Owns |
|---|---|
| `spec/SPEC.md` | Architecture, constraints, non-functional requirements. Durable design-time truth. |
| `spec/PRD.md` | Product behavior, user-facing acceptance criteria. |
| `plans/phases.yaml` | Local execution snapshot (derived from tracker; do not hand-edit). **Status and dependency fields drift between `/reconcile --pull` runs and must be confirmed against the tracker.** |
| Tracker issue body | **Live execution truth:** status, assignee, sequencing, blockers, ownership. |
| Source code | Implementation. |

**Workers ask "whose field is this?" not "which artifact ranks higher?"** No drift event, no `/update-spec --apply` propagation, no forge-mediated escalation in v0.4. SPEC changes flow through standard git (`git commit && git push`).

**For status / readiness / dependency / blocker questions: always query the tracker directly** (`mcp__linear-server__get_issue`, `gh issue view`, `ntn`) — never grep `plans/phases.yaml`, which is a stale cache between `/reconcile --pull` runs. This rule lives canonically in [CLAUDE.md §Source of truth](../CLAUDE.md).

### Out of scope for v0.4 (re-listed for clarity)

- `/update-spec --draft` and `/update-spec --apply` skills (FORGE-93) — the `apply-decision` verb + apply-journal they wrap **shipped in FORGE-95 (2026-05-30)**; only the skill layer is still v0.5
- `/amend-roadmap` skill + verb
- `forge orchestrate worktree-drift-guard` verb
- Drift events, drift-routed questions, `QuestionIndex.drift_event_id`, `QuestionIndex.routing_hint`
- Section ownership tags
- Active worktree file-glob registry as architectural-safety gate
- Forge-enforced PR review policy

These remain valid v0.5+ opt-in features. The architecture supports their reintroduction; v0.4 just doesn't require them. The ADR template scaffold (`templates/adr.template.md`) does ship in v0.4 (FORGE-92) as preparation.

---

## What forge is

A **structured lightweight framework for engineering delivery**. Wraps Claude Code (or Codex / Cursor / Gemini) so solo developers and small teams can take a product idea, structure it into BRIEF → PRD → SPEC → DESIGN → phases.yaml, push tasks into their tracker (Linear / GitHub Issues / Notion), and orchestrate parallel coding agents to ship — all without leaving the coding agent.

Forge **suggests, never interrogates.** It does not question the idea or measure success. Engineering delivery quality is the only signal.

## The problem

Solo developers using Claude Code hit three concrete walls:

1. **Spec drift** — defining specs inside the coding agent is hard; users context-switch to claude.ai and break their thinking-execution context
2. **Agent inertia** — without a kanban surface, agents lose momentum across sessions
3. **AI slop** — combined effect is products that drift from what was envisioned

## Target user

Solo developers and small teams already using a coding agent (Claude Code / Codex CLI / Cursor / Gemini CLI) who have an idea worth building and want structure + delivery quality, not validation.

**JTBD:** *When I have a product idea and want to ship it with a coding agent, I want a lightweight framework that turns my plan into a spec, decomposes it into trackable phases, and orchestrates parallel agents — so I can stay in the coding agent and watch progress in my task tracker without switching contexts.*

## v0.4 scope (four features; Features 5 + 6 deferred to v0.5)

This iteration ships:

1. **Multi-tool task tracker** — pluggable adapter pattern. v-next supports Linear, GitHub Issues, Notion. Adapters at `src/trackers/<name>.ts` implementing the `Tracker` interface (extended 2026-05-17 with `updateIssueBody(id, body)`).
2. **Skill-driven parallel subagent orchestrator** — three-phase machine per task: **IMPLEMENT → REVIEW → SHIP**. Dispatch skill runs in the user's main Claude Code / Codex session and spawns host-native subagents; no separate process. Subagent-capped per main (default 3 — `agents.subagent_cap_per_main`). Multiple mains coexist via lease semantics. Exponential-backoff retry (capped 5 min). Each task in isolated worktree at `.forge/worktrees/<sanitized-id>/`. **Per the "suggest, don't force" principle (amended 2026-05-17):** dispatch skill calls `phases --ready` (read-only) to surface ready tasks for user approval before `claim` + `dispatch` mutations. See `ORCHESTRATOR.md` for the full control-plane + dispatch-layer + worker-prompt design.
3. **Init flow** — `npx @firatcand/forge init` interactive Q&A captures project context, tooling choices, orchestrator config; writes `.forge/settings.yaml` and scaffolds project files. Target <30 s end-to-end. Onboarding prompts (added 2026-05-17): primary/secondary coding agent CLI, GitHub auth check.
4. **`.forge/settings.yaml`** — single source of truth: project, tracker, secrets, agents (orchestrator), design, plus new `codex` + `doctor` blocks (added 2026-05-17). The `decisions:` block is reserved for v0.5 only (no v0.4 consumer). zod-validated; loaded by every CLI invocation (no long-running process to reload into).

> **Deferred to v0.5.** — Features 5 and 6 below describe the closed-loop drift workflow + mid-flight roadmap mutation primitives. They do **not** ship in v0.4. The original prose is preserved as v0.5 roadmap reference. v0.4 ships only the ADR template scaffold (`templates/adr.template.md`, FORGE-92) and `/reconcile` (FORGE-100); the rest lands in v0.5 (FORGE-93, FORGE-95, FORGE-101). See §Amendments (2026-05-17 PM) above for the rationale.

5. **Drift workflow + ephemeral ADRs (added 2026-05-17 — deferred to v0.5)** — `/update-spec --draft` opens a staging ADR at `spec/decisions/<date>-<slug>.md`; user reviews (optionally `/second-opinion review-decision`); flips frontmatter to `accepted`; `/update-spec --apply <slug>` propagates to SPEC + PRD + phases + tracker atomically (journal-backed for resumability) and **deletes the ADR file** — rationale lands in commit message body. `forge orchestrate doctor` enforces SPEC↔code drift only (no SPEC↔ADR check since ADRs are ephemeral).
6. **Mid-flight roadmap mutation (added 2026-05-17 — deferred to v0.5 except /reconcile)** — `/amend-roadmap` creates new tasks atomically in phases.yaml + tracker; `/reconcile {--pull|--push}` bi-directional sync (this part DOES ship in v0.4 via FORGE-100); `forge orchestrate worktree-drift-guard` proactively flags active worktrees affected by `/update-spec --apply` or `/amend-roadmap` (with `--dry-run` for preview).

**Dropped 2026-05-17 (was Feature 7 in earlier draft):** workflow-stage state machine + `.forge/workflow/state.json`, `suggest-next`/`session-check`/`intent-detect` verbs, SessionStart/Stop/UserPromptSubmit host hooks. Rationale: sole-user one-session-one-task workflow uses existing skill-end nudges + explicit `/status-check`; host hooks add platform fragility without solving a real problem.

Plus already-completed pre-PRD refactor: `/forge`, `/draft-prd`, `/draft-design`, `/ingest-spec`, BRIEF/PRD/DESIGN templates, README, .gitignore.

## The two-host review pattern (key architectural decision)

Every orchestrator-shipped task gets reviewed by a **different** coding agent than the one that wrote it. Generalizes ETHOS principle 6 from "Codex on CRITICAL.md paths" to **always-on multi-host adversarial review**.

- `agents.primary_host_cli` writes code (default `claude`)
- `agents.review_host_cli` reviews diff (default `codex`); must differ from primary
- Set `review_host_cli: null` to opt out (single-host mode, with startup warning)

Per task: IMPLEMENT (primary host subagent) → REVIEW (secondary host subagent writes verdict to `.forge/orchestrator/tasks/<task_id>/attempts/<attempt_id>/review_verdict.json`) → SHIP (primary host subagent opens PR after all declared dependencies are shipped + merged). `changes_requested` verdict regresses task state and dispatches a fresh IMPLEMENT attempt with findings injected. Workers are subagents (Claude Task tool / Codex native subagents), not subprocesses — see `ORCHESTRATOR.md`.

## The closed-loop drift workflow (added 2026-05-17 — deferred to v0.5)

> **Deferred to v0.5.** — the closed-loop drift workflow described in this section does not ship in v0.4. v0.4 uses standard git (`git commit && git push`) for SPEC propagation and the authority-by-field matrix (see §Amendments at top of this file and [CLAUDE.md §Source of truth](../CLAUDE.md)) for conflict resolution. The 6-level precedence chain, drift events, drift-routed questions, and `/update-spec --draft|--apply` skills all land in v0.5 (FORGE-93, FORGE-95, FORGE-101). See SPEC §21 for the architectural rationale.

**The thesis (v0.5 design intent):** SPEC is the sole durable source of truth. When architectural decisions shift mid-build, they get drafted as ephemeral ADRs, reviewed, then propagated to SPEC + PRD + phases + tracker atomically — leaving no drift between local artifacts and tracker, and no stale mental model for agents reading the canonical artifacts.

### Precedence rules (binding contract — 6 levels)

When two artifacts disagree, workers and skills follow this order:

1. **Current user instruction** (in active session) — highest
2. **`spec/SPEC.md`** — sole architectural source of truth
3. **`spec/PRD.md`** — product requirements
4. **`plans/phases.yaml`** — canonical execution scope (NOT equal to tracker)
5. **Tracker issue body** — projection of phases.yaml
6. **Older attempt notes** — lowest

Ephemeral ADRs are NOT in this chain — they're transient staging artifacts that disappear after `/update-spec --apply`.

### When workers detect drift

Worker emits a drift event via `forge orchestrate event --type drift`, writes a question via `forge orchestrate question --drift-event-id <id> [--routing-hint amend-roadmap]`, pauses with `blocked_on_question`. Supervisor routes via:

- `/update-spec --draft` + `--apply` (formalize architectural change → propagates to SPEC + PRD + phases + tracker; ADR deleted)
- `/amend-roadmap` (formalize new scope → updates phases.yaml + tracker)
- Direct answer (manual edit + commit + worker resumes)

### Skill ↔ verb contract

Skills own UX (diff previews, user confirmation, conversation); CLI verbs own deterministic state machine + machine-parseable I/O. Pattern: `/update-spec --apply <slug>` (skill, gets user confirm) → `forge orchestrate apply-decision --adr <slug>` (verb, atomic mutations + journal). See SPEC §Skill ↔ verb contract.

## Locked architectural decisions

(All resolved during /forge → /draft-prd → /draft-spec interview cycles.)

| # | Decision | Choice |
|---|---|---|
| Q1 | Orchestrator runtime | **CLI-as-control-plane + skill-as-dispatch** (revised 2026-05-14; v1 specced a daemon, abandoned — see ORCHESTRATOR.md "Changes from v1") |
| Q2 | Worker process | **Host-native subagents** (Claude Task tool / Codex `agents` dispatch) running in the user's interactive main session under subscription billing — never API keys, never Agent SDK quota, never subprocess `execa(host_cli, …)` |
| Q3 | Settings reload | Every CLI invocation re-reads `.forge/settings.yaml` (no long-running process needed) |
| Q4 | Concurrent agents default | 3 subagents per main session (`agents.subagent_cap_per_main`); multiple mains coexist via lease semantics |
| Q5 | GitHub adapter | `gh` CLI hard dep |
| Q6 | Install model | global + npx + per-project all supported |
| Q7 | Migration UX | `forge migrate` auto-convert with diff preview |
| Q8 | Tracker interface | TS interface in `src/trackers/base.ts` (formal in SPEC) |
| Q9 | Claim contract | Lease-backed local ownership (`lease_ttl_ms` default 30 min, heartbeat, steal-after-expiry) + per-adapter tracker CAS (Linear strong; GitHub/Notion best-effort) |
| Q10 | Branch / PR topology | Merge-to-main-between-phases (task ships only when all `depends_on` PRs are merged); stacked-PR strategy reserved in schema, not implemented in v-next |
| S1 | Language | TypeScript + tsup |
| S2 | YAML | `yaml` (eemeli/yaml) |
| S3 | Schema validation | `zod` |
| S4 | Tests | `node:test` + `tsx` |
| S5 | Process management | `execa` (used for `gh`, `git`, secret-manager CLIs — NOT for host CLIs) |
| S6 | Logging | stdout + chalk + JSONL append-only |
| HC | Two-host review | primary writes, secondary reviews; both required |
| Q11 | Suggest-don't-force (added 2026-05-17) | CLI verbs split into read-only vs user-approved-mutate; no verb silently claims or mutates; skill-end nudges are the only "suggestion" mechanism (no host hooks installed) |
| Q12 | Artifact precedence (added 2026-05-17 — **superseded 2026-05-17 PM**) | ~~6 levels: user > SPEC > PRD > phases.yaml > tracker body > attempts.~~ Replaced with **authority by field** (see §Amendments above and [CLAUDE.md §Source of truth](../CLAUDE.md)). No linear chain; each artifact owns specific concerns. |
| Q13 | Ephemeral ADRs (added 2026-05-17) | `templates/adr.template.md` shipped in FORGE-92; the `apply-decision` verb + apply-journal + ADR-file-deleted-on-apply semantics shipped in **FORGE-95 (2026-05-30)**. The `/update-spec --draft|--apply` skill that authors ADRs and drives the verb is FORGE-93 (still v0.5). |

## Stack summary

- **Runtime:** Node.js ≥18
- **Language:** TypeScript (strict, ESM)
- **Build:** tsup → dual ESM+CJS in `dist/`
- **Tests:** `node:test` + `tsx`
- **Runtime deps (new):** `yaml`, `zod`, `execa`
- **Runtime deps (existing):** `@inquirer/prompts`, `chalk`, `fs-extra`
- **Net package size impact:** ~150 KB unpacked (under 1 MB ceiling)

## Module layout

Authoritative as of the FORGE-132 audit (2026-05-20). Every path listed exists on disk.

```
src/
  bin/{forge,sync-status-render}.ts          # CLI entrypoints
  index.ts                                   # top-level barrel
  cli/
    {codex-suggest,envelope,init}.ts         # init + envelope + codex-suggest hint
    init/{preflight,prompts,scaffold,templates,validate}.ts
    orchestrate/                             # forge orchestrate <verb> — control plane surface
      # Read-only verbs
      {phases,status,questions,attach}.ts
      # /audit read-only core (FORGE-178/179/180; v0.5) — plan + collect + create-issues
      audit.ts
      # User-approved mutating verbs
      {claim,dispatch,heartbeat,question-write,answer,event,complete,cancel,gc,run-start,run-list}.ts
      # Doctor — SPEC↔code drift (FORGE-99)
      doctor.ts
      # Worktree lifecycle (FORGE-98) + spec diff for worker prompt (FORGE-114)
      {ensure-worktree,spec-diff}.ts
      # /reconcile (FORGE-100; v0.4)
      reconcile.ts
      # Worker prompt rendering (FORGE-97)
      render-worker-prompt.ts
      # Shared helpers
      {flags,guardrail-check,index,tracker-factory}.ts
  core/{errors,freshness,fs-atomic,index,logger,phases,secrets,settings,spec-revision,workspace}.ts
  harnesses/                                 # IHarness adapter abstraction (FORGE-88; v0.4)
    {base,subprocess,verdict-parser,claude,codex,gemini,index}.ts
  orchestrator/
    {attempt-events,events,glob-match,index,leases,overlap,state-machine}.ts
    drift.ts                                 # Doctor SPEC↔code checks (FORGE-99)
    reconcile.ts                             # /reconcile core (FORGE-100; v0.4)
    spec-diff.ts                             # Spec revision diff (FORGE-114)
    render-worker-prompt.ts                  # Worker prompt rendering core (FORGE-97)
    questions/{errors,index,lookup,paths,reader,writer}.ts
  schemas/
    {attempt,cli-args,index,lease,phases,questions,settings,task-state,trackers,verdict}.ts
  secrets-managers/{base,env-file,errors,index,types}.ts
  sync-status/{index,types}.ts               # /sync-status CLI surface
  trackers/{base,errors,footers,github,index,linear,notion,notion-mcp-transport,types}.ts
skills/
  forge/                                     # /forge discovery interview
  forge-orchestrate/                         # dispatch skill (per host; portability deferred to Phase 3)
  reconcile/                                 # /reconcile skill (FORGE-100; v0.4)
  audit/                                     # /audit read-only repo audit (FORGE-178; v0.5)
  # (other skills under skills/* are user-facing workflows — pickup-task, plan-task, implement,
  # ship, qa, etc. — not part of the forge CLI surface)
templates/
  worker-prompt.template.md                  # worker subagent prompt template
  adr.template.md                            # ephemeral ADR scaffold (FORGE-92; ships in v0.4 for v0.5 prep)
  {BRIEF,PRD,SPEC,DESIGN,CRITICAL}.template.md
  CLAUDE.project.template.md
  phases.template.yaml
  retro.template.md
  learning.template.md
  github-workflows/
test/{unit,integration,schemas,orchestrator,fixtures,helpers}/
```

> **Shipped FORGE-95 (2026-05-30):** `src/cli/orchestrate/apply-decision.ts`, `src/orchestrator/{adr,markdown-section}.ts`, `src/schemas/{adr,apply-journal}.ts`, `src/trackers/factory.ts`.
> **Still v0.5 (not on disk):** `src/orchestrator/{amend-roadmap,worktree-drift-guard,precedence}.ts`,
> `src/cli/orchestrate/{amend-roadmap,worktree-drift-guard}.ts`, `skills/{update-spec,amend-roadmap}/`.
> The ADR template scaffold (`templates/adr.template.md`) shipped in FORGE-92. See SPEC §21 for the architectural rationale.

## Migration sequence (the seed for /decompose)

9 PRs, parallelizable after PR-1:

1. **PR-1 — Build infra:** tsup + tsconfig + tsx + @types/node; wire `npm run build/typecheck/test`
2. **PR-2 — Schemas + utils:** `src/schemas/`, `src/utils/`
3. **PR-3 — Core:** settings, phases, logger, workspace
4. **PR-4 — Tracker base + GitHubTracker:** first adapter end-to-end
5. **PR-5 — LinearTracker + NotionTracker**
6. **PR-6 — Init flow:** `src/cli/init.ts` replaces `bin/forge.js` inquirer prompts
7. **PR-7 — Orchestrator (v2):** state machine, leases, events, gc, overlap detection, verdict verification; `forge orchestrate <verb>` CLI surface; dispatch skill; worker prompt template (the IMPLEMENT/REVIEW/SHIP phase machine driven by subagent dispatch — see ORCHESTRATOR.md)
8. **PR-8 — Migrate command:** `src/cli/migrate.ts` for v0.2.1 → v-next users
9. **PR-9 — Polish:** doctor extension, performance tests, docs, CHANGELOG, release *(doctor extension scopes for stale-ADR-draft and pending-apply-journal land in v0.5 alongside FORGE-93/95; the v0.4 doctor surface is SPEC↔code only — see SPEC §21 and PRD §Doctor enforcement)*

## Non-goals (canonical, all sources merged)

- No model/runtime/server/SaaS — forge always wraps a host
- No replacing Linear/GitHub/Notion — forge pushes into them
- No non-coding workflows — software products only
- No questioning user's idea, feature set, or tech stack
- No north-star metrics, OKRs, kill criteria
- No `@inherit` brand-book pattern (each project owns its DESIGN.md)
- No native parallel-agent runtime (adapt Symphony pattern)
- No long-running orchestrator process (dispatch skill runs in user's main session; CLI is stateless on-demand)
- No SDK-based dispatch (subprocess CLI only)
- No `fs.watch` (poll-on-tick only)
- No direct GitHub REST/GraphQL fallback (gh CLI required)
- No cross-machine orchestration
- No agent-to-agent comms beyond dependency graph
- No web UI / dashboard
- No unconditional auto-merge of PRs (opt-in platform-gated auto-merge via `ship.merge_policy: 'auto'` — dual-host review + honesty probe + final-SHA binding required; default remains human merge. ADR `orchestrator-ship-auto-merge`, 2026-07-10)
- No encrypted settings.yaml
- No runtime tracker switch (refuse with "tracker.type cannot change at runtime")
- Notion / Trello / Jira / Asana adapters deferred to v-next+1
- Cursor + Gemini orchestrator parity deferred to a separate verification task

## Definition of done

A user can:

1. `npx @firatcand/forge init` → `claude` → `/forge` → ... → `forge orchestrate`
2. Build a full software product end-to-end without leaving Claude Code
3. Watch progress in their tracker (Linear / GitHub / Notion)
4. Ship PRs reviewed by a second host before the PR can merge (human merge by default; opt-in platform-gated auto-merge per ADR `orchestrator-ship-auto-merge`)
5. Total time-to-first-shipped-task ≤ 2 hours including thinking

No metrics. No vanity KPIs. Engineering delivery quality is the only signal.

## CLI design system summary

(For reference when implementing CLI surface.)

- 6 chalk semantic roles: `info` (cyan), `success` (green), `warn` (yellow), `error` (red), `muted` (gray), `accent` (bold)
- All output routed through `core/logger.ts` semantic helpers — never raw `console.log`
- 80-column width target with explicit `wrap()` util
- Status prefixes: `✓` `✗` `→` `…` (ASCII fallback `[ok]` `[FAIL]` `->` `...`)
- Voice: terse, lowercase status verbs, no exclamation marks, no decorative emoji
- Exit codes: 0 success / 1 recoverable / 2 fatal / 130 SIGINT

## What's blocked / open until /decompose runs

- Detailed task split (each PR-N → multiple sub-tasks)
- Owner-type assignment per task (frontend / backend / db / devops / qa / security / design / integration)
- Estimate tagging (S / M / L / XL — XL must split)
- Dependency graph as DAG (validator catches cycles)
- Phase 1/2/3 gate criteria

These resolve in `plans/phases.yaml` produced by `/decompose`.

## Known unknowns deferred to implementation

(From SPEC §"Open questions deferred to phases.yaml decomposition" — implementation-detail level, don't change architecture.)

- Exact prompt forge sends to host CLI when dispatching a worker (templated in `templates/worker-prompt.md`)
- CHANGELOG migration message wording for v0.2.1 users
- Test fixture repos for the 3 tracker adapters
- Logging verbosity tier for redacted secrets
- Whether `forge doctor` runs at the start of `forge orchestrate` automatically
- Codex / Cursor / Gemini exact REVIEW phase invocation syntax (resolves in PR-7 plan)
