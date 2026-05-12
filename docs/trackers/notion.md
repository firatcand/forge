# Notion tracker

`tracker.type: notion` — tasks live in a Notion database row.

## Status

NotionTracker is **not yet implemented in code** (tracked as FORGE-17). Until that lands, `/push-to-tracker` with `tracker.type: notion` runs through Notion MCP directly inside the `tracker-syncer` agent.

## How it will work

- Adapter: `NotionTracker` (forthcoming, mirroring the `Tracker` interface in `src/trackers/base.ts`).
- Transport: Notion MCP.
- Project → top-level Notion page or database row.
- Issue → row in a tasks database.
- `depends_on` → Notion relation property pointing to other rows in the same database.

## Config

```yaml
tracker:
  type: notion
  config:
    database_id: <notion-database-id>
```

Full deep-dive coming once the adapter ships.
