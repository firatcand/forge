![banner](forge-cover-v1--horizon-banner-3x1@2x.png)
# 🔨 Forge

<p align="center">
  <a href="https://www.npmjs.com/package/@firatcand/forge"><img src="https://img.shields.io/npm/v/%40firatcand%2Fforge?style=flat&color=black" alt="npm version"></a>
  <a href="https://github.com/firatcand/forge/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/firatcand/forge/ci.yml?branch=main&style=flat&label=CI" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="docs/QUICKSTART.md">Quickstart</a> · <a href="ETHOS.md">Ethos</a> · <a href="spec/SPEC.md">Spec</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

**Forge** is a _delivery framework for coding agents_. It runs inside Claude Code, Codex CLI, Cursor, or Gemini CLI as a set of skills backed by a state machine, turns your idea into a spec and a dependency graph of tasks in Linear, GitHub Issues, or Notion — then drives each task through plan → build → test → review → ship. Your tracker is the source of truth the whole time; the agent is just the worker.

If you ship production code with agents and want every PR planned, tested, and reviewed like a team would — without babysitting the session — this is it.

Every failure mode of agent-driven development gets a named mechanism:

- **AI slop** → nothing reaches main without a plan you approved, tests that pass, and review by a model that didn't write the code
- **Spec drift** → the spec lives in-repo as the agent's required reading; `doctor` flags when SPEC symbols stop matching the source tree
- **Cold sessions** → tasks resume from tracker state, never from a dead transcript; leases expire and work is recoverable
- **Parallel collisions** → worktree-per-task isolation, overlap classification, and dependency-aware dispatch keep concurrent agents off each other's files

<table>
<tr><td><b>Spec-driven from day one</b></td><td><code>/forge</code> interviews your idea into BRIEF → PRD → SPEC → a dependency graph of tasks pushed to your tracker. Weak inputs are refused, not papered over.</td></tr>
<tr><td><b>A real state machine</b></td><td>~25 CLI verbs own the task lifecycle: atomic claims, expiring leases, isolated git worktrees, crash-safe resumable journals. Skills own the UX; verbs own the state — interactive and autonomous flows share one code path.</td></tr>
<tr><td><b>Your tracker is the truth</b></td><td>Linear, GitHub Issues, or Notion behind one adapter. Status, sequencing, and blockers live where your team already looks; local files are derived snapshots, never the authority.</td></tr>
<tr><td><b>Cross-model review</b></td><td>The model that wrote the code never reviews it. Paths listed in your <code>CRITICAL.md</code> require a second model's verdict before merge.</td></tr>
<tr><td><b>Methodology as gates, not advice</b></td><td>No fix without root-cause analysis, no multi-file change without an approved plan, no PR without tests, no secrets in the repo. A confused agent asks you instead of guessing.</td></tr>
<tr><td><b>Drift handled, not hoped away</b></td><td><code>/reconcile</code> syncs tracker ↔ local; one accepted decision propagates to SPEC + PRD + phases + tracker atomically via <code>/update-spec</code>; <code>/amend-roadmap</code> adds tasks mid-flight with journaled writes.</td></tr>
<tr><td><b>Multi-host</b></td><td>Claude Code (slash commands), Codex CLI (natural language), Cursor (beta host adapter), Gemini CLI. One installer detects and wires all of them.</td></tr>
<tr><td><b>Autonomous delivery <em>(v0.5 roadmap)</em></b></td><td><code>/goal</code> drives a ticket to <em>shipped or parked</em>; <code>/deliver</code> loops it across a phase or product; you answer architecture questions from an async inbox while model routing sends each task to the cheapest model that can actually do it.</td></tr>
</table>

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

## The road to v0.5: the autonomous loop

Forge v0.4 is a disciplined loop you drive. v0.5 is the same loop driving itself — built on the same verbs, which is the point of the state machine. `/goal` takes one ticket from ready to *shipped or parked* (plan → your approval → implement → bounded self-heal → dual review → merge); `/deliver` loops `/goal` over a whole phase or product; plans and architectural questions park in a typed async inbox instead of holding a session hostage; and a model router with an agent-refreshed catalog sends each task to the cheapest model that clears its capability floor.

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
- **[Paperclip](https://github.com/paperclipai/paperclip)** — for the orchestration mental model (without the heavyweight infrastructure)
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
