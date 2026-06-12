![banner](forge-cover-v1--horizon-banner-3x1@2x.png)
# 🔨 Forge

> The delivery state machine for coding agents. Spec your project once, push it to your tracker, and let agents plan, build, test, review, and ship — gated by you only where it matters.

You already use Claude Code or Codex every day. You already know the failure modes: the agent that confidently rewrites the wrong abstraction, the PR that compiles but ignores the spec, the session that starts cold and re-derives last week's decisions, the review that's just the same model agreeing with itself.

Forge fixes this the way engineering orgs always have — with process — except the process is *executable*. It runs inside your coding agent as a set of skills backed by a real state machine: every task is claimed atomically, planned before it's coded, built in an isolated worktree, tested before review, reviewed by a **different model** than the one that wrote it, and shipped through gates that refuse weak work. Your tracker (Linear, GitHub Issues, or Notion) is the source of truth the whole time, so you watch progress where your team already looks.

The destination is full autonomy: you describe what you want, answer the architectural questions only you can answer, and the loop delivers — ticket by ticket, phase by phase, routing each task to the cheapest model that can actually do it. The v0.5 roadmap below is that loop. Everything under it already ships today.

## How it works

Three layers, one contract:

1. **A spec spine.** `/forge` interviews you into a BRIEF; `/draft-prd` and `/draft-spec` turn it into product and architecture truth; `/decompose` breaks it into a dependency graph of tasks; `/push-to-tracker` makes your tracker the live execution record. Each artifact owns specific fields — the tracker owns status, the SPEC owns architecture — so agents never act on a stale mental model.
2. **A state machine.** A CLI control plane (`forge orchestrate` — claim, dispatch, heartbeat, question, complete, reconcile, ~25 verbs) owns the task lifecycle: atomic claims with leases, isolated git worktrees per task, structured question/answer escalation, crash-safe resumable journals. Skills own the UX; verbs own the state. Nothing mutates state outside a verb, which is why the same machinery serves an interactive session and an autonomous loop.
3. **Enforced methodology.** Eight principles installed as gates, not advice: no fixes without root-cause analysis, no multi-file changes without an approved plan, no PR without tests, no critical-path merge without a second model's review, no secrets in the repo — and when the agent is confused, it asks you instead of guessing.

## Lifecycle at a glance

```
IDEA  → /forge        → spec/BRIEF.md
      → /draft-prd    → spec/PRD.md
      → /draft-spec   → spec/SPEC.md
      → /draft-design → spec/DESIGN.md       (optional, for UI products)
      → /decompose    → plans/phases.yaml    (dependency graph)
      → /push-to-tracker → Linear / GitHub Issues / Notion

TASK  → /pickup-task → /plan-task → /implement
      → /qa → /review → /second-opinion → /ship → /wrap-up

DRIFT → /reconcile    (tracker ↔ local sync)
      → /update-spec  (one decision propagated to SPEC + PRD + phases + tracker, atomically)
      → /amend-roadmap (new task mid-flight, journaled)

PHASE → /phase-gate → /retro → next phase
```

