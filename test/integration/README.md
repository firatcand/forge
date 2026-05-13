# Integration tests

Real-API tests that hit live providers. **Skipped by default in CI** — gated behind environment variables.

## GitHub adapter (`trackers/github.test.ts`)

Tests the full GitHubTracker lifecycle against a real repo via the `gh` CLI.

### Prerequisites

1. `gh` CLI installed (`brew install gh`) and authenticated:
   ```bash
   gh auth status
   ```
2. A **throwaway fixture repo** — tests create and delete issues, so do not point at anything important.
   ```bash
   gh repo create firatcand/forge-test-fixtures --public --description "Fixture for forge GitHubTracker e2e"
   ```
3. The auth token must have `repo` scope on the fixture repo (issue create/delete, label create, milestone create).

### Run

```bash
FORGE_E2E_GITHUB=1 FORGE_E2E_REPO=firatcand/forge-test-fixtures npm test
```

Without `FORGE_E2E_GITHUB=1` the integration tests are skipped, and `npm test` only runs unit tests (default CI behavior).

### What's tested

| Test | What it verifies |
|---|---|
| `full lifecycle` | `createProject` → `createIssue` (with `forgeTaskId` footer) → `listActiveIssues` (round-trips footer) → `claim` → `updateState('in_progress')` → `updateState('in_review')` → `comment` → `releaseClaim` → `updateState('done')` (issue closed) |
| `concurrent claim` | Two parallel `claim` calls on the same fresh issue produce exactly one winner; the other returns `{ ok: false }` |
| `setBlockedBy round-trip` | `setBlockedBy(B, A)` → `listActiveIssues` → reloaded issue B has `blockerIds: [A.id]` (via body footer) |

Each test cleans up its fixture issues via `gh api repos/{repo}/issues/{n} --method DELETE` in `finally`.

### Cost / runtime

- ~10 GitHub API calls per run.
- Typical wall time: **<30 seconds** on a healthy connection.
- Issues and milestones are deleted in `finally` blocks; on test crash you may need to clean up manually:
  ```bash
  gh issue list --repo firatcand/forge-test-fixtures --search "[e2e]" --json number --jq '.[].number' \
    | xargs -I{} gh api repos/firatcand/forge-test-fixtures/issues/{} --method DELETE
  ```

### Limitations

- The negative `healthCheck` case (expired auth) is **not** tested automatically — it would require corrupting the user's `gh` auth state. Verified manually instead.
- Tests assume the fixture repo allows label creation; first run will create `claimed:agent-*` and `state:*` labels permanently.

## Notion adapter (`trackers/notion.test.ts`)

Tests the full NotionTracker lifecycle against a real Notion database via the official Notion MCP server (`@notionhq/notion-mcp-server`).

### Prerequisites

1. A throwaway Notion database with the schema documented in [docs/adapters/notion.md](../../docs/adapters/notion.md). Forge expects these columns:
   - `Name` (title)
   - `forge_task_id`, `forge_claimed_by`, `forge_blocked_by`, `forge_owner_type`, `forge_acceptance` (rich text)
   - `state` (status) with options `Todo`, `In Progress`, `In Review`, `Done`, `Cancelled`, `Blocked`
2. `NOTION_TOKEN` exported so the spawned MCP server can authenticate. forge inherits `process.env` when spawning the server.
3. The Notion integration tied to the token must have edit access to the test database.

### Run

```bash
FORGE_E2E_NOTION=1 \
  FORGE_E2E_NOTION_DATABASE_ID=11112222-3333-4444-5555-666677778888 \
  NOTION_TOKEN=secret_xxx \
  npm test
```

Without `FORGE_E2E_NOTION=1` the integration tests are skipped.

### What's tested

| Test | What it verifies |
|---|---|
| `full lifecycle` | `createIssue` (round-trips `forge_task_id`) → `claim` → `updateState('in_progress')` → `comment` → `releaseClaim` → `updateState('done')` → `listActiveIssues` (done page filtered out) |

Each test archives its fixture page via `notion-update-page { archived: true }` in `finally`.

### Cost / runtime

- ~8 MCP tool calls per run.
- Typical wall time: **~10 seconds** plus first-run `npx` install of `@notionhq/notion-mcp-server`.

### Limitations

- `createProject` (notion-create-database) is **not** exercised in the integration test because it leaves a permanent database behind on each run and requires `FORGE_NOTION_PARENT_PAGE_ID`. Unit-tested instead.
- The race-tiebreak claim path is not reproducible against live Notion (needs two concurrent processes); unit-tested with the `state_changed` recheck path only.
