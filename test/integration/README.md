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
