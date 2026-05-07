![banner](forge-cover-v1--horizon-banner-3x1@2x.png)
# 🔨 Forge

> A lightweight Claude Code framework that takes you from idea to production with structure, not friction.

Forge is for solo founders and small teams who want to ship real products with Claude Code — not just experiment with it. It gives you a structured workflow for the parts that matter (ideation, decomposition, phase gates, learning capture) and stays out of your way for the parts where Claude Code already shines (planning, implementing, reviewing).

## What it is

Forge ships:

- **21 slash commands** covering the full product lifecycle from raw idea to production
- **12 specialist subagents** — frontend, backend, db, qa, security, devops, design, plus orchestrators
- **13 templates** for PRD, SPEC, DESIGN, phases.yaml, GitHub workflows, and more
- **8 best practices baked in** — Boil the Lake, Iron Law of Investigation, Compound Learning, Test-or-die, Multi-model Second Opinion, and more
- **Linear ↔ GitHub native sync** — tasks auto-update on PR open/merge
- **Git worktree-based parallelism** — run multiple Claude Code sessions on the same project without collision

## What it isn't

- Not a replacement for Claude Code — it shapes how you use Claude Code, doesn't override it
- Not opinionated about your stack — works with Next.js, Django, Rails, Go, anything
- Not heavyweight infrastructure — no servers, no databases, no SaaS
- Not a CLI you invoke instead of Claude — it's a set of skills Claude calls when relevant

## Lifecycle at a glance

```
IDEA  → /forge        → spec/BRIEF.md
      → /draft-prd    → spec/PRD.md
      → /draft-spec   → spec/SPEC.md
      → /draft-design → spec/DESIGN.md       (optional, for UI products)
      → /ingest-spec  → spec/CONTEXT.md      (validation pass)
      → /decompose    → plans/phases.yaml
      → /setup-repo   → GitHub repo wired
      → /push-to-linear → Linear project + cycles + issues
      
TASK  → /pickup-task → /plan-task → /implement
      → /review → /qa → /codex → /ship → /learn

PHASE → /phase-gate → /retro → next phase

PROD  ← /phase-gate phase-3 ← (manual PR dev → main)
```

~90-120 minutes from raw idea to first task ready to implement.

## Install

One command. No git clone, no setup script.

```bash
npx @firatcand/forge
```

This runs an interactive setup that:
1. Detects which AI coding tools you have installed (Claude Code, Codex CLI, Cursor, Gemini CLI)
2. Installs the 21 forge skills + 12 subagents into the right places
3. Optionally installs companion skills from [firatcand/founder-skills](https://github.com/firatcand/founder-skills) for deeper domain expertise

> Prefer the original bash flow? `git clone` + `./setup.sh` still works as a fallback.

## Quick start

```bash
# Install forge globally (one time)
npx @firatcand/forge

# Initialize a new project
mkdir my-product && cd my-product
npx @firatcand/forge init

# Open your AI coding tool and run /forge
claude       # or: codex, cursor, gemini
> /forge          # Socratic Q&A → spec/BRIEF.md
> /draft-prd      # → spec/PRD.md
> /draft-spec     # → spec/SPEC.md
> /decompose      # → plans/phases.yaml
> /setup-repo     # GitHub repo wired
> /push-to-linear # Linear project + cycles
> /pickup-task    # claim first task, worktree created
```

[Full quick start →](docs/QUICKSTART.md)

## Other commands

```bash
npx @firatcand/forge install      # Install/reinstall forge skills + agents only
npx @firatcand/forge init [name]  # Initialize a project in current directory
npx @firatcand/forge companions   # Install founder-skills companions only
npx @firatcand/forge --help       # Show all commands
npx @firatcand/forge --version    # Show version
```

## Cross-tool support

Forge works with:
- ✅ Claude Code (`~/.claude/`)
- ✅ Codex CLI (`~/.codex/`)
- ✅ Cursor (`~/.cursor/`)
- ✅ Gemini CLI (`~/.gemini/`)

The installer detects which tools you have and installs to all of them by default. You can choose specific tools during setup.

## Why "forge"?

Forge is what you do when you have raw material (an idea) and want a finished tool (a product). The process is heat, pressure, shape, repeat. The framework's namesake skill `/forge` applies Socratic pressure to your raw idea until structure emerges.

## Inspiration

Forge stands on the shoulders of:

- **[gstack](https://github.com/garrytan/gstack)** — for the skill-as-specialist pattern, AI Slop detection, the Iron Law of Investigation, and the Confusion Protocol
- **[Every's Compound Engineering plugin](https://github.com/EveryInc/compound-engineering-plugin)** — for the 80/20 plan-heavy thesis and the compound learning loop
- **[Paperclip](https://github.com/paperclipai/paperclip)** — for the orchestration mental model (without the heavyweight infrastructure)
- **Boris Cherny's Claude Code best practices** — for context budgeting and plan mode discipline

What forge adds:
- **Phase decomposition with dependency graphs** — neither gstack nor Every's CE has this
- **Linear ↔ GitHub native sync** — durable external task system instead of internal state
- **Brand-book inheritance** — `@inherit` pattern lets your design system stay single-source-of-truth across projects
- **Stack-agnostic templates** — works with any tech stack, doesn't impose Next.js + Supabase

## Status

Forge is **v1.0** — used in production by the maintainer for solo founder workflows. Stable enough to depend on, raw enough that you'll find sharp edges. Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The contribution model is gstack-shaped: skills as markdown files, principles in ETHOS.md, no exotic dependencies.
