# Notion tracker

`tracker.type: notion` — tasks live in a Notion database row.

## Status

`NotionTracker` shipped in FORGE-17 (`src/trackers/notion.ts`). It speaks the standard `Tracker` interface (`src/trackers/base.ts`) and is invoked both by the orchestrator runtime and by `/push-to-tracker` (Notion backend path) inside the `tracker-syncer` agent.

## How it works

- Adapter: `NotionTracker` — implements the `Tracker` interface.
- Transport (FORGE-117): the official [Notion CLI (`ntn`)](https://developers.notion.com/cli) via `execa` — mirror of the GitHub adapter's `gh` exec. Auth via `ntn login` (keychain). The previous MCP-server transport was removed.
- Project → top-level Notion database (created via `POST /v1/databases` with parent.page_id + initial_data_source (API 2026-03-11)).
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
