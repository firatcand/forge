# Forge Quickstart

## Install (one time)

```bash
git clone https://github.com/firatcand/forge ~/.forge
cd ~/.forge
./setup.sh
```

Add to your shell profile if needed:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configure once

In `~/.claude/CLAUDE.md`, add (optional but recommended):

```markdown
## Brand Assets (forge)
brand_assets:
  brand_book: ~/path/to/your/BRAND-BOOK.md
  design_system: ~/path/to/your/DESIGN-SYSTEM.md
  voice_register: ~/path/to/your/VOICE.md

## Stack Preferences (forge)
stack_preferences:
  default_frontend: Next.js 14 (App Router) + Tailwind
  default_backend: Supabase
  default_hosting:
    dev: Vercel preview
    prod: Vercel + Supabase
```

## Your first project

```bash
mkdir my-product && cd my-product
git init
forge init
claude
```

In Claude Code:

```
> /forge          # 15 min discovery interview
> /draft-prd      # PRD generated
> /draft-spec     # SPEC generated  
> /draft-design   # DESIGN generated (skip if no UI)
> /ingest-spec    # validation pass
> /decompose      # phases.yaml generated
> /setup-repo     # GitHub wired
> /push-to-tracker # tracker wired (linear / github / notion per .forge/settings.yaml)
> /pickup-task    # first task ready
```

## Daily flow

```
> /pickup-task        # claim task, worktree created
cd .forge/worktrees/<TICKET-ID>
claude
> /plan-task          # plan mode
> /implement          # execute
> /review             # multi-agent review
> /qa                 # tests
> /codex              # second opinion (if critical)
> /ship               # PR opened
> /learn              # capture learning if notable
```

## End of phase

```
> /phase-gate phase-1
```
