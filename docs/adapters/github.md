# GitHubTracker — GitHub Issues adapter

Implements the `Tracker` interface (`src/trackers/base.ts`) against the GitHub Issues REST/GraphQL API via the official [`gh`](https://cli.github.com) CLI. Used at orchestrator runtime when `tracker.type: github` in `.forge/settings.yaml`.

> **Not to be confused with**: the user-facing `/push-to-tracker` skill inside Claude Code. That skill also runs the GitHub backend path through the same adapter — but this doc focuses on the orchestrator runtime (`forge orchestrate`) view.

---

## Setup

### 1. Install and authenticate `gh`

```bash
brew install gh           # or your platform's equivalent
gh auth login             # OAuth or PAT, repo scope
```

`forge init` runs `gh auth status` and surfaces a non-fatal probe failure if the user is not logged in.

### 2. Configure repo

In `.forge/settings.yaml`:

```yaml
tracker:
  type: github
  config:
    repo: owner/name
```

No additional environment variables. The adapter uses the same `gh` credentials as the rest of your tooling.

---

## What the adapter does

| Tracker method | GitHub operation |
|---|---|
| `healthCheck()` | `gh auth status` — returns ok if logged in |
| `listActiveIssues()` | `gh issue list --state open --json id,number,title,labels,body,url --limit 200`; warns on hitting `GH_LIST_LIMIT = 200` |
| `claim(issueId, runId)` | weak label-CAS with verify-on-readback: add `forge:claimed-by:<runId-dehyphenated>` then re-read to detect concurrent claims (see [Claim semantics](#claim-semantics)) |
| `releaseClaim(issueId, runId)` | strict-scope: `gh issue edit --remove-label forge:claimed-by:<runId-dehyphenated>`. Idempotent — missing label is swallowed silently. |
| `updateState(issueId, state)` | `gh issue close --reason completed`/`gh issue close --reason "not planned"` for terminal states; `gh issue reopen` + overlay label (`state:in-progress`, `state:in-review`, `state:blocked`) for open states |
| `comment(issueId, body)` | `gh issue comment --body` (one-shot — no retry) |
| `createProject(name, description?)` | `gh api repos/{repo}/milestones --method POST` → returns `{ id: milestoneNumber, url: html_url }`; precreates state overlay labels |
| `createIssue(payload)` | `gh issue create --title --body` with forge:task + forge:ownerType HTML-comment footers |
| `setBlockedBy(issueId, blockerId)` | rewrites the issue body's `<!-- forge:blockedBy=... -->` footer; idempotent (dedup) |

---

## Claim semantics

GitHubTracker claims issues by attaching the label `forge:claimed-by:<runId-dehyphenated>` and then re-reading the label set to detect concurrent claims. This is the weak label-CAS + verify-on-readback contract from `spec/ORCHESTRATOR.md:373`.

> **Wire-format note**: GitHub enforces a 50-character hard cap on label names. A UUIDv7 with hyphens is 36 chars, giving `forge:claimed-by:` (17) + 36 = 53 chars — 3 over the cap. Forge strips hyphens from the UUID before writing to GitHub, producing 17 + 32 = 49 chars. The orchestrator always supplies and receives canonical UUID form (with hyphens); `toStoredLabel(runId)` / `runIdFromStoredLabel(stored)` handle the transform at the adapter boundary. See [Limitations](#limitations-and-known-gotchas) for the full rationale and backward-compat note.

### Two-step flow

1. **Read** current labels via `gh issue view --json labels`. If no `forge:claimed-by:*` label is present, proceed; if another agent's label is present, return `{ ok: false, reason: 'already_claimed' }` without writing.
2. **Add** our label via `gh issue edit --add-label forge:claimed-by:<runId-dehyphenated>` (append-only — the `--add-label` flag does NOT clobber user-applied labels, unlike a full `labelIds` replace). The on-the-wire label name is the dehyphenated UUID; see the wire-format note above.
3. **Re-read** labels. If only our label is present, return `{ ok: true }`. If multiple `forge:claimed-by:*` labels are present, apply the tiebreak (see below).

### Tiebreak

When the re-read shows multiple claims, we sort all `forge:claimed-by:*` labels using `localeCompare(..., 'en', { sensitivity: 'base' })` and the lexicographically-first label wins. Losers call `gh issue edit --remove-label` against their own label and return `{ ok: false, reason: 'version_conflict', detail: 'lost-tiebreak-to:<winner>' }`.

The locale-aware sort is load-bearing. Default JavaScript `Array.sort()` uses UTF-16 code units, which puts `'Z' < 'a'`; we don't want runId casing to swing claim outcomes across hosts.

### Race window

There is a ~200ms window between step 2 (write) and step 3 (re-read) during which another agent could write its own label and not yet appear in our re-read. This is the residual race the spec calls "weak-but-honest CAS":

- The GitHub REST API does NOT expose `If-Match` / `expectedVersion` semantics on issue label mutations (verified against `gh/api/issues/{number}/labels` in the GitHub REST API reference). True optimistic concurrency is not available.
- Forge's local lease (single-orchestrator-per-host, see `spec/ORCHESTRATOR.md` §Multi-main coordination) prevents same-host concurrent dispatch, so the race is bounded to cross-host orchestrators — a rare configuration in practice.
- If the race fires, both orchestrators see the same multi-label state on the re-read and apply the same deterministic tiebreak, so the loser self-cleans.

### Precondition: globally unique `runId`

Callers MUST pass a globally-unique `runId` (UUIDv7, generated by the orchestrator). Two orchestrators that happen to pick the same `runId` would both think they own the issue — the tiebreak resolves on label string, not orchestrator identity. Enforced by the orchestrator's startup code, not by this adapter.

### Strict-scope `releaseClaim`

`releaseClaim(issueId, runId)` removes only `forge:claimed-by:<runId-dehyphenated>` — the caller's exact label in stored (dehyphenated) wire form. It does NOT broad-clear other agents' labels even if they appear stale. Trusted-caller contract: callers invoke release only on issues they own. If a `forge:claimed-by:<otherRunId>` label gets orphaned by a crashed orchestrator, it remains until manually cleared. This is consistent with LinearTracker and NotionTracker behavior under their respective tasks (FORGE-76 for Linear, FORGE-78 for Notion).

A missing label on remove (already cleared, never set, issue closed/deleted) is swallowed silently — release is idempotent.

---

## State mapping

GitHub Issues have two native states (`open`, `closed`) with a close-reason discriminator (`completed`, `not planned`). Forge's six states map via close+reason and overlay labels:

| Forge state | GitHub action | Overlay label |
|---|---|---|
| `todo` | `reopen` (idempotent) | none (removes `state:*`) |
| `in_progress` | `reopen` + add `state:in-progress` | `state:in-progress` |
| `in_review` | `reopen` + add `state:in-review` | `state:in-review` |
| `blocked` | `reopen` + add `state:blocked` | `state:blocked` |
| `done` | `close --reason completed` | none |
| `cancelled` | `close --reason "not planned"` | none |

Note the CLI spelling for `cancelled` is `"not planned"` (space, no underscore) — this is the human-readable form `gh` accepts on the command line, NOT the GitHub API enum spelling `not_planned`. The unit test at `test/unit/trackers/github.test.ts` pins this exact arg to catch future drift.

Overlay labels are precreated as part of `createProject` so the orchestrator never needs a label-create round-trip during state changes. Already-open `reopen` and already-set label adds are tolerated silently.

---

## Blockers — body-footer rewrite

`setBlockedBy(issueId, blockerId)` rewrites the issue body's `<!-- forge:blockedBy=<id1>,<id2>,... -->` HTML-comment footer:

1. Fetch current body via `gh issue view --json body`.
2. Parse existing footer via `parseForgeFooters` (shared with all adapters).
3. Append `blockerId` (dedup) and re-serialize via `serializeWithForgeFooters`.
4. Write back via `gh issue edit --body`.

Forge metadata lives in HTML comments inside the issue body (footers `<!-- forge:task=... -->`, `<!-- forge:ownerType=... -->`, `<!-- forge:blockedBy=... -->`) so the markdown rendering stays clean.

Unlike LinearTracker, GitHubTracker does NOT create a native issue dependency. GitHub has no first-class blocked-by relation on `repos/{repo}/issues` — only project-board-level dependencies, which require a separate API surface and project configuration. The body-footer is the single source of truth for forge orchestrator blocker resolution.

If `blockerId` is non-numeric, `setBlockedBy` throws `TrackerError('VALIDATION')`. If the issue body has no `forge:task=` footer (the issue was created outside forge), it throws `TrackerError('PRECONDITION_FAILED')`.

---

## Error classification

`classifyGitHubError` (`src/trackers/github.ts:95`) maps `gh` stderr to `NormalizeErrorHint` codes:

| Stderr pattern | Code | Retried by `withRetry`? |
|---|---|---|
| `Bad credentials` / `HTTP 401` / `HTTP 403` (non-rate) | `AUTH` | no |
| `API rate limit exceeded` / `HTTP 403 ...rate` | `RATE_LIMITED` (with `retryAfterMs` if `Retry-After` header parsed) | yes — honors `Retry-After` |
| `HTTP 404` / `could not resolve to` | `NOT_FOUND` | no |
| `HTTP 422` / `validation failed` | `VALIDATION` | no |
| `<label> not found` + `failed to update N issue` (stderr-only) | `VALIDATION` (with `details.reason = 'label-not-found'`) | no — `claim()` returns `version_conflict` |
| `label X does not exist` (stderr-only, older gh versions) | `VALIDATION` (with `details.reason = 'label-not-found'`) | no |
| `HTTP 409` / `already exists` | `CONFLICT` | no |
| `ETIMEDOUT` / `timeout` | `TIMEOUT` | yes |
| `HTTP 5xx` / `ECONNRESET` / `EAI_AGAIN` | `TRANSPORT` | yes |
| `ENOENT` (gh CLI not installed) | `TRANSPORT` (with `reason: 'gh-not-installed'`) | no |
| anything else | `UNKNOWN` | no |

Branch order in `classifyGitHubError` is load-bearing: AUTH must come before NOT_FOUND because GitHub's 403 for private repos uses "Not Found" copy to avoid leaking existence; VALIDATION (HTTP 422) must come before the stderr-only label-not-found branch (which is also VALIDATION but pattern-matches differently) and before CONFLICT because "Validation Failed" 422 bodies can include "already exists" verbatim.

---

## Auth failure runbook

### `healthCheck` returns `{ ok: false, detail: 'gh CLI not installed (ENOENT)' }`

Install `gh` (`brew install gh` on macOS, [cli.github.com](https://cli.github.com) elsewhere) and retry.

### `healthCheck` returns `{ ok: false, detail: 'not logged in...' }`

```bash
gh auth login
```

Pick HTTPS, paste a PAT with `repo` scope (or use OAuth browser flow). Test out-of-band:

```bash
gh auth status              # confirms login
gh repo view owner/name     # confirms repo access
```

### `RATE_LIMITED` errors during orchestrate

GitHub's REST API enforces 5000 req/hour for authenticated PATs (lower for unauthenticated or app installations). The adapter respects `Retry-After` headers and retries via `BaseTracker.withRetry` with exponential backoff. If you hit rate limits frequently:

- Lower `agents.poll_interval_ms` cautiously (raises quota burn)
- Use a GitHub App installation token instead of a personal PAT (higher quota: 15000 req/hour per installation)
- Contact GitHub Support for an enterprise rate-limit lift if running at scale

---

## Limitations and known gotchas

### GitHub label name cap — 50 characters

GitHub enforces a hard 50-character limit on label names. Forge's claim label uses the pattern `forge:claimed-by:<UUID>`:

| Component | Length |
|---|---|
| Prefix `forge:claimed-by:` | 17 chars |
| UUIDv7 with hyphens (canonical form) | 36 chars |
| **Total (naive)** | **53 chars — 3 over cap** |
| UUIDv7 without hyphens (stored form) | 32 chars |
| **Total (stored form)** | **49 chars — safely under cap** |

Forge strips hyphens from the UUID at the write path (`toStoredLabel(runId)`) and never writes the hyphenated form to GitHub. The transform is invisible to the orchestrator — callers always supply and receive canonical UUIDv7 format. The `runIdFromStoredLabel(stored)` helper reverses the transform for tooling that reads raw labels from the GitHub API.

**Old-format labels (backward compat)**: Labels written by binaries predating FORGE-82 used the hyphenated 53-char form. GitHub's 50-char cap means these labels could not have been created on github.com (GitHub would have returned HTTP 422 at label-create time). If you run GitHub Enterprise with a relaxed or absent label-name cap, old-format labels may exist. Forge tolerates them on read (the `forge:claimed-by:` prefix filter still matches) and never writes them (all writes go through `toStoredLabel`). No migration script is provided.

**Linear and Notion are unaffected**: Linear's label cap is 255 chars — `forge:claimed-by:<UUIDv7>` (53 chars) fits comfortably; no transform needed. Notion stores the claim in a rich_text property value (not a label name), with no length pressure. See `docs/adapters/linear.md` and `docs/adapters/notion.md` for their adapter-specific notes.

- **No native blocker relation**. Forge stores blockers in body-footer comments only. GitHub's project-board dependencies exist but require additional setup outside forge's scope.
- **State mapping uses overlay labels**. `state:in-progress`, `state:in-review`, `state:blocked` are precreated on `createProject` but a manually-deleted state label causes `listActiveIssues` to report the issue as `todo` until forge re-applies state on next update.
- **Pre-existing labels named `forge:claimed-by:*` from non-forge tooling**. Forge treats them as valid claims. Don't namespace-collide. (Reserve the `forge:` label prefix for forge.)
- **Orphan claim labels**. If an orchestrator crashes mid-task, its `forge:claimed-by:<runId>` label persists. Strict-scope release does not clean these up — the issue stays `already_claimed` until the orphan is manually cleared via `gh issue edit --remove-label`.
- **`gh issue list --limit` ceiling**. `GH_LIST_LIMIT = 200`. Listing emits a `tracker.listActiveIssues` warn log when the limit is hit. For larger repos, GitHubTracker would need pagination — not yet implemented.
- **Legacy `claimed:agent-*` labels** (pre-FORGE-77). Forge no longer reads or writes the old prefix. Any labels left over from a pre-FORGE-77 binary are inert and invisible to the current claim logic. Manual cleanup is optional.

---

## Related

- Tracker interface: `src/trackers/base.ts`
- Adapter source: `src/trackers/github.ts`
- Unit tests: `test/unit/trackers/github.test.ts`
- Conformance suite: `test/fixtures/trackers/conformance.ts`
- State-backed mock for conformance: `test/fixtures/trackers/github-state.ts`
- Integration test (gated): `test/integration/trackers/github.test.ts` — requires `FORGE_E2E_GITHUB=1` and a writeable test repo
- Sibling adapters: `src/trackers/linear.ts`, `src/trackers/notion.ts`
- Spec: `spec/ORCHESTRATOR.md` §Tracker atomic claim — per-adapter capability matrix