> The `/`-prefixed names are the Claude Code experience. The same skills install into Codex CLI, Cursor, and Gemini CLI — see [Cross-tool support](#cross-tool-support).

## What it protects you from

- **AI slop** — no code reaches main without a plan you approved, tests that pass, and dual-model review on critical paths. The reviewer is never the model that wrote the code.
- **Spec drift** — the spec lives in the repo and is the agent's required reading; `doctor` flags when SPEC symbols stop matching the source tree; accepted decisions propagate everywhere at once via ephemeral ADRs.
- **Agent inertia** — tasks resume from tracker state, never from a cold transcript. Leases expire, work is recoverable, nothing depends on a session staying alive.
- **Collision** — worktree-per-task isolation plus an overlap classifier mean parallel agents don't trample each other; dependency-aware dispatch means nothing ships before what it depends on.

## The road to v0.5: the autonomous loop

Forge v0.4 is a disciplined loop you drive. v0.5 is the same loop driving itself — built on the same verbs, which is the point of the state machine:

- **`/goal`** — a per-ticket driver whose exit condition is *shipped or parked*: plan → your approval → implement → bounded self-heal → dual review → merge.
- **`/deliver`** — the layer above: hand it a phase or a whole product, and it loops `/goal` over the dependency graph with themed batching and gate ceremonies.
- **A decision inbox, not a babysitting session** — plans and architectural questions park in a typed queue you drain async; everything mechanical runs unattended.
- **Model routing** — an agent-refreshed model catalog plus per-task capability floors, so the loop sends frontier models only where the task needs them and routes the rest cheaper — across hosts, not just within one.

This isn't speculative: the maintainer ships Forge with Forge, and the v0.4 releases on this very repo were delivered by exactly this loop run by hand — every ticket planned, cross-reviewed by a second model on a ≥8/10 gate, and merged on green CI.

## What it isn't

- Not a replacement for your coding agent — it shapes how the agent works, doesn't override it
- Not opinionated about your stack — Next.js, Django, Rails, Go, anything
- Not heavyweight infrastructure — no servers, no databases, no SaaS; state lives in git and your tracker
- Not a wrapper you invoke instead of your agent — it's skills your agent calls, backed by a CLI it can't bypass

## Install

One command. No git clone, no setup script.

```bash
npx @firatcand/forge
```

This runs an interactive setup that:
1. Detects which AI coding tools you have installed (Claude Code, Codex CLI, Cursor, Gemini CLI)
2. Installs the forge skills + specialist subagents into the right places
3. Optionally installs companion skills from [firatcand/founder-skills](https://github.com/firatcand/founder-skills) for deeper domain expertise

## Quick start

```bash
# Install forge globally (one time)
npx @firatcand/forge

# Initialize a new project
mkdir my-product && cd my-product
npx @firatcand/forge init

# Add your tracker API key to the git-ignored .forge/.env (e.g. for Linear)
echo 'LINEAR_API_KEY=lin_api_...' >> .forge/.env

# Open your AI coding tool — see Cross-tool support below for per-host invocation
claude
> /forge          # discovery interview → spec/BRIEF.md
> /draft-prd      # → spec/PRD.md
> /draft-spec     # → spec/SPEC.md
> /decompose      # → plans/phases.yaml
> /push-to-tracker # tracker project + per-phase grouping + issues
> /pickup-task    # claim first task, worktree created
```

In Codex CLI, the same skills are installed but Codex doesn't expose user-defined slash commands — invoke them by description instead, e.g. `Run forge's discovery interview for my project idea: ...`.

[Full quick start →](docs/QUICKSTART.md)

## Other commands

```bash
npx @firatcand/forge init [name]   # Initialize a project in current directory
npx @firatcand/forge upgrade       # Re-sync methodology + skills after a version bump
npx @firatcand/forge status        # Top-level project state report
npx @firatcand/forge doctor        # Audit installed skills + agents per detected tool
npx @firatcand/forge orchestrate   # The verb suite (claim, dispatch, reconcile, gc, …)
npx @firatcand/forge migrate       # Migrate a v0.2.x project
npx @firatcand/forge eject         # Reversible clean uninstall
npx @firatcand/forge --help        # Show all commands
```

## Cross-tool support

The installer detects which tools you have and installs forge skills + subagents into each. **The skills land in every host, but how you invoke them differs by host.**

| Host        | How to invoke a forge skill                                                                 | Status              |
|-------------|---------------------------------------------------------------------------------------------|---------------------|
| Claude Code | Typed slash commands: `/forge`, `/draft-prd`, …                                              | ✅ Verified          |
| Codex CLI   | Natural language — "Run forge's discovery interview for …"                                   | ✅ Verified          |
| Cursor      | Cursor host adapter (`.cursor/rules/forge-context.mdc`, agent CLI dispatch)                  | 🧪 Beta (opt-in)    |
| Gemini CLI  | Uses Gemini's `extensions` format                                                            | ⚠️ Unverified        |

Run `npx @firatcand/forge doctor` to confirm what's installed where.

## Why "forge"?

Forge is what you do when you have raw material (an idea) and want a finished tool (a product). The process is heat, pressure, shape, repeat. The framework's namesake skill `/forge` is a discovery interview that applies pressure to your raw idea until structure emerges.

## Inspiration

Forge stands on the shoulders of:

- **[gstack](https://github.com/garrytan/gstack)** — for the skill-as-specialist pattern, AI Slop detection, the Iron Law of Investigation, and the Confusion Protocol
- **[Every's Compound Engineering plugin](https://github.com/EveryInc/compound-engineering-plugin)** — for the 80/20 plan-heavy thesis and the compound learning loop
- **Boris Cherny's Claude Code best practices** — for context budgeting and plan mode discipline

What forge adds:
- **A real state machine** — atomic claims, leases, worktree isolation, resumable journals; interactive and autonomous flows share one code path
- **Tracker as execution truth** — Linear, GitHub Issues, or Notion behind one adapter; phases.yaml is a derived snapshot, never the authority
- **Phase decomposition with dependency graphs** — and dispatch that respects them
- **Cross-model review** — the model that wrote the code never reviews it
- **Stack-agnostic templates** — works with any tech stack, doesn't impose one

## Status

Forge is **v0.4.3** — developed *with* Forge, in production for the maintainer's own delivery loops. Stable enough to depend on, raw enough that you'll find sharp edges. Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The contribution model is gstack-shaped: skills as markdown files, principles in ETHOS.md, no exotic dependencies.
