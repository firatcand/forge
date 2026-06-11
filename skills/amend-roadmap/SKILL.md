---
name: amend-roadmap
description: Create a new task mid-flight — interactive field collection, then a tracker-first atomic amend (issue + relations on the tracker, materialized into phases.yaml via the reconcile pull path) with a resumable journal.
tools: Bash(*), Read, Write
---

# /amend-roadmap

Mid-flight roadmap mutation. The user has a new task ("we need a caching layer task, depends on T05") and wants it in the roadmap WITHOUT hand-editing phases.yaml or the tracker.

Skill ↔ verb split: this skill collects the fields, previews the plan, and confirms. ALL state mutation goes through `forge orchestrate amend-roadmap`, which is **tracker-first**: it creates the tracker issue, wires blocked-by relations, then materializes the task into `plans/phases.yaml` through the reconcile `--pull` machinery (staged addition) — phases.yaml stays single-writer. Every step is journaled and resumable.

## Preconditions

- `plans/phases.yaml` exists, validates, and has a `source:` stanza (tracker-bound). If there is no `source:` stanza, stop: run `/push-to-tracker` (greenfield) or `/reconcile --pull` first.
- `.forge/settings.yaml` has a working `tracker:` block.

## Step 1 — Collect fields

Prompt the user for (one round, AskUserQuestion where it helps):

| Field | Constraint |
|---|---|
| `phase` | existing `phase-N[.M]` id — show the active phases to pick from |
| `title` | verb + noun, ≤ 8 words |
| `description` | 1 paragraph |
| `type` | foundation · data · backend · integration · content · infra · skill · docs |
| `priority` | P0 · P1 · P2 |
| `estimate` | S · M · L — **XL is refused by the verb** ("No XL tasks ship — split them") |
| `owner_type` | backend-dev · frontend-dev · db-architect · devops-engineer · qa-engineer · security-auditor · design-engineer · integration |
| `acceptance` | ≥ 1 concrete, testable criteria |
| `depends_on` | task ids (`P2-T03`) or tracker identifiers (`FORGE-93`); every dep must already exist AND be tracker-backed |
| `write_globs` | optional — file globs for overlap classification |

## Step 2 — Preview + confirm

Show the user the assembled payload plus what will happen:

```
New task in phase-2.5 (next id will be computed by the verb, e.g. P2.5-T14):
  title:      Add caching layer for tracker reads
  type/prio:  backend · P1 · M · backend-dev
  depends_on: P2.5-T03 (FORGE-95)
Plan: 1 tracker issue + 1 blocked-by relation → phases.yaml via reconcile pull.
Proceed? [y/n]
```

On confirm, write the payload JSON to a temp file:

```bash
cat > /tmp/amend-payload.json <<'EOF'
{
  "phase": "phase-2.5",
  "title": "Add caching layer for tracker reads",
  "description": "…",
  "type": "backend",
  "priority": "P1",
  "estimate": "M",
  "owner_type": "backend-dev",
  "acceptance": ["…"],
  "depends_on": ["P2.5-T03"]
}
EOF
```

## Step 3 — Invoke the verb

```bash
forge orchestrate amend-roadmap --payload /tmp/amend-payload.json --json
```

Parse the single JSON envelope on stdout:

```json
{ "ok": true, "data": {
  "task_id": "P2.5-T14",
  "tracker_identifier": "FORGE-210",
  "tracker_issue_id": "uuid-…",
  "url": "https://linear.app/…",
  "depends_on": ["P2.5-T03"],
  "phases_updated": true,
  "journal": ".forge/orchestrator/global/amend-journal/completed/P2.5-T14.json",
  "drift_warnings": [{ "task_id": "FORGE-93", "state": "running", "attempt_id": "…" }]
}}
```

## Step 4 — Report

```
✓ /amend-roadmap: P2.5-T14 (FORGE-210) created — tracker + phases.yaml in sync.
  https://linear.app/…
⚠ roadmap changed under 1 active attempt: FORGE-93 [running]
  (informational — the worker re-reads phases.yaml on its next verb call)
```

Surface every `drift_warnings[]` entry — this is the v0.4 replacement for the dropped worktree-drift-guard.

## Failure + resume

The verb journals each step (`create_issue` → `relations[]` → `reconcile_pull`). On any failure it exits non-zero with a `hint` containing the exact resume command:

```bash
forge orchestrate amend-roadmap --resume P2.5-T14 --json
```

- **Resume is safe**: an issue created just before a crash is *adopted* (exactly-one `forge:task` footer match + title match), never duplicated.
- `JOURNAL_EXISTS` — another amend already reserves that task id with a *different* payload. Finish it (`--resume <id>`) or remove the stale journal, then re-run.
- `PAYLOAD_MISMATCH` — you passed `--resume` with an edited payload. Resume runs the original journaled payload only.
- Half-applied amends are always tracker-ahead (tracker-first ordering) — exactly the state `/reconcile --pull` already understands.

## Edge cases

- **Dep without tracker backing** (`INVALID_DEPENDENCY`): the dep task has no `tracker_issue_id`, so a tracker relation can't be wired. Run `/reconcile` or `/push-to-tracker` first.
- **XL estimate** (`PAYLOAD_INVALID`): split the task; re-run with S/M/L parts.
- **Truncated tracker view during resume adoption**: the verb refuses to re-create (the prior issue could be off-page). Retry when the tracker returns a complete view.
- **Invalid staged result** (`STAGED_ADDITION_INVALID` from the inner reconcile): the new task would make phases.yaml invalid (e.g. dep cycle); phases.yaml is NOT written. Fix the payload, resume.

## Output template

```
✓ /amend-roadmap: {task_id} ({tracker_identifier}) created — tracker + phases.yaml in sync.
```
