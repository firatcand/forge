# forge — Brief (v-next)

> Forged: 2026-05-08
> Status: draft (Gate 1 pending)
> Mode: next iteration with refactor — not greenfield

## The problem

Solo developers using Claude Code (or other coding agents) hit three walls:

1. **Spec drift.** They struggle to define product specifications inside the coding agent, and end up context-switching to claude.ai or external docs to think — breaking context between thinking and execution.
2. **Agent inertia.** Without a kanban-style surface (Linear, GitHub Issues, Notion), agents lose momentum across sessions. Each session restarts cold.
3. **AI slop.** The combined result is product outcomes that drift from what the user envisioned — features half-done, decisions undocumented, structure improvised.

Forge solves these by wrapping the coding agent with a structured discovery → spec → decompose → track → execute pipeline that **never forces the user to leave Claude Code** and pushes all task state into their existing tracker for observability.

## The user

**JTBD:** When I have a product idea and want to ship it with a coding agent, I want a lightweight framework that turns my plan into a spec, decomposes it into trackable phases and tasks, and orchestrates parallel agents — so I can stay in the coding agent and watch progress in my task tracker without switching contexts.

**Persona:** Solo developers and small teams who already use Claude Code (or Codex CLI / Cursor / Gemini CLI). They have an idea worth building. They are not seeking validation — they are seeking structure and delivery quality.

## What forge is

A **structured lightweight framework for engineering delivery**. Forge wraps the host coding agent and plays four roles inside it: product manager, system architect, engineer, and security reviewer.

Forge **suggests, never interrogates.** It does not question the user's idea, feature set, or tech stack. It clarifies intent, proposes structure, surfaces best practices, and pushes work into the user's task tracker.

## The smallest valuable thing — v-next scope

1. **Refactor `/forge` skill** — drop philosophical/founder-validation questions (unfair advantage, north-star, kill criteria). Replace with product/spec questions only: what is the product, who uses it, what's in/out of scope, what unknowns exist.
2. **Refactor BRIEF / PRD / SPEC templates** — strip the killed sections; align with the new philosophy.
3. **`/draft-prd` per-feature discovery loop** — extend the existing skill with an iterative per-feature interview (not a new skill).
4. **`/draft-spec` orchestrates founder-skills `software-architect`** — auto-invoke the existing companion skill for tech-stack suggestions; fall back gracefully if companions aren't installed. No new forge-native architecture skill.
5. **`/draft-design` redesigned**:
   - Each project owns its `spec/DESIGN.md` (no `@inherit` from maintainer's brand book — `@inherit` pattern deleted entirely).
   - At init, `/draft-design` asks: "Do you have a design system to reference (URL/file/brand-book), or should I create one for this project?"
   - Reference mode: stored as `design_system_ref:` field; treated as a *constraint* on generation, not a parent.
   - New mode: generate self-contained palette, type scale, spacing, components from product requirements.
6. **Multi-tool task tracker** — extend beyond Linear:
   - v-next supports: Linear, GitHub Issues, Notion.
   - Pluggable adapter pattern so future trackers (Notion, Trello, etc.) can be added.
   - Init flow asks user which tracker to use; pushes phases/tasks/state accordingly.
7. **Symphony-style parallel agent orchestrator**:
   - Polls the chosen task tracker, dispatches eligible tasks to agents in worktrees.
   - Dependency-aware: an issue's `blocks` relations gate dispatch (matching Symphony's model).
   - Concurrency-capped: default `max_concurrent_agents: 10`.
   - Per-task isolation: deterministic worktree path per task ID.
   - Failure handling: normal exit → short continuation retry; abnormal exit → exponential backoff up to a cap. Default retry cap **10 attempts**, then notify user.
   - Both **parallel** (independent tasks within a phase) and **orchestrated** (cross-phase sequencing) supported.
8. **Init flow additions** — `npx @firatcand/forge init` asks:
   - Project description, goals, workflows
   - Task tracker (Linear / GitHub Issues / Notion)
   - Secret manager (`.env` file [default] / 1Password / AWS Secrets / Doppler / Infisical)
   - Concurrent agent cap (default 10)
   - Retry attempts (default 10)
9. **Settings file `.forge/settings.yaml`** — single source of truth for orchestrator + tracker + secret config. Hot-reloadable (Symphony pattern).
10. **Touch only the skills affected by 1–9.** Other skills (`/qa`, `/setup-repo`, `/codex`, `/ship`, `/review`, `/learn`, etc.) stay untouched.

## Non-goals — what forge does NOT do

- Own a model, runtime, server, or SaaS. Forge always wraps a host (Claude Code, Codex CLI, etc.).
- Replace Linear / GitHub Issues / Notion. Forge pushes into them; it does not become a tracker.
- Support non-coding workflows (writing, design-only, etc.). Forge builds **software products only**.
- Question the user's idea, feature set, or tech stack. Forge suggests; the user decides.
- Measure success via north-star metrics, OKRs, or kill criteria. This is engineering delivery infrastructure, not a startup tool.
- Inherit the maintainer's personal brand book. Each project owns its design system or references one as an external asset.
- Build a parallel-agent runtime from scratch. Adapt Symphony's proven orchestration model rather than reinventing.

## Definition of done

A user can:

1. Run `npx @firatcand/forge` once + `npx @firatcand/forge init` in a project
2. Describe their idea in `/forge`, watch it become BRIEF → PRD → SPEC → DESIGN → phases.yaml → tracker issues
3. Run multiple parallel agents (up to the configured cap) on independent tasks
4. Stay inside Claude Code the entire time; observe progress in their tracker
5. Ship a full software product with no drift between vision and output, no AI slop, no half-done features

If those five steps work end-to-end on a real product, v-next is done. There is no north-star metric, no adoption KPI, no kill criteria. **Engineering delivery quality is the only signal.**

## Constraints inherited from forge's positioning

- **Wrap, don't replace.** Forge composes existing tools (Claude Code, Linear, founder-skills, Symphony's pattern). Adding a wrapper is preferred over building native.
- **Lightweight.** Skills as markdown files. No exotic runtime. No heavyweight infra.
- **Stack-agnostic.** Works with Next.js, Django, Rails, Go, Rust, anything.
- **Cross-host parity.** Same skills land in Claude Code, Codex CLI, Cursor, Gemini CLI (invocation differs by host).

## Open questions

- **Settings format**: Symphony uses front-matter in `WORKFLOW.md` with hot-reload. Forge's `.forge/settings.yaml` proposed here — adopt YAML or mirror Symphony's WORKFLOW.md pattern for consistency?
- **Tracker adapter abstraction**: shared interface (`Tracker.list_active_issues`, `Tracker.claim`, `Tracker.update_state`) or one bespoke adapter per tool? Affects extensibility.
- **Per-feature discovery loop in `/draft-prd`**: how does it interact with the user's existing `brainstorming` skill (from superpowers)? Does forge defer when brainstorming is present?
- **Migration**: existing forge users on the `@inherit` pattern — clean break (v0.3 = breaking) or graceful deprecation path?
- **Symphony's `WORKFLOW.md`**: borrow the file directly or only the orchestration patterns?
- **Concurrency default of 10**: Symphony's default is also 10, but for solo developers on a laptop, is 10 realistic? Confirm in /draft-spec phase.

## Source material

- Symphony orchestration patterns: https://github.com/openai/symphony (SPEC.md)
- Existing forge framework: this repo (v0.2.1)
- Founder-skills companion library: `software-architect`, `product-spec`, others as relevant
- ETHOS.md (this repo) — 8 principles to be revisited where they conflict with the new philosophy
