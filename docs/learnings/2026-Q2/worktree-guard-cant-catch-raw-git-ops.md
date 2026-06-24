# Shipped the bleed fix, then immediately caused the bleed
> 2026-05-17 · FORGE-159 · tags: [worktrees, parallel-sessions, dogfooding, meta-work, confusion-protocol, infra]

## What we expected
The worktree-guard PR — which adds a preflight check to every mutating skill so they exit 1 when run outside a worktree — would prevent branch bleed between parallel Claude Code sessions going forward.
The branch created for the PR itself was assumed to be safe because it was a one-off `git checkout -b` done at the user's direct request, not via a skill.

## What happened
Immediately after the PR was merged, the branch `feat/worktree-guard-and-question-format` was created with a raw `git checkout -b` in the main checkout (`/Users/firatcandogan/repos/forge`).
Every other Claude Code session the user had open in that same checkout saw the HEAD change instantly — the exact bleed the PR was meant to stop.
The guard did not fire because it only runs inside skill preflight (`/plan-task`, `/implement`, `/ship`, etc.); a raw git command issued by the agent bypasses it entirely.

## Why
The guard is a skill-layer defence, not a shell-layer defence.
It catches the common case (a skill running on the wrong checkout) but has no reach over ad-hoc git ops that happen outside the skill runtime.
Meta-work on forge itself — patches, hotfixes, PR branches for the framework — has no Linear ticket and therefore never goes through `/pickup-task`, which is the only entry point that calls `git worktree add` automatically.
The assumption "if there's no ticket, a raw branch is fine" is wrong: the isolation guarantee depends on the worktree, not on the ticket.

A secondary design lesson surfaced during Codex's second-opinion review: the original design stored the binding marker (`.forge/session-worktree`) in the main repo, meaning parallel sessions would overwrite each other's pointer. Codex caught this before any code was written. The correct design writes the marker *inside* the worktree, so each session owns its own file. This was fixed in design before implementation.

## Next time
For ANY branch creation — including meta-work on forge with no Linear ticket — run `git worktree add ../forge-{slug} -b feat/{slug}` first, then do all work there.
Never use `git checkout -b` in the main checkout, not even for a "quick" PR branch.
The rule is unconditional: main checkout = read-only reference, worktrees = all mutation.
When a user says "commit on a feature branch" and there is no ticket, the correct response is to create a worktree manually, not to branch in place.
The skills-level guard is a backstop, not the primary control. The primary control is the worktree discipline itself.
