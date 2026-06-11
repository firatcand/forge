# NotionTracker

forge's third tracker adapter. Treats a Notion database as the issue store, the
same way `GitHubTracker` treats a GitHub repo.

> **Transport (FORGE-117)**: the adapter shells out to the official
> [Notion CLI (`ntn`)][ntn] — exactly like `GitHubTracker` shells out to `gh`.
> The previous MCP-server transport (`@notionhq/notion-mcp-server` over
> `@modelcontextprotocol/sdk` stdio) was **removed**; the
> `@modelcontextprotocol/sdk` dependency is gone from forge entirely. Every
> `ntn api` call is pinned to Notion API version `2026-03-11`
> (`NOTION_API_VERSION` in `src/trackers/notion.ts`).
>
> [ntn]: https://developers.notion.com/cli

## Install & auth

1. Install the [Notion CLI][ntn] so `ntn` resolves on `PATH` (the `forge init`
   tooling probe runs `ntn api v1/users/me` — verifying install AND keychain auth in one call).
2. Authenticate once with `ntn login` — credentials are stored in your
   keychain. There is **no token plumbing through forge**: no `NOTION_TOKEN`
   env var, nothing routed through forge's secrets manager.

## How it differs from the other adapters

| | LinearTracker | GitHubTracker | NotionTracker |
|---|---|---|---|
| Transport | `@linear/sdk` (GraphQL) | `gh` CLI via `execa` | `ntn` CLI via `execa` |
| Auth | `LINEAR_API_KEY` env var | `gh auth login` | `ntn login` (keychain) |
| Atomic claim | Weak label-CAS: `forge:claimed-by:*` add + verify-on-readback + tiebreak | Weak label-CAS: `forge:claimed-by:*` add + verify-on-readback + tiebreak | `forge_claimed_by` rich_text + read-write-reread tiebreak |
| Secrets manager | Not used | Not used | Not used |

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

Notion's API splits databases into two concepts:

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
```

That's it — `database_id` is the entire Notion config. The `ntn` binary is
assumed on `PATH` exactly like `gh` is for the GitHub tracker.

### Deprecated fields (removed in v0.5)

`mcp_command` and `mcp_env` configured the removed MCP-server transport. They
are still **accepted by the schema but ignored** so existing `settings.yaml`
files keep parsing; the tracker factory prints a one-line deprecation warning
when they are present. Remove them — the fields will be rejected in v0.5.

## `updateIssueBody` — implemented (FORGE-117)

Replaces the page's content blocks wholesale. Notes:

- forge metadata (`forge_task_id`, `forge_blocked_by`, `forge_owner_type`)
  lives in **page properties** on Notion, not body footers — a body replace
  never touches it. (`/reconcile --push` and `/apply-decision` no longer skip
  Notion-backed projects.)
- **Non-atomic replace semantics.** Notion has no atomic body replace
  (`PATCH /v1/blocks/{id}/children` appends), so the adapter runs
  list-children → delete-each-child → append-replacement. A crash mid-way
  leaves a partial body, but the operation is **idempotently re-runnable**: a
  re-run deletes whatever children remain and appends the full replacement.
  The interface contract already assumes the caller holds the claim
  (single-writer, no CAS).
- Input validation matches GitHub/Linear: non-string input, embedded
  `<!-- forge:* -->` footers, and bodies over 64 KiB (`NOTION_BODY_MAX_BYTES`)
  are rejected with `VALIDATION`; pages without a `forge_task_id` property
  (created outside forge) fail with `PRECONDITION_FAILED`.
- Body text is chunked into paragraph blocks: ≤2000 chars per rich_text item,
  ≤100 items per block (Notion limits).

`setClaimFence` remains a `NOT_IMPLEMENTED` stub — on Notion the claim fence
cannot ride the body (metadata is page properties), and a
ClaimFenceData-shaped property scheme is the FORGE-145/FORGE-167 follow-up.
Claim/cancel call it best-effort and just skip fence mirroring for Notion.

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
- **GitHub or Linear** for multi-orchestrator setups. Both use per-agent
  `forge:claimed-by:<runId>` labels with verify-on-readback + lexicographic
  tiebreak (each agent gets its own label name; race losers self-clean).
  Neither has native CAS — Linear's API does not expose `expectedVersion`
  on `IssueUpdate` (verified against `@linear/sdk@84.0.0`).
- **Raising `CLAIM_SETTLE_MS`** widens the window at the cost of slower
  claims. Not configurable today; file an issue if you need it tunable.

This is a fundamental limitation of using a single overwritable field as a
mutex. The alternative — a per-agent column for each potential agent —
doesn't fit Notion's schema model.

## Error classification

`classifyNotionExecError` handles both thrown spawn errors and returned
nonzero-exit results (the Notion error body is parsed off stdout, stderr as a
fallback):

| Signal | TrackerErrorCode | Notes |
|---|---|---|
| spawn `ENOENT` (`ntn` not installed) | `TRANSPORT` | Install hint: Notion CLI + `ntn login` |
| `unauthorized`, `restricted_resource` | `AUTH` | Always wins over `NOT_FOUND` (Notion sometimes returns "not found" for permission denial) |
| `object_not_found` | `NOT_FOUND` | |
| `rate_limited` | `RATE_LIMITED` | `retry_after` (seconds) preserved in details as `retryAfterMs` |
| `validation_error`, `invalid_request`, `invalid_json`, `invalid_request_url` | `VALIDATION` | Always wins over `CONFLICT` (validation errors can mention conflicts) |
| `conflict_error`, `concurrent_edit` | `CONFLICT` | |
| `internal_server_error`, `service_unavailable`, `bad_gateway` | `TRANSPORT` | 5xx-class — retriable |
| timeouts (`timedOut`, `ETIMEDOUT`, "timed out" patterns) | `TIMEOUT` | |
| connection failures (`ECONNRESET`, "connection refused", spawn errors) | `TRANSPORT` | |
| unknown nonzero exit | `UNKNOWN` | Deliberately NOT retriable |

Retriable codes (`TRANSPORT`, `TIMEOUT`, `RATE_LIMITED`) drive exponential
backoff via `BaseTracker.withRetry`.

## Testing

- Unit tests (always run): `test/unit/trackers/notion.test.ts` (mocked `NtnExec`)
- Integration tests (opt-in): `test/integration/trackers/notion.test.ts` — see `test/integration/README.md`

Per the `gh-cli-flag-spelling-vs-api-enum` learning, mocks verify call shape
only. Run the integration test locally before merging any change to
`src/trackers/notion.ts`.

## Claim label length (no-transform note)

NotionTracker stores the claim `runId` as a rich_text property _value_ (not a Notion property _name_). The property name is the fixed string `forge_claimed_by` (16 chars). Notion's 100-char property name limit and its rich_text value limits are both far above the 53-char `forge:claimed-by:<UUIDv7>` string. No UUID transform is applied here. GitHub requires a dehyphenation transform to fit under its 50-char label-name cap; see `docs/adapters/github.md` for details.
