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
| `concurrent claim` | Two parallel `claim` calls on the same fresh issue produce exactly one winner; the other gets `already_claimed` or `state_changed` |
| `setBlockedBy` round-trip | `setBlockedBy(B, A)` writes the footer AND creates the native `IssueRelation(type:'blocks')`. `listActiveIssues` round-trips `blockerIds: [A.id]`. Second call is idempotent (no duplicate footer entries). |

Issues are archived in `finally` blocks via `client.archiveIssue(id)`. Manual cleanup of archived issues is usually unnecessary — Linear's UI filters them out by default — but if you want to purge: open team settings → Archive → bulk delete.

### Cost / runtime

- ~12 Linear GraphQL calls per run across the three tests.
- Typical wall time: **<20 seconds** on a healthy connection.
- Labels (`claimed:agent-*`, `state:in-review`, `state:blocked`) created on first run persist in the team.

### Limitations

- The negative `healthCheck` case (invalid API key) is **not** tested automatically — would require corrupting the env mid-run. Verified manually with a known-bad key.
- Tests assume the throwaway team has at least one `unstarted`, `started`, and `completed` workflow state. Linear's defaults satisfy this.
- The race test (`concurrent claim`) is non-deterministic by nature — under high Linear API latency, Linear may serialize the two requests and the race never actually occurs. The unit-test race coverage (20× Promise.all with shared mock state) is the deterministic primary; this integration test verifies the contract holds against the real API at least once.
