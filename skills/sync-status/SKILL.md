---
name: sync-status
description: Pull current Linear state and reconcile with local phases.yaml. Useful when issues were closed/reopened in Linear directly.
tools: Read, Edit
subagent: linear-syncer
---

# /sync-status

Read `plans/phases.yaml`. For each task with a `linear_id`, query Linear for current status. Update `phases.yaml` task status fields if drifted.

Report any divergence to user (e.g., "TLOG-103 closed in Linear but local says Todo").

This isn't usually needed — Linear ↔ GitHub native sync handles most cases. Use when manual closes happen in Linear.
