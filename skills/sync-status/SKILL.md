---
name: sync-status
description: "Diagnostic that suggests when an active phase is ready for /phase-gate, and lists orphan tracker issues missing from plans/phases.yaml. Read-only — does not mutate phases.yaml."
tools: Read, Bash
---

# /sync-status

> **Status queries always hit the tracker. `plans/phases.yaml` is a stale cache.** See your project `CLAUDE.md` §Source of truth.

Read-only diagnostic that answers two questions:

1. **Is any active phase ready for `/phase-gate`?** For each `status: active` phase in `plans/phases.yaml`, check whether every task's `tracker_issue_id` is absent from the tracker's active set. If so, suggest running `/phase-gate <phase-id>` — never auto-advance.
2. **Are there orphan tracker issues?** List tracker issues that are active in the tracker but have no matching `tracker_issue_id` line anywhere in `plans/phases.yaml`. These are usually out-of-band hot-fixes the operator may want to backfill.

The skill never writes to `phases.yaml`. Per-task status drift detection is not possible because `phases.yaml` has no per-task `status` field — that's intentional; the tracker is the per-task status authority. See `spec/ORCHESTRATOR.md §CLI surface` (FORGE-20 readiness algorithm) for the underlying design constraint.

## Preflight

1. Read `.forge/settings.yaml`. Abort if `tracker.type` is unset with: "No tracker configured. Run `forge init` first."
2. Per-tracker reachability probe (Linear MCP / `gh auth status` / Notion MCP) — same matrix as `/push-to-tracker` Step 1. Abort with the setup hint if unavailable. There is no offline fallback.

## Steps

1. **Verify `plans/phases.yaml` exists.** If not, abort with: "No `plans/phases.yaml` found. Run `/decompose` to generate one."

2. **Fetch active tracker issues — ONE call.** Based on `tracker.type` from settings:
   - **Linear**: call the Linear MCP `list_issues` tool with the team filter from settings. Pass no state filter (the adapter excludes terminal states server-side).
   - **GitHub**: shell out to `gh issue list --repo <owner/repo> --state open --json id,number,title,labels,body,url --limit 250`.
   - **Notion**: call the Notion MCP equivalent against the configured data source.

   ONE call total — no per-issue follow-ups. This matches the FORGE-20 design constraint.

3. **Normalize the response to the `Issue` shape.** Build a JSON array where each element matches:
   ```json
   { "id": "<tracker-internal-id>", "identifier": "FORGE-XX or #42", "title": "...", "state": "todo|in_progress|in_review|blocked", "blockerIds": [], "url": "..." }
   ```
   Map tracker-native state values to the canonical states: Linear `triage/backlog/unstarted` → `todo`, `started` → `in_progress`, etc. GitHub `open` → `todo` unless an explicit `forge:claimed-by:*` label is present → `in_progress`.

4. **Write the issues JSON to a temp file** at `/tmp/forge-sync-status-issues.json`.

5. **Invoke the render shim** to produce the diagnostic:
   ```bash
   node --import tsx src/bin/sync-status-render.ts plans/phases.yaml < /tmp/forge-sync-status-issues.json
   ```
   For `--json` output:
   ```bash
   node --import tsx src/bin/sync-status-render.ts plans/phases.yaml --json < /tmp/forge-sync-status-issues.json
   ```
   In a published adopter install (where the package is on the PATH), use `forge-sync-status-render` directly instead of the `node --import tsx ...` invocation.

6. **Print the shim's stdout to the operator.** The shim's exit code is the skill's exit code.

## Important wording rule

Output must say **"no active tracker issues remain"** for ready-to-gate phases, NEVER **"all tasks Done."** A task absent from the active set is not necessarily Done — it could be cancelled, archived, closed-without-merge, missed due to API limit, or inaccessible. The operator decides whether to proceed to `/phase-gate`.

## Known limitations

- **Done orphans are not surfaced.** `listActiveIssues()` filters to non-terminal states across every adapter. Orphan tracker issues that have already reached `Done` will never appear in the output. This is a deliberate choice from FORGE-80 to avoid expanding the `Tracker` abstraction for a single consumer. If Done-orphan visibility is later needed, file a follow-up to add `Tracker.listAllProjectIssues()` + an opt-in `--include-done` flag.
- **Untracked tasks block phase suggestions.** When an active phase contains tasks without a `tracker_issue_id`, the skill prints them under "manual review required" and does NOT suggest `/phase-gate`. The operator should either backfill via `/push-to-tracker` or remove the untracked task before advancing.

## Output examples

Ready-to-gate phase, no orphans:
```
phase-2 (active): no active tracker issues remain (14/14 tracked).
Verify the phase is complete and run `/phase-gate phase-2`.

No orphan tracker issues. ✓
```

Ready-to-gate phase WITH untracked-task warning:
```
phase-2 (active): no active tracker issues remain (14/14 tracked).
2 tasks missing tracker_issue_id — manual review required before `/phase-gate`:
  - P2-T20 "Spike: GraphQL client"
  - P2-T21 "Doc audit"

No orphan tracker issues. ✓
```

Phase still in progress + orphans present:
```
No phase suggestions.

Orphan tracker issues (active in tracker, not in plans/phases.yaml):
  - FORGE-99  Todo         "Hot-fix: claim label too long for GitHub"
  - FORGE-82  In Progress  "Fix: claimed-by exceeds 50-char cap"
2 orphans — review whether to backfill into phases.yaml or treat as out-of-band.
```
