---
name: sync-status
description: Pull current tracker state and reconcile with local phases.yaml. Useful when issues were closed/reopened in the tracker directly.
tools: Read, Edit, Bash(gh*)
subagent: tracker-syncer
---

# /sync-status

Read `plans/phases.yaml` and `.forge/settings.yaml`. For each task with a `tracker_issue_id`, query the configured tracker for current status. Update `phases.yaml` task status fields if drifted.

Report any divergence to user (e.g., "TLOG-103 closed in tracker but local says Todo").

This isn't usually needed — Linear ↔ GitHub native sync handles most cases, and the GitHub tracker is read-from-source-of-truth. Use when manual closes happen out-of-band.

## Preflight

1. Read `.forge/settings.yaml` and resolve `tracker.type`. Abort if unset with: "No tracker configured. Run `forge init` first."
2. Per-tracker reachability probe — same matrix as `/push-to-tracker` Step 1 (Linear MCP / `gh auth status` / Notion MCP). If unavailable, abort with the setup hint from `/push-to-tracker` — there is no offline fallback for status reconciliation.
