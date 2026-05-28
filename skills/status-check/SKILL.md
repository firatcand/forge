---
name: status-check
description: "Cold-start \"where am I?\" cockpit. Renders the cross-run orchestrator dashboard (active workers, open questions, ready vs blocked, overlap + lease health) and offers follow-up actions. Read-only; works standalone."
tools: Read, Bash
---

# /status-check

> **Distinct from `/sync-status`.** `/sync-status` reconciles the tracker against `plans/phases.yaml` (is a phase ready to gate? any orphan issues?). `/status-check` shows live *orchestrator runtime* state — which workers are running right now, what's claimed, what's stuck. When in doubt: "what can I gate?" → `/sync-status`; "where am I right now?" → `/status-check`.

Read-only cockpit for driving one or many parallel orchestrator sessions. Answers the cold-start question: *I just sat down — what's running, what's stuck, what can I pick up?* Works standalone — no `/forge orchestrate` dispatch loop required.

## Steps

1. **Run the dashboard verb (one call, read-only).**
   ```bash
   forge orchestrate dashboard --json
   ```
   In this dev repo (where the globally-installed `forge` binary may lag the source), use the dev entry instead:
   ```bash
   node --import tsx src/bin/forge.ts orchestrate dashboard --json
   ```
   The verb prints a `{ ok, data }` envelope. `data` has: `active_sessions`, `open_questions`, `ready_tasks`, `blocked_tasks`, `overlap_warnings`, `lease_health`, `source`, and `warnings`. It never mutates state and degrades gracefully (empty `ready_tasks`/`blocked_tasks` + `source.ready_blocked: "unavailable"` when `phases.yaml` is missing).

2. **Render a human summary** grouped into four panels:
   - **Active workers** — each `active_sessions[]` run with its `claimed_tasks`.
   - **Open questions** — each `open_questions[]` as `[<question_id>] <task_id> — <decision_key>`.
   - **Ready vs blocked** — `ready_tasks` (pickup candidates) and `blocked_tasks` (with their `blocked_by`).
   - **Warnings** — `overlap_warnings` (file collisions between in-flight tasks) and any `lease_health` entry whose status is `expiring_soon` or `stale`.
   Surface any `warnings[]` entries verbatim.

3. **Honor the source label.** `ready_tasks`/`blocked_tasks` come from the LOCAL `plans/phases.yaml` cache (`source.ready_blocked: "local-cache"`). State this when you present them: *"ready/blocked is from the local cache — run `/reconcile` for tracker truth."* This is also a **best-effort, non-atomic snapshot**: files can change mid-read, so a momentary mismatch (e.g. a task shown running with an already-released lease) is expected, not a bug.

4. **Optionally refresh ready/blocked against the tracker.** The verb is offline by design; this skill is the layer that may reach the tracker. If the operator wants authoritative readiness (and a tracker is configured in `.forge/settings.yaml`), cross-check the `ready_tasks`/`blocked_tasks` task ids against the tracker's live status (Linear MCP `list_issues` / `gh issue list` / Notion) and annotate any divergence. Skip silently when offline.

5. **Offer follow-up actions** (let the operator pick; do not auto-run mutating steps):
   - **Pick up the next ready task** — `/pickup-task <task-id>` for a `ready_tasks` entry.
   - **Answer an open question** — surface the `[<question_id>]` and route to `forge orchestrate answer`.
   - **Investigate a stuck lease** — for any `stale` lease, suggest inspecting that task (a `stale` lease is past expiry + steal grace, i.e. an orphaned/abandoned worker).

## Known limitations

- **Ready/blocked is cache-derived, not tracker-truth.** Per forge's source-of-truth rule, only the tracker is authoritative for status; the dashboard reads the local `phases.yaml` graph for speed and offline use. Step 4 is the opt-in reconciliation.
- **Snapshot is non-atomic.** No lock is taken; the view is a best-effort read of files that workers are concurrently mutating.
- **Lease health is time-relative.** `expiring_soon`/`stale` are computed against the current clock and the default steal-grace window; a clock skew between machines can shift the boundary.
