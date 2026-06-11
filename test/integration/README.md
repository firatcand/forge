# Integration tests

Real-API tests that hit live providers. **Skipped by default in CI** — gated behind environment variables.

The live-provider suites below are also part of the manual pre-release ritual —
see [docs/release-checklist.md](../../docs/release-checklist.md), which links
each `FORGE_E2E_*` gate to a publish step.

## Deterministic lifecycle harness (`cli/orchestrate/lifecycle.e2e.test.ts`) — FORGE-110

A **fully deterministic** drive-through of the orchestrate verb surface over the
frozen fixtures in [`examples/`](../../examples/) — no LLM, no live tracker. It
exercises programmatic verb composition with injected in-memory trackers: the
lifecycle chain (to RUNNING), the multi-main CAS race, the `/update-spec` closed
loop + `--resume` crash recovery, `reconcile --pull/--push`, `amend-roadmap`
drift, and a `forge migrate` smoke.

### Run

```bash
# one fixture at a time (each <60s):
FORGE_E2E_FIXTURE=github node --test --import tsx test/integration/cli/orchestrate/lifecycle.e2e.test.ts
FORGE_E2E_FIXTURE=linear node --test --import tsx test/integration/cli/orchestrate/lifecycle.e2e.test.ts
FORGE_E2E_FIXTURE=notion node --test --import tsx test/integration/cli/orchestrate/lifecycle.e2e.test.ts
```

Without `FORGE_E2E_FIXTURE` set to `github|linear|notion` the file **self-skips**
(so plain `npm test` does not double-run the heavier scenarios). CI runs all
three across Node 22/24 in the `e2e` job (`.github/workflows/ci.yml`).

> The harness proves *programmatic verb composition with injected trackers over
> frozen fixtures* — NOT skill execution. Skill-driven runs (Claude + Codex) are
> the manual pre-release checklist's job — see
> [docs/release-checklist.md](../../docs/release-checklist.md).

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
- Tests assume the fixture repo allows label creation; first run will create `forge:claimed-by:*` and `state:*` labels permanently.

---

## Linear adapter (`trackers/linear.test.ts`)

Tests the full LinearTracker lifecycle against a real Linear workspace via `@linear/sdk`.

### Prerequisites

