# LinearTracker — Linear adapter

Implements the `Tracker` interface (`src/trackers/base.ts`) against Linear's GraphQL API via the official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk). Used at orchestrator runtime when `tracker.type: linear` in `.forge/settings.yaml`.

> **Not to be confused with**: the user-facing `/push-to-tracker` skill inside Claude Code (Linear backend path). That skill talks to Linear's [MCP server](https://linear.app/docs/mcp). The orchestrator (Node CLI) talks to Linear's GraphQL API directly via the SDK. See [Why SDK vs MCP](#why-sdk-not-mcp).

---

## Setup

### 1. Mint a Personal API Key

1. Open [linear.app/settings/account/security](https://linear.app/settings/account/security)
2. Section **Personal API keys** → **New API key**
3. Name it (e.g. `forge-orchestrator`), copy the key (`lin_api_...`)

### 2. Export the key

Add to your shell profile or `.env.local`:

```bash
export LINEAR_API_KEY=lin_api_xxxxxxxxxxxxx
```

`forge init` validates the env var is set when `tracker.type: linear`. If missing, init shows a non-fatal probe failure with a link back here.

### 3. Configure team

In `.forge/settings.yaml`:

```yaml
tracker:
  type: linear
  config:
    team_id: <your-team-uuid>
```

To find your team UUID: open any issue → URL contains `linear.app/<workspace>/team/<team-key>/...`; use Linear's API or `gh` extension to resolve the UUID, or query `team({key: "ENG"}) { id }` in the Linear API playground.

---

## What the adapter does

| Tracker method | Linear operation |
|---|---|
| `healthCheck()` | `client.viewer` — returns ok if API key authenticates |
| `listActiveIssues()` | `client.issues({ filter: team + state.type IN [triage,backlog,unstarted,started] })` capped at `LINEAR_LIST_LIMIT = 200` |
| `claim(issueId, runId)` | label-based claim `claimed:agent-<runId>` with lexicographic tiebreak on race losers (see [Claim semantics](#claim-semantics)) |
| `releaseClaim(issueId, runId)` | removes ALL `claimed:agent-*` labels from the issue (broad release; mirrors GitHubTracker). v2 stub: `runId` is validated but not yet used to scope removal — targeted-removal lands in FORGE-76. |
| `updateState(issueId, state)` | sets `Issue.state` via workflow state mapping + overlay labels (see [State mapping](#state-mapping)) |
| `comment(issueId, body)` | `client.createComment({ issueId, body })` |
| `createProject(name, description?)` | `client.createProject({ teamIds, name, description })` + precreates overlay labels |
| `createIssue(payload)` | `client.createIssue` with forge:task + forge:ownerType footers in description |
| `setBlockedBy(issueId, blockerId)` | writes `forge:blockedBy=` footer in description AND creates native `IssueRelation(type:'blocks')` for UI visibility |

---

## Claim semantics

LinearTracker claims issues by adding a `claimed:agent-<runId>` label, then re-reads to detect concurrent claims. If multiple run labels are present after the write, the lexicographically-first wins; losers remove their own label and return `{ ok: false, reason: 'version_conflict', detail: 'lost-tiebreak-to:<winner>' }`.

This matches GitHubTracker exactly. **It is not strict optimistic concurrency** — Linear's GraphQL API does not expose `revision` / `expectedRevision` fields publicly (verified against `linear/linear@master/packages/sdk/src/schema.graphql`). The tiebreak gives orchestrator-perspective atomicity: under contention, exactly one run ends up with the claim.

### Precondition: globally unique `runId`

Callers MUST pass a globally-unique `runId` (the v2 orchestrator's run identifier, UUIDv7). Two orchestrators that happen to pick the same `runId` will both think they own the issue — the tiebreak resolves on label name, not on orchestrator identity. This is enforced by the orchestrator's startup code (FORGE-20, in progress), not by this adapter.

---

## State mapping

`forge IssueState` → (Linear `WorkflowState.type`, overlay label):

| Forge state | Workflow type | Overlay label |
|---|---|---|
| `todo` | `unstarted` (fallback: `backlog`, then `triage`) | none |
| `in_progress` | `started` | none (removes `state:in-review`) |
| `in_review` | `started` | `state:in-review` |
| `done` | `completed` | none |
| `cancelled` | `canceled` | none |
| `blocked` | `backlog` (fallback: `unstarted`) | `state:blocked` |

Overlay labels exist because Linear has no native workflow-state type for "in review" or "blocked". The label preserves the semantic, and `deriveStateFromLinearIssue()` reads it back on `listActiveIssues()` so the state round-trips correctly.

### Blocked fallback (graceful degradation)

If your Linear team has no workflow state of type `backlog`, forge falls back to the first `unstarted` (or `triage`) state and adds the `state:blocked` overlay label. The fallback fires once per orchestrator process via `logger.warn('tracker.updateState.fallback', ...)`. This is by design — adopters with minimal workflows don't need to reconfigure Linear to use forge.

If your team has none of `unstarted`, `triage`, OR `backlog`, `updateState('issue', 'blocked')` throws `TrackerError('PRECONDITION_FAILED')`. Configure at least one of those state types in Linear team settings.

---

## Blockers — dual write

`setBlockedBy(issueId, blockerId)` writes blockers in **two places**:

1. **Description footer** (`<!-- forge:blockedBy=<id1>,<id2>,... -->`) — the orchestrator-internal authoritative source. Read in a single SDK call per issue (no N+1).
2. **Native `IssueRelation(type:blocks)`** — Linear creates a real dependency relation so the issue's right-side panel shows "blocked by" arrows in the UI.

The footer is written first; the relation is written second. CONFLICT (relation already exists) is swallowed silently — idempotent. Other relation-create failures throw; on retry, the dedup check on the footer means only the missing native relation is re-attempted.

If you delete a forge-managed issue's description and lose the footer, forge can no longer detect existing blockers via `parseForgeFooters`. The native Linear relation persists. **Don't manually edit forge-managed issue descriptions.**

---

## Why SDK, not MCP

A common question: forge ships with `/push-to-tracker` (a Claude Code skill whose Linear backend path calls Linear's MCP server). Why doesn't the orchestrator use the same MCP server?

Answer: **MCP is a protocol designed for LLMs to invoke tools**. The orchestrator is not an LLM — it's a Node CLI dispatcher. Specifically:

- Linear's MCP server (`https://mcp.linear.app/mcp`) is HTTP+OAuth. Reusing it from a non-LLM Node process would require implementing OAuth device flow (~200-400 LOC), token cache management, and an MCP-protocol client layer — roughly 3-5× the code of the SDK path.
- The MCP server returns JSON in a tool-result envelope; the SDK returns typed objects (`Issue`, `WorkflowState`, etc.). We'd lose the type safety the SDK gives us for free.
- Mocking the SDK is one fixture file (`LinearSdkLike` seam). Mocking an MCP host is a stub MCP server.
- The MCP server under the hood is just calling Linear's GraphQL API. We'd be using LLM-shaped middleware to do the work the SDK does directly.

The cost is one env var (`LINEAR_API_KEY`) vs SPEC.md's original "no extra secret" promise. SPEC.md will be amended post-ship to match shipped reality.

---

## Auth failure runbook

### `healthCheck` returns `{ ok: false, detail: 'LINEAR_API_KEY not set...' }`

The env var isn't exported in the process running `forge orchestrate`. Re-export it in the same shell (or your service manager's env config) and retry.

### `healthCheck` returns `{ ok: false, detail: 'Invalid API key' }` (or AUTH classified error)

The key is wrong, revoked, or for the wrong workspace.

1. Test the key out of band:
   ```bash
   curl -H "Authorization: $LINEAR_API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"query":"query{viewer{id email}}"}' \
        https://api.linear.app/graphql
   ```
2. If that fails too: mint a new key at [linear.app/settings/account/security](https://linear.app/settings/account/security) and re-export it.
3. If only forge fails but curl works: check for extra whitespace, surrounding quotes, or `\n` in the env var.

### `RATE_LIMITED` errors during `orchestrate`

Linear enforces per-key API quotas. The adapter respects `Retry-After` headers and retries via `BaseTracker.withRetry` with exponential backoff. If you hit rate limits frequently:

- Lower `agents.poll_interval_ms` cautiously (raises quota burn)
- Mint a separate API key for the orchestrator vs interactive use
- Contact Linear support for quota increase if running at scale

---

## Limitations and known gotchas

- **Custom workflow state names**: forge maps by `WorkflowState.type`, not name. If your team uses `started`-typed states with names like "Active" or "WIP", forge treats them as `in_progress` regardless. This is correct behavior.
- **Issue archival**: archived issues don't appear in `listActiveIssues` (filtered out by `state.type IN [...]`). Forge has no API to un-archive.
- **Description size**: Linear caps descriptions at 65535 chars. forge does not silently truncate; `VALIDATION` errors from `createIssue` / `updateIssue` propagate.
- **Pre-existing labels named `claimed:agent-*` from non-forge tooling**: forge treats them as valid claims. Don't namespace-collide.

---

## Related

- Tracker interface: `src/trackers/base.ts`
- Adapter source: `src/trackers/linear.ts`
- Unit tests: `test/unit/trackers/linear.test.ts`
- Conformance suite: `test/fixtures/trackers/conformance.ts`
- Integration test (gated): `test/integration/trackers/linear.test.ts` — requires `FORGE_E2E_LINEAR=1`, `FORGE_E2E_LINEAR_TEAM_ID`, `LINEAR_API_KEY`
- Sibling adapters: `src/trackers/github.ts` (FORGE-15), `src/trackers/notion.ts` (FORGE-17)
