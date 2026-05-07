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

```bash
git clone https://github.com/firatcand/forge ~/.forge
cd ~/.forge
./setup.sh
```

This symlinks all skills and subagents into `~/.claude/`. Your existing Claude Code setup is left intact.

## Quick start

```bash
mkdir my-product && cd my-product
git init
forge init   # creates CLAUDE.md, spec/, plans/, docs/{learnings,retros}/

claude
> /forge      # Socratic Q&A, ~15 minutes
> /draft-prd  # PRD generated from BRIEF
> /draft-spec # SPEC generated from PRD
> /decompose  # phases.yaml generated from spec
> /setup-repo # GitHub repo + branch protection + CI workflows
> /push-to-linear # Linear project + cycles + issues
> /pickup-task    # claim first task, worktree created
```

[Full quick start →](docs/QUICKSTART.md)

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