1. A **throwaway Linear team** — tests create issues, projects, and labels. The issues are archived (not hard-deleted; Linear has no hard-delete API exposed) so don't point at a real team.
2. A **Linear Personal API Key** with access to that team. Mint at [linear.app/settings/account/security](https://linear.app/settings/account/security).
3. The team UUID. Query via Linear's API playground:
   ```graphql
   query { team(id: "YOUR-TEAM-KEY") { id name } }
   ```
   or via the SDK.

### Run

```bash
FORGE_E2E_LINEAR=1 \
FORGE_E2E_LINEAR_TEAM_ID=<team-uuid> \
LINEAR_API_KEY=lin_api_xxxxx \
npm test
```

Without `FORGE_E2E_LINEAR=1` the Linear integration tests are skipped.

### What's tested

| Test | What it verifies |
|---|---|
| `full lifecycle` | `healthCheck` → `createProject` → `createIssue` (with footer) → `listActiveIssues` (round-trips footer + state) → `claim` → `updateState('in_progress')` → `updateState('in_review')` (overlay label) → `comment` → `releaseClaim` → `updateState('done')` |
| `concurrent claim` | Two parallel `claim` calls on the same fresh issue produce exactly one winner; the other gets `already_claimed` or `version_conflict` |
| `setBlockedBy` round-trip | `setBlockedBy(B, A)` writes the footer AND creates the native `IssueRelation(type:'blocks')`. `listActiveIssues` round-trips `blockerIds: [A.id]`. Second call is idempotent (no duplicate footer entries). |

Issues are archived in `finally` blocks via `client.archiveIssue(id)`. Manual cleanup of archived issues is usually unnecessary — Linear's UI filters them out by default — but if you want to purge: open team settings → Archive → bulk delete.

### Cost / runtime

- ~12 Linear GraphQL calls per run across the three tests.
- Typical wall time: **<20 seconds** on a healthy connection.
- Labels (`forge:claimed-by:*`, `state:in-review`, `state:blocked`) created on first run persist in the team.

### Limitations

- The negative `healthCheck` case (invalid API key) is **not** tested automatically — would require corrupting the env mid-run. Verified manually with a known-bad key.
- Tests assume the throwaway team has at least one `unstarted`, `started`, and `completed` workflow state. Linear's defaults satisfy this.
- The race test (`concurrent claim`) is non-deterministic by nature — under high Linear API latency, Linear may serialize the two requests and the race never actually occurs. The unit-test race coverage (20× Promise.all with shared mock state) is the deterministic primary; this integration test verifies the contract holds against the real API at least once.

---

## Notion adapter (`trackers/notion.test.ts`)

Tests the full NotionTracker lifecycle against a real Notion database via the official Notion CLI (`ntn`) — FORGE-117 replaced the MCP-server transport.

### Prerequisites

1. A throwaway Notion database with the schema documented in [docs/adapters/notion.md](../../docs/adapters/notion.md). Forge expects these columns:
   - `Name` (title)
   - `forge_task_id`, `forge_claimed_by`, `forge_blocked_by`, `forge_owner_type`, `forge_acceptance` (rich text)
   - `state` (status) with options `Todo`, `In Progress`, `In Review`, `Done`, `Cancelled`, `Blocked`
2. The `ntn` CLI installed (https://developers.notion.com/cli) and authenticated via `ntn login` — no `NOTION_TOKEN` plumbing.
3. The Notion identity behind `ntn login` must have edit access to the test database.

### Run

```bash
FORGE_E2E_NOTION=1 \
  FORGE_E2E_NOTION_DATABASE_ID=11112222-3333-4444-5555-666677778888 \
  npm test
```

Without `FORGE_E2E_NOTION=1` the integration tests are skipped.

### What's tested

| Test | What it verifies |
|---|---|
| `full lifecycle` | `createIssue` (round-trips `forge_task_id`) → `claim` → `updateState('in_progress')` → `comment` → `updateIssueBody` (forge_task_id survives the block replace) → `releaseClaim` → `updateState('done')` → `listActiveIssues` (done page filtered out) |

Each test archives its fixture page via `ntn api v1/pages/{id} -X PATCH { archived: true }` in `finally`.

### Cost / runtime

- ~14 `ntn api` calls per run.
- Typical wall time: **~10 seconds**.

### Limitations

- `createProject` (`POST /v1/databases` with parent.page_id + initial_data_source (API 2026-03-11)) is **not** exercised in the integration test because it leaves a permanent database behind on each run and requires `FORGE_NOTION_PARENT_PAGE_ID`. Unit-tested instead.
- The race-tiebreak claim path is not reproducible against live Notion (needs two concurrent processes); unit-tested with the `version_conflict` recheck path only.

---

## Harness adapters (`harnesses/codex.test.ts`, `harnesses/gemini.test.ts`) — FORGE-88

Smoke tests that prove the harness adapter wires up against a real CLI binary — catches subprocess-arg bugs and binary-detection issues that the DI-stubbed conformance suite (`test/unit/harnesses/conformance.test.ts`) cannot.

These smokes are intentionally minimal — they probe `healthCheck()` and `detectVersion()` only. **Real `dispatchSubagent()` / `runReview()` calls spend tokens and are not part of the smoke** — the mocked conformance suite covers the dispatch lifecycle.

### Codex smoke

```bash
FORGE_E2E_CODEX=1 npm test
```

Requires `codex` CLI installed and authenticated.

### Gemini smoke

```bash
FORGE_E2E_GEMINI=1 FORGE_GEMINI_EXPERIMENTAL=1 npm test
```

Requires `gemini` on PATH or `npx @google/gemini-cli` resolvable, plus active gemini-cli auth. `FORGE_GEMINI_EXPERIMENTAL=1` is mandatory for any GeminiHarness construction (pre-1.0 CLI surface).

### Why this matters

Mocked conformance proves the IHarness *contract* — same lifecycle assertions against all three harnesses with stubbed subprocess output. The real-CLI smoke proves the *adapter* — the binary name, flag shape, and stdout parsing actually match what's installed. Both layers are required; neither subsumes the other.
