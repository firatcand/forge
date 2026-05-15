# NotionTracker

forge's third tracker adapter. Treats a Notion database as the issue store, the
same way `GitHubTracker` treats a GitHub repo.

> **MCP server**: targets the official [`@notionhq/notion-mcp-server`][nmcp]
> (npm) — the one whose tools are named `API-*` and which speaks Notion's
> 2025-09-03 API. **Not** compatible with Claude AI's hosted Notion connector
> (which uses `notion-*` tool names). forge spawns its own stdio connection;
> see [Settings](#settings) below.
>
> [nmcp]: https://www.npmjs.com/package/@notionhq/notion-mcp-server

## How it differs from the other adapters

| | LinearTracker | GitHubTracker | NotionTracker |
|---|---|---|---|
| Transport | Linear MCP (planned) | `gh` CLI via `execa` | Notion MCP via `@modelcontextprotocol/sdk` (stdio) |
| Auth | MCP server config | `gh auth login` | Env var (e.g. `NOTION_TOKEN`) inherited from process.env |
| Atomic claim | Optimistic concurrency (Linear revisions) | Label add + tiebreak | `forge_claimed_by` rich_text + read-write-reread tiebreak |
| Secrets manager | Not used | Not used | **Not used** — auth goes through MCP server env, not forge's secrets manager |

NotionTracker spawns its own connection to the Notion MCP server — it does
**not** piggyback on the host CLI's (Claude/Codex/Cursor/Gemini) MCP connection.
Same server binary, same auth; separate stdio pipe.

## Database schema

The tracker expects a Notion database with these properties:

| Property | Type | Purpose |
|---|---|---|
| `Name` | title | Issue title |
| `forge_task_id` | rich_text | Round-trips the `phases.yaml` task ID (e.g. `P2-T04`) |
| `forge_claimed_by` | rich_text | Agent ID; empty string = unclaimed. Load-bearing for claim atomicity. |
| `state` | status | Issue lifecycle — see options below |
| `forge_blocked_by` | rich_text | Comma-separated list of blocker page IDs |
| `forge_owner_type` | rich_text | Carries `CreateIssuePayload.ownerType` |
| `forge_acceptance` | rich_text | Newline-joined acceptance bullets |

The `state` status property must have options:

- `Todo` (gray)
- `In Progress` (blue)
- `In Review` (purple)
- `Done` (green)
- `Cancelled` (default)
- `Blocked` (red)

These names are exact-match — change them in `src/trackers/notion.ts` if you
need different ones, but keep the mapping in sync.

`createProject(name)` will create a data source with this schema under the
page referenced by `FORGE_NOTION_PARENT_PAGE_ID`.

### Data sources vs databases (Notion 2025-09 schema)

Notion's recent API splits databases into two concepts:

- **Database** — the container you see in the UI (`database_id`, what you put
  in `settings.yaml`).
- **Data source** — the schema and pages inside the database. A simple
  database has exactly one data source.

forge stores `database_id` in settings (the familiar shareable id) but
resolves the underlying `data_source_id` lazily on first list/create call.
If your database has multiple data sources, forge picks the first and warns;
configure narrower databases for predictable behavior.

## Settings

```yaml
# .forge/settings.yaml
tracker:
  type: notion
  config:
    database_id: 11112222-3333-4444-5555-666677778888
    # Optional — defaults shown
    mcp_command:
      - npx
      - -y
      - "@notionhq/notion-mcp-server"
    mcp_env: {}  # merged on top of process.env when spawning
```

## Required env

- `NOTION_TOKEN` — your Notion integration token. Exported in the user's shell
  or `.env.local`; **not** read through forge's secrets manager. The spawned MCP
  server inherits `process.env` so anything the server expects (e.g. some
  installations use `NOTION_API_KEY`) goes here.

## Claim concurrency model

Notion has no true CAS. The adapter uses a read–write–settle–reread tiebreak:

1. Fetch page; read `forge_claimed_by` and `last_edited_time` T1.
2. If `forge_claimed_by` is non-empty and not us → `{ ok: false, reason: 'already_claimed' }`.
3. Write `forge_claimed_by = runId`.
4. Sleep `CLAIM_SETTLE_MS` (default 250 ms) to let near-simultaneous competing writes land.
5. Re-fetch; read `forge_claimed_by` again.
   - If it equals our run ID → `{ ok: true }`.
   - If it equals someone else's ID → race lost: `{ ok: false, reason: 'version_conflict', detail: 'lost-tiebreak-to:<other>' }`.
   - If empty → write didn't stick: `{ ok: false, reason: 'version_conflict', detail: 'write-not-visible' }`.
6. Transport errors map to `{ ok: false, reason: 'transient_error' }`.
7. Recheck failures: tryClearClaimIfOwned (read field; only clear if still ours) — never clears a competitor's claim.

This mirrors `GitHubTracker.claim`'s label-add + recheck pattern, plus a settle delay
because Notion (unlike GitHub labels) overwrites the entire field on each write.

### ⚠️ Residual race window

The settle delay catches concurrent writes within a `CLAIM_SETTLE_MS` window
(default 250 ms), but **does not eliminate** the race entirely. If two
orchestrators on the same Notion database tick more than 250 ms apart, both
may complete their write+recheck before observing each other and both believe
they won. The result: the orchestrator dispatches **two workers on the same
issue**.

**Mitigations and recommendations:**

- **Single orchestrator per Notion DB** (recommended). The single-process
  orchestrator serializes its own claim calls, so this race cannot fire from
  within one forge process.
- **GitHub or Linear** for multi-orchestrator setups. GitHub's per-agent
  `claimed:agent-<id>` labels are race-safe (each agent has its own field).
  Linear's revisions give true optimistic concurrency.
- **Raising `CLAIM_SETTLE_MS`** widens the window at the cost of slower
  claims. Not configurable today; file an issue if you need it tunable.

This is a fundamental limitation of using a single overwritable field as a
mutex. The alternative — a per-agent column for each potential agent —
doesn't fit Notion's schema model.

## Error classification

| Notion error code | TrackerErrorCode | Notes |
|---|---|---|
| `unauthorized`, `restricted_resource` | `AUTH` | Always wins over `NOT_FOUND` (Notion sometimes returns "not found" for permission denial) |
| `object_not_found` | `NOT_FOUND` | |
| `rate_limited` | `RATE_LIMITED` | `retry_after` (seconds) preserved in details as `retryAfterMs` |
| `validation_error`, `invalid_request_url`, `invalid_json`, `invalid_request` | `VALIDATION` | Always wins over `CONFLICT` (validation errors can mention conflicts) |
| `conflict_error`, `concurrent_edit` | `CONFLICT` | |
| JSON-RPC `-32000` (ConnectionClosed) | `TRANSPORT` | SDK-level |
| JSON-RPC `-32001` (RequestTimeout) | `TIMEOUT` | SDK-level |
| JSON-RPC `-32700/-32600/-32602` | `VALIDATION` | SDK-level |
| Other | `UNKNOWN` | |

Retriable codes (`TRANSPORT`, `TIMEOUT`, `RATE_LIMITED`) drive exponential
backoff via `BaseTracker.withRetry`.

## Testing

- Unit tests (always run): `test/unit/trackers/notion.test.ts` (~50 tests, mocked `McpCall`)
- Integration tests (opt-in): `test/integration/trackers/notion.test.ts` — see `test/integration/README.md`

Per the `gh-cli-flag-spelling-vs-api-enum` learning, mocks verify call shape
only. Run the integration test locally before merging any change to
`src/trackers/notion.ts`.
