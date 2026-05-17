# Linear Integration

> This file is the Linear-specific adapter doc. The canonical skill is [`/push-to-tracker`](../../skills/push-to-tracker/SKILL.md); this page covers Linear-specific setup and behavior. For other trackers see [`docs/trackers/README.md`](./README.md).

Forge can use Linear as the durable task system. Local `phases.yaml` is the source of truth at decomposition time; once `/push-to-tracker` runs against a Linear-configured project, Linear becomes the operational system of record. The `/sync-status` skill exists to reconcile drift if it happens.

This doc covers MCP setup, GitHub-Linear native sync, branch naming conventions, the issue lifecycle, and the most common errors.

---

## MCP setup (one-time)

Linear MCP runs as a local server that Claude Code talks to. Install via Linear's official package:

```bash
claude mcp add linear --command "npx -y @linear/mcp-server"
```

When prompted on first use, paste a Linear API token (Linear → Settings → API → Personal API tokens). Scope: read/write to your team.

Verify:

```bash
claude mcp list
# Should show: linear (running)
```

The `tracker-syncer` subagent calls Linear MCP tools directly when `tracker.type === 'linear'`. If MCP isn't registered, `/push-to-tracker` falls back to printing an importable manifest and instructing manual import.

### Sample claude.json snippet

If you prefer manual config (`~/Library/Application Support/Claude/claude.json` on macOS, `~/.config/Claude/claude.json` on Linux):

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"],
      "env": {
        "LINEAR_API_KEY": "lin_api_xxxxxxxxxxxx"
      }
    }
  }
}
```

---

## GitHub ↔ Linear native sync

After `/push-to-tracker` (with `tracker.type === 'linear'`), the `tracker-syncer` subagent runs the link step. It prints manual instructions because Linear's GraphQL API for setting up the GitHub integration is limited:

1. Linear → Settings → Integrations → GitHub
2. Connect the repo (`firatcand/your-project`)
3. Map the repo to the project just created
4. Enable: branch-name auto-link, PR-status sync

Once linked, the following automations run without you doing anything:

- A branch named `feat/{LINEAR-ID}-slug` (e.g. `feat/TLOG-103-tab-completion`) auto-attaches to issue `TLOG-103`.
- A PR with `[TLOG-103]` in the title moves the issue to **In Review**.
- Merging that PR moves the issue to **Done**.
- Re-opening the PR moves it back to **In Progress**.

### Branch naming convention

Strict format. Forge enforces this through `/pickup-task`:

```
feat/TLOG-103-tab-completion
^^^^ ^^^^^^^^ ^^^^^^^^^^^^^^
type ID       kebab-case title
```

Types accepted: `feat`, `fix`, `chore`, `docs`. Use `fix/` for bug-fix branches and `chore/` for maintenance work.

If you create a branch outside `/pickup-task`, follow the same format. Linear's matcher is permissive (any branch containing the issue ID will attach), but the convention keeps `git branch` output legible.

### PR title convention

```
[TLOG-103] Add tab completion for project names
```

The bracket-prefixed ID is what Linear matches. The title after the bracket should be human-readable.

---

## Issue lifecycle

```
Backlog ──→ Todo ──→ In Progress ──→ In Review ──→ Done
   ▲          ▲           ▲              │            │
   │          │           │              │            │
   │          │           │              ▼            ▼
   │          │           │          (Cancelled)  (Cancelled)
   │          │           │
   │          │           └─ /pickup-task moves Todo → In Progress
   │          │
   │          └─ /phase-gate moves Backlog → Todo when previous phase closes
   │
   └─ /push-to-tracker creates issues in Backlog (or current cycle's Todo if phase-1)
```

| State | What moves it | What forge skill cares |
|-------|--------------|------------------------|
| Backlog | `/push-to-tracker` creates here for phase 2/3 tasks | `/pickup-task` ignores |
| Todo | `/phase-gate` moves to Todo when phase activates | `/pickup-task` claims from here |
| In Progress | `/pickup-task` | active work |
| In Review | PR opened with `[ID]` in title (native sync) | `/ship` triggers this |
| Done | PR merged (native sync) | end of task |
| Cancelled | manual | `/sync-status` will detect |

---

## phases.yaml ↔ Linear mapping

| `phases.yaml` concept | Linear concept |
|----------------------|---------------|
| `project` (top-level field) | Linear Project |
| `phase` | Linear Cycle |
| `task` | Linear Issue |
| `task.depends_on` | Linear `blocks` relation (inverted: A depends on B means B blocks A) |
| `task.priority` (P0/P1/P2) | Linear priority (1/2/3) |
| `task.estimate` (S/M/L) | Linear estimate (1/3/5 points) |
| `task.type`, `task.owner_type` | Linear labels |

After `/push-to-tracker` succeeds, `phases.yaml` gains:

- top-level `tracker_url`
- `source` block (`tracker`, `project_id`, `synced_at`, `spec_revision`) — kept fresh by `/reconcile --pull`
- per-phase `tracker_milestone_id`
- per-task `tracker_issue_id`

The Linear `team_id` lives in `.forge/settings.yaml` under `tracker.config.team_id` — not duplicated into `phases.yaml`. These IDs let `/sync-status` and `/pickup-task` query the right resources.

---

## Drift handling — when to run `/sync-status`

You normally don't need to. Linear ↔ GitHub native sync handles every transition that goes through a PR.

Run `/sync-status` when:

- A teammate closed an issue manually in Linear (no PR involved)
- An issue was reassigned to a different project or cycle
- You manually edited `phases.yaml` after `/push-to-tracker` and want Linear to reflect the changes (this is the wrong direction — `/push-to-tracker` should be re-run instead)

`/sync-status` only updates **local** `phases.yaml`. It does not push back to Linear. If you want the local state to be authoritative, edit `phases.yaml` and re-run `/push-to-tracker` with the `--update` flag (in v1.1).

---

## Common errors

### "Linear MCP server not registered"

`claude mcp list` doesn't show `linear`. Run:

```bash
claude mcp add linear --command "npx -y @linear/mcp-server"
```

### "Linear team has multiple workspaces — pick one"

The `tracker-syncer` Confusion Protocol fired because your Linear account has multiple teams. Pick explicitly in `.forge/settings.yaml`:

```yaml
tracker:
  type: linear
  config:
    team_id: "<paste-team-uuid-here>"
```

Then re-run `/push-to-tracker`.

### "issueRelationCreate failed: blocker not found"

A `depends_on` references a task ID that doesn't exist in Linear. Usually because that task was filtered out (priority too low, manual exclusion). Check `phases.yaml` for typos in task IDs, or remove the dependency.

### "Branch attached to wrong issue"

Linear matches branch names by substring. If your branch name contains another issue's ID by coincidence (e.g. `feat/TLOG-1-foo` partially matches `TLOG-100`), you'll get cross-attachment. Use the full ID and dash-separator: `feat/TLOG-100-foo` is unambiguous because Linear matches `TLOG-100` not `TLOG-1`.

### "PR didn't move issue to In Review"

Three usual causes:
1. Title doesn't have `[TLOG-XXX]` in brackets — Linear's matcher needs the bracket form for confidence.
2. PR was opened against a non-default branch and Linear's filter excludes it (check Linear → Settings → Integrations → GitHub → branch filter).
3. The issue's status workflow doesn't include "In Review" — Linear needs that state to exist.

### "GitHub integration not appearing in Linear settings"

Your Linear plan doesn't include GitHub integration (Free plan is limited). Either upgrade to Standard ($8/user/month at the time of writing) or use `/sync-status` periodically as a manual fallback.
