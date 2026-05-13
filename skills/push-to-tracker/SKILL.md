---
name: push-to-tracker
description: Push phases.yaml to the configured tracker (linear|github|notion) — creates project, per-phase grouping, issues with depends_on relations.
tools: Read, Edit, Bash(gh*)
subagent: tracker-syncer
---

# /push-to-tracker

Delegate to the `tracker-syncer` subagent. Tracker-agnostic; dispatches per `.forge/settings.yaml`'s `tracker.type`.

## Preconditions

- `plans/phases.yaml` exists
- `.forge/settings.yaml` exists and has a `tracker:` block (validated by `src/schemas/settings.ts::TrackerConfigSchema` — discriminated union on `type`, one of `linear|github|notion`)
- Per-tracker tooling reachable (Linear MCP / `gh` CLI / Notion MCP)

## Step 0 — Resolve tracker

Read `.forge/settings.yaml` and extract:

- `tracker.type` ∈ {`linear`, `github`, `notion`}
- `tracker.config` (per-type shape: Linear → `team_id`; GitHub → `repo`; Notion → `database_id`)

If `.forge/settings.yaml` is missing or `tracker:` is absent, abort:

```
No tracker configured. Run `forge init` first, or add a `tracker:` block to .forge/settings.yaml.
```

If `tracker.type` is unknown, surface the zod schema error verbatim (one of `linear|github|notion`).

## Step 1 — Preflight per tracker

| `tracker.type` | Probe | If missing |
|---|---|---|
| `linear` | Linear MCP available | Offer `claude mcp add linear --transport http https://mcp.linear.app/mcp` + OAuth + restart, OR the no-MCP fallback (print Linear-import manifest). |
| `github` | `gh auth status` exits 0 | Instruct `gh auth login`. |
| `notion` | Notion MCP available | Offer install + no-MCP fallback (print Notion-importable manifest). Until NotionTracker code lands (FORGE-17), MCP is the only path. |

## Step 2 — Delegate to `tracker-syncer`

Pass `tracker.type`, `tracker.config`, and `plans/phases.yaml` path. The agent dispatches to the right `Tracker` adapter (see `agents/tracker-syncer.md`). Concrete flow:

1. `createProject(phases.project.name, phases.project.description)` — Linear Project / GitHub Milestone / Notion Database row.
2. For each phase (in order), for each task: `createIssue({ title, body, forgeTaskId, ownerType, acceptance, dependsOn: [] })`. Stage the returned `issue.id` against the task in memory.
3. Second pass — for every task with `depends_on`, call `setBlockedBy(task._issueId, blocker._issueId)` once per blocker. Two passes because adapters need both issues to exist before relating them.

The agent classifies adapter errors via `src/trackers/errors.ts` codes and retries `TRANSPORT`/`TIMEOUT`/`RATE_LIMITED` per `BaseTracker.withRetry`.

## Step 3 — Persist IDs back to phases.yaml

Canonical (tracker-agnostic) keys:

- top level: `tracker_project_id`, `tracker_url`
- per task: `tracker_issue_id`

**Backwards compatibility (v0.3.x):** when `tracker.type === 'linear'`, also dual-write the legacy keys with the same values:

- top level: `linear_project_id` (= `tracker_project_id`), `linear_team_id` (from config)
- per task: `linear_id` (= `tracker_issue_id`)

Other adapters (GitHub / Notion) write only the canonical keys. The legacy aliases are removed in v0.4.0 alongside the deprecation alias for the old skill name. `forge migrate` (FORGE-25) rewrites stored references for existing projects.

## Step 4 — Per-tracker post-step

- `linear` → link Linear project to GitHub repo (existing manual-instructions step; Linear's GraphQL doesn't expose the integration setup, so we print the four-step UI walkthrough).
- `github` → no-op (issues live in the same GitHub repo).
- `notion` → no-op for v0.3.0; deferred to FORGE-17.

## Output

Print:

- Project URL
- Issue count
- Mode (MCP vs offline)
- "Updated phases.yaml committed."

## Edge cases

- `phases.yaml` already has `linear_project_id` set and `tracker.type === 'linear'` → update mode; reconcile against the existing Linear project rather than creating a new one.
- `phases.yaml` has `linear_project_id` set but `tracker.type !== 'linear'` → ignore the field, warn once: "phases.yaml has Linear-specific IDs but tracker is `${type}`; ignoring." Do not auto-strip — let `forge migrate` do that.
- A `depends_on` references a task that wasn't created (filtered out, typo) → adapter throws `VALIDATION`; surface the offending task IDs and abort the second pass.
