# Trackers

Forge supports three trackers as the durable task system, chosen per project in `.forge/settings.yaml` `tracker.type`. The canonical skill `/push-to-tracker` reads that field and dispatches to the right adapter — see [`skills/push-to-tracker/SKILL.md`](../../skills/push-to-tracker/SKILL.md).

## Supported trackers

| Tracker | `tracker.type` | Adapter | Status |
|---|---|---|---|
| [Linear](./linear.md) | `linear` | `LinearTracker` via `@linear/sdk` (`src/trackers/linear.ts`, shipped in FORGE-16) | Code adapter live; full deep-dive in [`docs/adapters/linear.md`](../adapters/linear.md) |
| [GitHub](./github.md) | `github` | `GitHubTracker` via `gh` CLI (`src/trackers/github.ts`, shipped in FORGE-15) | Code adapter live; full deep-dive in [`docs/adapters/github.md`](../adapters/github.md) |
| [Notion](./notion.md) | `notion` | `NotionTracker` via the official `ntn` CLI (`src/trackers/notion.ts`; MCP transport replaced in FORGE-117) | Code adapter live; see [`docs/adapters/notion.md`](../adapters/notion.md) |

All three speak the same `Tracker` interface (`src/trackers/base.ts`) — `createProject`, `createIssue`, `setBlockedBy`, `listActiveIssues`, `getCurrentRevision`, `claim`, `releaseClaim`, `updateState`, `comment`, `healthCheck`.

## Schema

Tracker config is a discriminated union on `type` (see `src/schemas/settings.ts`):

```yaml
tracker:
  type: linear            # or 'github' or 'notion'
  config:
    team_id: TEAM-123     # linear only
    # repo: owner/name    # github only
    # database_id: ...    # notion only
```

## Choosing a tracker

- **Linear** — best when team uses Linear already and benefits from native cycles + GitHub PR integration.
- **GitHub** — best when team lives in GitHub Issues and wants no external tooling. Maps Project → Milestone, depends_on → body footers.
- **Notion** — best when team uses Notion as their PM hub. Mapped via a tasks database with a relation property for `depends_on`.

## Migrating between trackers

`forge migrate` (FORGE-25) handles cross-tracker migration of stored IDs. Until then, manually clear the tracker-specific keys in `phases.yaml` and re-run `/push-to-tracker` against the new tracker.
