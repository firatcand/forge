---
name: wrap-up
description: End-of-task housekeeping after a PR merges — remove the task worktree, delete the local branch, reconcile the tracker into phases.yaml, and return to a clean main. Suggest-don't-force; nothing is deleted until the PR is confirmed merged and you confirm.
tools: Bash(*), Read
---

# /wrap-up

Run this once a task's PR has merged. It tears down the per-task workspace and
returns you to a clean `main`. It is the inverse of `/pickup-task`.

Skill ↔ verb contract: this skill owns the UX (scope detection, the merged
gate, previews, confirmations, branch deletion, the `main` fast-forward). The
worktree removal itself goes through the verb — `forge orchestrate gc
--remove-worktrees` — which owns the eligibility + lease state machine. The
skill NEVER removes a worktree directory by hand and NEVER mutates orchestrator
state directly.

Modes:

- default — wrap up a single task (the one whose worktree you are in, or one you pick from the candidate list).
- `--all` — batch: wrap up every terminal-state task with a merged PR, behind a single confirmation.

---

## Safety contract (do not drop these clauses)

These four gates are non-negotiable. A future edit must keep every one.

### Unmerged-abort gate

The PR-merged check runs BEFORE anything is deleted. If `gh pr view` reports the
branch's PR is not `MERGED`, **abort immediately — NOTHING is deleted** (no
worktree removal, no branch deletion, no `main` switch). An open or closed-
unmerged PR means the work is not done; wrapping up would orphan it.

### Confirmation-before-destruction gate

Worktree removal and branch deletion only run after an explicit user
confirmation. Preview the full plan first (worktree path, branch, `main` delta).
Suggest-don't-force: never delete on the same turn you discovered the candidate.
In `--all` mode a SINGLE batched confirmation covers the whole list, shown in
full before the prompt.

### ff-only refusal on dirty main

Before `git switch main && git pull --ff-only`, run `git status --porcelain` in
the main checkout. If it is non-empty, **refuse the pull and show the porcelain
output verbatim** so the user can see exactly what is dirty. Never stash, reset,
or force. `--ff-only` itself refuses any non-fast-forward; do not override it.

### -D second-confirm

`git branch -d <branch>` (safe delete) is the default. It fails if the branch is
not fully merged into its upstream. Only escalate to `git branch -D` (force) after
a SECOND explicit confirmation — and only after the PR-merged gate has already
passed. A `-d` failure after a merged PR usually means the merge was a squash or
rebase; surface that, then offer the `-D` path.

---

## Step 1 — Scope detection (marker-file-first)

Determine which task(s) to wrap up.

- **Inside a worktree:** read the binding marker `.forge/worktree-task.json`
  (fields `version, taskId, branch, createdAt, createdBy`). Take `taskId` and
  `branch` from the marker — this is more reliable than parsing the branch name.
  Only if the marker is missing/unreadable, fall back to the branch regex
  `feat/<TICKET-ID>-<slug>` to recover the task id.

- **From the main checkout (or `--all`):** discover candidates through the
  verb's OWN planner — never grep `phases.yaml` for state:

  ```
  forge orchestrate gc --remove-worktrees --dry-run --json
  ```

  This emits `{ "eligible": [ { task_id, worktree_path, branch, state } ], "refused": [ { task_id, reason, state? } ], "absent": [ { task_id } ] }`.
  The `eligible` list is your candidate set. In default mode, present it and ask
  the user to pick one. In `--all` mode, take the whole `eligible` list. Show the
  `refused` entries too (with reasons) so the user understands what was skipped.
  The `absent` list contains task IDs whose worktree directory is already gone
  (planned noop, exit 0 — distinguishable from a gate refusal of a real candidate).

## Step 2 — PR-merged gate (Unmerged-abort gate)

For each in-scope task's branch:

```
gh pr view <branch> --json state,mergedAt
```

The PR must report `state: MERGED` (and a non-null `mergedAt`). If ANY in-scope
branch is not merged, **abort — delete nothing.** Report which branch blocked.
(Remote branch cleanup is handled by GitHub's auto-delete-on-merge repo setting;
this skill does not delete remote branches.)

## Step 3 — Reconcile the tracker

Pull the tracker's truth (the merged task is `Done`) into the local cache:

```
forge orchestrate reconcile --pull
```

This keeps `phases.yaml` honest before we tear down the workspace.

## Step 4 — Preview + explicit confirmation (Confirmation-before-destruction gate)

Show the plan and ask. For each task: the worktree path, the branch to delete,
and the `main` delta:

```
git log main..origin/main --oneline
```

Then confirm. In `--all` mode, list EVERY task in one preview and take a single
confirmation. Do not proceed without a yes.

## Step 5 — Execute

In order, per task:

1. **Remove the worktree (via the verb):**

   ```
   forge orchestrate gc --remove-worktrees --task <id>
   ```

   The verb refuses if the task is in an active state or its lease is alive /
   expiring (it allows a stale lease). If it surfaces a gitignored-loss refusal
   (e.g. a `node_modules` symlink you planted), it prints the offending files —
   remove them from the worktree, then re-run. There is no force flag.

2. **Delete the local branch (-D second-confirm):**

   ```
   git branch -d <branch>
   ```

   On failure (not fully merged — common after a squash/rebase merge), surface
   the message and offer `git branch -D <branch>` behind a SECOND confirmation.

3. **Return to a clean main (ff-only refusal on dirty main):**

   ```
   git status --porcelain      # in the main checkout
   git switch main && git pull --ff-only
   ```

   If `git status --porcelain` is non-empty, refuse the pull and print the
   porcelain output. Let the user resolve the dirt themselves.

## Step 6 — Report

One line per task: `wrapped up <id> — worktree removed, branch <branch> deleted,
main at <short-sha>`. In `--all` mode, one line per task plus a final count.
