# Notion tracker

`tracker.type: notion` — tasks live in a Notion database row.

## Status

`NotionTracker` shipped in FORGE-17 (`src/trackers/notion.ts`). It speaks the standard `Tracker` interface (`src/trackers/base.ts`) and is invoked both by the orchestrator runtime and by `/push-to-tracker` (Notion backend path) inside the `tracker-syncer` agent.

## How it works

- Adapter: `NotionTracker` — implements the `Tracker` interface.
- Transport: Notion's official [MCP server](https://github.com/makenotion/notion-mcp-server), spawned via the stdio transport in `src/trackers/notion-mcp-transport.ts`.
- Project → top-level Notion database (created via `notion-create-database`).
- Issue → row in the tasks database.
- `depends_on` → `forge_blocked_by` rich-text footer on each row (Notion's native relation property is supported as overlay metadata).

## Config

```yaml
tracker:
  type: notion
  config:
    database_id: <notion-database-id>
```

See [`docs/adapters/notion.md`](../adapters/notion.md) for the full schema, env vars, and ops playbook.
