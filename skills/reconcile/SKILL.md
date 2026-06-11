---
name: reconcile
description: Bidirectional sync between plans/phases.yaml and the configured tracker. --pull reads tracker → phases.yaml; --push writes phases.yaml → tracker bodies via updateIssueBody.
tools: Bash(*), Read
---

# /reconcile

Bidirectional sync between `plans/phases.yaml` (local) and the configured tracker (Linear / GitHub / Notion).

- `--pull`: tracker → phases.yaml. Updates titles and `depends_on` for matched tasks. Reports orphans (in yaml but not in tracker), new tracker issues, and unmanaged issues (created outside forge).
- `--push`: phases.yaml → tracker. Renders each task's body from `description` + `acceptance` and calls `Tracker.updateIssueBody`. Best-effort: per-task errors don't abort the loop.
- `--dry-run` is supported on both directions — preview without writing.

Per `spec/ORCHESTRATOR.md` §CLI surface: this is the canonical bidirectional sync. **No conflict-resolution UI** — when the same task is edited in both places, the tracker (for `--pull`) or the local yaml (for `--push`) wins. Resolve via `git diff` and re-run.

## Preconditions

- `plans/phases.yaml` exists and validates against `PhasesSchema`
- `.forge/settings.yaml` exists with a `tracker:` block (validated by `TrackerConfigSchema`)
- The tracker is reachable (Linear API key in env / `gh auth status` ok / `ntn` CLI installed + authed)

## Step 0 — Direction

Ask the user (or accept arg): `--pull` or `--push`?

- Use `--pull` when: tracker has changes you want to mirror locally (someone closed an issue, retitled it, edited the blocker graph).
- Use `--push` when: you've edited `plans/phases.yaml` locally (refined a description, fixed acceptance criteria) and want tracker bodies to match.

## Step 1 — Dry-run preview

```bash
forge orchestrate reconcile --pull --dry-run --json
# or
forge orchestrate reconcile --push --dry-run --json
```

Parse the JSON output:

```json
{ "ok": true, "data": {
  "direction": "pull",
  "dry_run": true,
  "pull": {
    "updated":   [{ "task_id": "...", "tracker_issue_id": "...", "changes": [...] }],
    "removed":   [{ "task_id": "...", "tracker_issue_id": "..." }],
    "added":     [{ "tracker_issue_id": "...", "identifier": "...", "title": "...", "forge_task_id": "..." }],
    "unmanaged": [{ "tracker_issue_id": "...", "identifier": "...", "title": "..." }]
  },
  "applied": false
}}
```

Present a human summary to the user:

```
Pull preview — N updated · M removed (orphans) · K new (informational) · U unmanaged

Updated (will mirror tracker into phases.yaml):
  P1-T01  title: "Old" → "New"
  P2-T03  depends_on: [] → [P2-T01]

Orphans in phases.yaml (no matching tracker issue):
  P1-T99  → tracker-uuid-gone

New on tracker (informational — use /amend-roadmap to formalize locally):
  tracker-uuid-new (FORGE-99) "New task"

Unmanaged on tracker (created outside forge — left alone):
  tracker-uuid-x (FORGE-50) "Old hand-filed issue"
```

For `--push`, the dry-run plan has `push.plan.bodies[]` (will write) and `push.plan.skipped[]` (no `tracker_issue_id` or orphan).

## Step 2 — Confirm orphan prune (--pull only)

If `pull.removed.length > 0`, ask the user:

```
N orphan tasks will be REMOVED from phases.yaml. This is destructive.
  [y] confirm — prune all orphans
  [n] keep    — leave them in phases.yaml (tracker stays source of truth for everything else)
  [a] abort   — make no changes
```

Re-invoke the verb with the appropriate flag:

```bash
# user said y
forge orchestrate reconcile --pull --confirm-prune --json
# user said n
forge orchestrate reconcile --pull --no-prune --json
```

If no orphans, skip the prompt — proceed straight to apply.

## Step 3 — Apply

```bash
forge orchestrate reconcile --pull [--confirm-prune|--no-prune] --json
# or
forge orchestrate reconcile --push --json
```

Parse the result:

- `data.applied` — boolean, whether anything was written
- `data.mutations` — count of structural edits to phases.yaml (`--pull` only)
- `data.push.succeeded[]` / `data.push.failed[]` — per-task outcomes (`--push` only)

## Step 4 — Report

Print a one-line summary:

```
✓ pull applied: 2 updated, 1 pruned. phases.yaml written.
```

```
⚠ push partial: 7 succeeded, 3 failed.
   failed:
     P2-T18 (FORGE-114): PRECONDITION_FAILED — issue has no forge:task footer
     P2-T20 (FORGE-116): RATE_LIMITED — retry later
   Re-run `forge orchestrate reconcile --push` to retry — successful pushes are idempotent.
```

Exit codes:
- `0` — success
- `1` — `PRUNE_PENDING` (--pull found orphans; re-run with `--confirm-prune` or `--no-prune`)
- `2` — `PARTIAL_PUSH_FAILURE` (--push had per-task errors; data.push.failed[] populated)
- `3` — config / file error (PHASES_NOT_FOUND, INVALID_CONFIG)
- `4` — tracker call failed at `listActiveIssues`

## Tracker-specific notes

- **Notion**: fully supports `--push` since FORGE-117. `Tracker.updateIssueBody` is implemented in `NotionTracker` via the `ntn` CLI.
- **Linear / GitHub**: both fully supported. The trailing `<!-- forge:task=... -->` footer is preserved across updates by the adapters.

## Failure semantics on --push

The verb returns `exitCode: 2` (PARTIAL_PUSH_FAILURE) whenever `failed[]` is non-empty. Each failure entry includes a `code`:

- `PRECONDITION_FAILED` — the tracker issue exists but has no `<!-- forge:task=... -->` footer, so the adapter refuses the update. This means someone created the issue outside forge (e.g. via the web UI) and back-linked the `tracker_issue_id` manually. **Will fail every retry** until either the issue body gets the footer or the local `tracker_issue_id` is removed. Treat as a known skip rather than a transient retry.
- `RATE_LIMITED` / `TRANSPORT` / `TIMEOUT` — transient, safe to retry by re-running `--push`.

When automating retries, filter `failed[]` to `code in {RATE_LIMITED, TRANSPORT, TIMEOUT}` before re-invoking; `PRECONDITION_FAILED` will loop forever.

## Edge cases

- **No `tracker_issue_id` on a task**: `--push` skips it silently; appears in `push.plan.skipped[]` with reason `no_tracker_issue_id`. Use `/amend-roadmap` to create the missing tracker issue.
- **Adapter pagination cap** (200 issues): logged at warn level by the adapter. The verb completes against the truncated set.
- **YAML comments in phases.yaml**: preserved across `--pull` writes via `yaml.parseDocument` document-mode mutation. Field order and inline comments survive — including the collection style (block vs flow) and per-item inline comments on `depends_on`, which are edited in place rather than rebuilt.
- **Concurrent `--push` from another operator**: not protected — see `Tracker.updateIssueBody` docstring. Coordinate via team norms.

## Output template

```
✓ /reconcile {direction} {applied|dry-run}: N updates · M prunes · K skips · F fails.
```
