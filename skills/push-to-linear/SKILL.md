---
name: push-to-linear
description: Push phases.yaml to Linear — creates project, cycles per phase, issues with depends_on relations. Lightweight; uses user's Linear MCP.
tools: Read, Edit
subagent: linear-syncer
mcp: linear
---

# /push-to-linear

Delegate to the `linear-syncer` subagent.

## Preconditions

- `plans/phases.yaml` exists
- Linear MCP configured globally OR user opts for no-MCP fallback

## Step 0: Preflight — verify Linear MCP

Before delegating, check whether Linear MCP tools are available in this session.

If missing, surface to the user with both paths:

```
Linear MCP not detected. Options:
  A) Set up Linear MCP now:
       claude mcp add linear --transport http https://mcp.linear.app/mcp
     Then authenticate via the OAuth prompt and restart Claude Code.
  B) Continue without MCP — I'll print phases.yaml in Linear-import format
     for manual paste into Linear → Import.
```

If user picks B, jump to "If no Linear MCP" below. Otherwise wait for restart and re-run.

## If Linear MCP available

linear-syncer subagent uses MCP directly:
1. Create Linear project (or find existing if `linear_project_id` set)
2. For each phase: create a Linear Cycle
3. For each task: create issue with priority, estimate, parent (if any), and "blocked by" relations
4. Link Linear project to GitHub repo (enables native sync)
5. Update phases.yaml with `linear_project_id`, `linear_team_id`, and `linear_id` per task

## If no Linear MCP

Print phases.yaml in Linear-import-friendly format. Tell user:
- Open Linear → Import
- Paste the structured tasks
- Link the project to the GitHub repo manually in Linear settings

## Linear ↔ GitHub sync

Once linked:
- Branch `feat/{LINEAR-ID}-slug` auto-links to issue
- PR opened with `[LINEAR-ID]` in title → issue moves to "In Review"
- PR merged → issue moves to "Done"

## Output

Linear project URL. Confirmation that GH sync is active. Updated phases.yaml committed.
