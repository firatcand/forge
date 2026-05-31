# LinearTracker — Linear adapter

Implements the `Tracker` interface (`src/trackers/base.ts`) against Linear's GraphQL API via the official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk). Used at orchestrator runtime when `tracker.type: linear` in `.forge/settings.yaml`.

> **Not to be confused with**: the user-facing `/push-to-tracker` skill inside Claude Code (Linear backend path). That skill talks to Linear's [MCP server](https://linear.app/docs/mcp). The orchestrator (Node CLI) talks to Linear's GraphQL API directly via the SDK. See [Why SDK vs MCP](#why-sdk-not-mcp).

---

## Setup

### 1. Mint a Personal API Key

1. Open [linear.app/settings/account/security](https://linear.app/settings/account/security)
2. Section **Personal API keys** → **New API key**
3. Name it (e.g. `forge-orchestrator`), copy the key (`lin_api_...`)

### 2. Provide the key

Add it to the per-repo `.forge/.env` (git-ignored, scaffolded by `forge init`):

```dotenv
# .forge/.env
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxx
```

forge loads `.forge/.env` at startup and seeds an allowlisted set of tracker keys
(`LINEAR_API_KEY`, `NOTION_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `FORGE_NOTION_PARENT_PAGE_ID`)
into the environment. The Linear key is workspace-scoped, so it belongs per-repo
rather than in a global profile. An already-exported shell var or CI-injected value
always wins over `.forge/.env`, so `export LINEAR_API_KEY=...` still works for one-offs.

`forge init` validates the key is resolvable when `tracker.type: linear`. If missing, init shows a non-fatal probe failure with a link back here.

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
| `claim(issueId, runId)` | weak label-CAS with verify-on-readback: add `forge:claimed-by:<runId>` via `addedLabelIds`, then re-read to detect concurrent claims (see [Claim semantics](#claim-semantics)) |
| `releaseClaim(issueId, runId)` | strict-scope: removes only `forge:claimed-by:<runId>` via `removedLabelIds`. Idempotent — missing label, vanished issue, or stale cached id are all swallowed silently (see [Strict-scope releaseClaim](#strict-scope-releaseclaim)) |
| `updateState(issueId, state)` | sets `Issue.state` via workflow state mapping + overlay labels (see [State mapping](#state-mapping)) |
| `comment(issueId, body)` | `client.createComment({ issueId, body })` |
| `createProject(name, description?)` | `client.createProject({ teamIds, name, description })` + precreates overlay labels |
| `createIssue(payload)` | `client.createIssue` with forge:task + forge:ownerType footers in description |
| `setBlockedBy(issueId, blockerId)` | writes `forge:blockedBy=` footer in description AND creates native `IssueRelation(type:'blocks')` for UI visibility |

---

## Claim semantics

LinearTracker claims issues by attaching the label `forge:claimed-by:<runId>` and then re-reading the label set to detect concurrent claims. This is the weak label-CAS + verify-on-readback contract from `spec/ORCHESTRATOR.md:372`.

### Three-step flow

1. **Read** current labels via `client.issue(issueId)`. If no `forge:claimed-by:*` label is present, proceed; if another agent's label is present, return `{ ok: false, reason: 'already_claimed' }` without writing.
2. **Add** our label via `client.updateIssue(issueId, { addedLabelIds: [labelId] })` (append-only — `addedLabelIds` does NOT clobber user-applied labels, unlike a full `labelIds` replace). The label is created on the team first via `ensureLabel` if it doesn't exist.
3. **Re-read** labels via `client.issue(issueId)`. **Verify our label is present AND no other `forge:claimed-by:*` label is present.** If our label is missing, return `{ ok: false, reason: 'version_conflict', detail: 'claim-label-missing-on-recheck' }`. If multiple `forge:claimed-by:*` labels are present, apply the tiebreak (see below).

### Tiebreak

When the re-read shows multiple claims, we sort all `forge:claimed-by:*` labels using `localeCompare(..., 'en', { sensitivity: 'base' })` and the lexicographically-first label wins. Losers call `updateIssue({ removedLabelIds: [theirLabelId] })` against their own label and return `{ ok: false, reason: 'version_conflict', detail: 'lost-tiebreak-to:<winner>' }`.

The locale-aware sort is load-bearing. Default JavaScript `Array.sort()` uses UTF-16 code units, which puts `'Z' < 'a'`; we don't want runId casing to swing claim outcomes across hosts.

### Race window

There is a residual race between step 2 (write) and step 3 (re-read). The spec calls this "weak-but-honest CAS":

- Linear's GraphQL API does NOT expose `expectedVersion` / `expectedRevision` / `ifMatch` on `IssueUpdateInput`, and `Issue` has no `version` / `revision` / `etag` read field (verified against `@linear/sdk@84.0.0` index typings 2026-05-15). True optimistic concurrency is not available.
- Forge's local lease (single-orchestrator-per-host) prevents same-host concurrent dispatch, so the race is bounded to cross-host orchestrators — a rare configuration in practice.

**Two interleavings to be aware of:**

1. **Simultaneous-visible writes** (good case). Both orchestrators write labels; both rereads see the multi-label state. Both apply the same deterministic locale-aware tiebreak. Loser removes its label and returns `version_conflict`. Final state: one claim label, one winner.

2. **Delayed-visibility split-brain** (residual weakness, Codex 3rd-pass). Orchestrator A reads (no claims), writes its label, rereads (sees only its own), returns `ok`. Then orchestrator B — which already read "no claims" before A's write became visible — writes its label, rereads (sees both), applies tiebreak. If B's label sorts first, B also returns `ok`. **Two orchestrators believe they own the same issue.** The local lease catches this on the same host; cross-host orchestrators rely on FORGE-22's gc reconciliation (local-vs-tracker alignment) to detect and resolve the divergence on the next cheap-gc pass.

This is the same residual race as `GitHubTracker`. The spec accepts it as the cost of weak label-CAS in trackers without native versioning; FORGE-22 is the contract for catching cases (2) post-hoc.

### Precondition: globally unique `runId`

Callers MUST pass a globally-unique `runId` (the v2 orchestrator's run identifier, UUIDv7). Two orchestrators that happen to pick the same `runId` would both think they own the issue — the tiebreak resolves on label string, not on orchestrator identity. Enforced by the orchestrator's startup code (FORGE-20, in progress), not by this adapter.

### Strict-scope `releaseClaim`

`releaseClaim(issueId, runId)` removes only `forge:claimed-by:<runId>` — the caller's exact label. It does NOT broad-clear other agents' labels even if they appear stale. Trusted-caller contract: callers invoke release only on issues they own. If a `forge:claimed-by:<otherRunId>` label gets orphaned by a crashed orchestrator, it remains until `forge orchestrate gc` reconciles (FORGE-22). This is consistent with `GitHubTracker.releaseClaim` (FORGE-77).

Linear-specific complication: `updateIssue` requires a label **id**, not a name. We translate via `lookupExistingLabel` (cached team-label lookup; refreshes via `listIssueLabels` once on miss). The lookup is wrapped in `withRetry` so a transient network failure doesn't silently leak the claim.

**Stale-cached-id guard:** If a label is deleted+recreated out-of-band (e.g., Linear UI admin action) between `claim` and `releaseClaim`, the cache holds an obsolete id. The server rejects the stale id as `VALIDATION`. We evict the cache entry, refresh once via `listIssueLabels`, and retry with the fresh id. If the fresh lookup returns the same id or no label, idempotent return.

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

- **Label name length**: Linear's label cap is 255 chars. `forge:claimed-by:<UUIDv7>` is 53 chars — comfortably under the cap. No UUID transform is applied; LinearTracker writes the canonical hyphenated UUID form directly. (GitHub requires a dehyphenation transform to stay under its 50-char cap; see `docs/adapters/github.md` for details.)
- **Custom workflow state names**: forge maps by `WorkflowState.type`, not name. If your team uses `started`-typed states with names like "Active" or "WIP", forge treats them as `in_progress` regardless. This is correct behavior.
- **Issue archival**: archived issues don't appear in `listActiveIssues` (filtered out by `state.type IN [...]`). Forge has no API to un-archive.
- **Description size**: Linear caps descriptions at 65535 chars. forge does not silently truncate; `VALIDATION` errors from `createIssue` / `updateIssue` propagate.
- **Pre-existing labels named `forge:claimed-by:*` from non-forge tooling**. Forge treats them as valid claims. Don't namespace-collide. (Reserve the `forge:` label prefix for forge.)
- **Legacy `claimed:agent-*` labels** (pre-FORGE-76). Forge no longer reads or writes the old prefix. Any labels left over from a pre-FORGE-76 binary are inert and invisible to the current claim logic. Manual cleanup is optional; tracker-side stale-claim reconciliation lands in FORGE-22 (`forge orchestrate gc`).
- **Orphan claim labels**. If an orchestrator crashes mid-task, its `forge:claimed-by:<runId>` label persists. Strict-scope `releaseClaim` does not clean these up — the issue stays `already_claimed` until the orphan is manually cleared via Linear UI or `forge orchestrate gc` (FORGE-22).

---

## Related

- Tracker interface: `src/trackers/base.ts`
- Adapter source: `src/trackers/linear.ts`
- Unit tests: `test/unit/trackers/linear.test.ts`
- Conformance suite: `test/fixtures/trackers/conformance.ts`
- Integration test (gated): `test/integration/trackers/linear.test.ts` — requires `FORGE_E2E_LINEAR=1`, `FORGE_E2E_LINEAR_TEAM_ID`, `LINEAR_API_KEY`
- Sibling adapters: `src/trackers/github.ts` (FORGE-15), `src/trackers/notion.ts` (FORGE-17)
