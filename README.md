![banner](forge-cover-v1--horizon-banner-3x1@2x.png)
# 🔨 Forge

> A lightweight coding agent framework that takes you from idea to production with structure, not friction.

Forge is for solo founders and small teams who want to ship real products with coding agents — not just experiment with it. It gives you a structured workflow for the parts that matter (ideation, decomposition, phase gates, learning capture) and stays out of your way for the parts where Claude Code already shines (planning, implementing, reviewing).

## What it is

Forge ships:

- **21 skills** covering the full product lifecycle from raw idea to production (typed as slash commands in Claude Code; invoked by description in Codex CLI — see [Cross-tool support](#cross-tool-support))
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
      → /push-to-tracker → tracker project + per-phase grouping + issues
      
TASK  → /pickup-task → /plan-task → /implement
      → /review → /qa → /second-opinion → /ship → /learn

PHASE → /phase-gate → /retro → next phase

PROD  ← /phase-gate phase-3 ← (release from main)
```

~90-120 minutes from raw idea to first task ready to implement.

> The `/`-prefixed names above are the Claude Code experience — typed slash commands. In other hosts (Codex CLI, Cursor, Gemini CLI), the same skills are available but invoked differently. See [Cross-tool support](#cross-tool-support) below.

## Install

One command. No git clone, no setup script.

```bash
npx @firatcand/forge
```

This runs an interactive setup that:
1. Detects which AI coding tools you have installed (Claude Code, Codex CLI, Cursor, Gemini CLI)
2. Installs the 21 forge skills + 12 subagents into the right places
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
> /setup-repo     # GitHub repo wired
> /push-to-tracker # tracker project + per-phase grouping + issues
> /pickup-task    # claim first task, worktree created
```

In Codex CLI, the same skills are installed but Codex doesn't expose user-defined slash commands — invoke them by description instead, e.g. `Run forge's discovery interview for my project idea: ...`. Codex's model picks the skill up from `~/.codex/skills/forge/SKILL.md`.

[Full quick start →](docs/QUICKSTART.md)

## Other commands

```bash
npx @firatcand/forge install      # Install/reinstall forge skills + agents only
npx @firatcand/forge doctor       # Audit installed skills + agents per detected tool
npx @firatcand/forge init [name]  # Initialize a project in current directory
npx @firatcand/forge companions   # Install founder-skills companions only
npx @firatcand/forge --help       # Show all commands
npx @firatcand/forge --version    # Show version
```

If a slash command stops triggering in one of your AI tools (e.g. you installed Codex CLI after running forge for the first time), run `npx @firatcand/forge doctor` to see exactly what's installed where, then `npx @firatcand/forge install` to sync.

## Cross-tool support

The installer detects which tools you have and installs forge skills + subagents into each. **The skills land in every host, but how you invoke them differs by host.**

| Host       | Install path                          | How to invoke a forge skill                                  | Status                |
|------------|---------------------------------------|--------------------------------------------------------------|-----------------------|
| Claude Code | `~/.claude/skills/`, `~/.claude/agents/` | Typed slash commands: `/forge`, `/draft-prd`, …            | ✅ Verified            |
| Codex CLI  | `~/.codex/skills/`, `~/.codex/subagents/` | Natural language — Codex doesn't expose user slash commands. Ask the model: "Run forge's discovery interview for …" | ✅ Skills load; no `/forge` syntax |
| Cursor     | `~/.cursor/skills/`, `~/.cursor/agents/`   | Unverified — invocation mechanism not yet tested by maintainer | ⚠️ Unverified          |
| Gemini CLI | `~/.gemini/extensions/`                | Unverified — uses Gemini's `extensions` format, may need manual config | ⚠️ Unverified          |

If you're on Codex/Cursor/Gemini and `/forge` doesn't trigger, that's expected — try the natural-language form. Run `npx @firatcand/forge doctor` to confirm the skills are physically present at the expected paths.

If you discover the right invocation pattern for Cursor or Gemini and it differs from natural language, please open an issue or PR — the maintainer is actively looking for confirmation on those two.

## Why "forge"?

Forge is what you do when you have raw material (an idea) and want a finished tool (a product). The process is heat, pressure, shape, repeat. The framework's namesake skill `/forge` is a discovery interview that applies pressure to your raw idea until structure emerges.

## Inspiration

Forge stands on the shoulders of:

- **[gstack](https://github.com/garrytan/gstack)** — for the skill-as-specialist pattern, AI Slop detection, the Iron Law of Investigation, and the Confusion Protocol
- **[Every's Compound Engineering plugin](https://github.com/EveryInc/compound-engineering-plugin)** — for the 80/20 plan-heavy thesis and the compound learning loop
- **[Paperclip](https://github.com/paperclipai/paperclip)** — for the orchestration mental model (without the heavyweight infrastructure)
- **Boris Cherny's Claude Code best practices** — for context budgeting and plan mode discipline

What forge adds:
- **Phase decomposition with dependency graphs** — neither gstack nor Every's CE has this
- **Linear ↔ GitHub native sync** — durable external task system instead of internal state
- **Project-owned design systems** — each forge project owns its `spec/DESIGN.md`, with optional reference to an external brand asset as a generation guideline (no runtime inheritance)
- **Stack-agnostic templates** — works with any tech stack, doesn't impose Next.js + Supabase

## Status

Forge is **v0.2.1** — used in production by the maintainer for solo founder workflows. Stable enough to depend on, raw enough that you'll find sharp edges. Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The contribution model is gstack-shaped: skills as markdown files, principles in ETHOS.md, no exotic dependencies.
