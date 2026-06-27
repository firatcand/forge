---
status: accepted
date: 2026-06-26
ticket: FORGE-155
supersedes: none
---

# `forge upgrade` exit-2 lease semantics

## Context

`spec/decisions/2026-05-21-claudemd-methodology-split.md` §9 reserves exit code 2
for `forge upgrade`: "uncommitted changes or active worktree leases
(configurable; `--force` overrides)." FORGE-153 (Phase B) shipped exit codes
1/3/4 and deferred exit 2 because the lease half depends on lease semantics
("active", stale handling, worktree locality, `--force` interaction) that the
ticket flagged as unsettled. This memo settles them (user-approved 2026-06-26).

The guard exists to stop a refresh of the methodology files (`.forge/CONTEXT.md`
et al.) from clobbering work that is mid-flight — either uncommitted edits or a
task a worker is actively leasing.

## Decisions

1. **What is an "active" lease?** A lease blocks only while it is **non-expired**,
   reusing the orchestrator's own liveness test: `classifyLeaseHealth(expires_at,
   now) === 'alive'` (i.e. `now < expires_at`). A lease whose worker crashed and
   stopped heartbeating ages out (default TTL 30 min) and then no longer blocks —
   it must never wedge upgrades forever. `expiring_soon` and `stale` do **not**
   block.

2. **Stale-lease handling.** Falls out of (1): staleness is `now >= expires_at`.
   We reuse `classifyLeaseHealth` rather than a local heuristic so the upgrade
   guard and the steal path agree on what "alive" means.

3. **Worktree locality.** Leases live only under the **main checkout** at
   `.forge/orchestrator/tasks/<task-id>/lease.json` (a worktree has no leases of
   its own). `forge upgrade` therefore resolves the main checkout (via the
   existing `.git`-directory walk) and scans **all** task leases there, regardless
   of whether it was invoked from the main checkout or from inside a worktree.

4. **Malformed lease → fail-closed.** A lease file that is unreadable, unparseable,
   or fails `LeaseSchema` validation is treated as **possibly active** and blocks
   (overridable by `--force`). This matches the existing `readLeaseFile` / `eject`
   precedent: when we cannot tell, assume work is in flight rather than clobber it.
   A missing lease file (ENOENT) is benign and does not block.

5. **`--force` scope.** A single `--force` overrides **both** the dirty-tree and
   active-lease refusals, per §9 verbatim. The existing `.bak` backup semantics
   (preserve the prior file before any forced overwrite) are unchanged.

6. **Configurable.** Honoring §9's "configurable", the guard is gated by a new
   settings key `upgrade.guard_in_flight` (zod-validated, **default `true`**).
   Setting it `false` disables the in-flight refusal entirely (upgrade proceeds
   without the dirty-tree/lease checks). `--force` remains the per-invocation
   bypass when the guard is on.

## Placement

The exit-2 guard runs **after** the exit-4 version-drift check and **before** the
CONTEXT.md edit-detection (exit 1) / any file write — preserving the invariant
that an exit-2 refusal mutates nothing.

**`--migrate-claudemd` is exempt from the guard (by design).** It is a one-shot
v0.4 → v0.5 transition whose precondition is that `.forge/CONTEXT.md` does not
yet exist — i.e. it only runs on repos that PRE-DATE the orchestrator/lease
surface, so an active worker lease cannot exist there. The migration has its own
symlink preflight and `.bak` reversibility, and `--force` is router-mutex'd with
`--migrate-claudemd` (so reusing the guard's "re-run with --force" message there
would be an impossible remediation). Gating it would also invert the established
exit-4-before-writes ordering. So the migrate route is a documented carve-out;
the guard applies to the normal upgrade path only.

## Hardening (it is a safety guard over a hand-editable tree)

- **git probe** runs with a sanitized + hardened environment: the path-redirect
  vars (`GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / …) and all `GIT_CONFIG*`
  injection vars are stripped; user/system config is ignored
  (`GIT_CONFIG_GLOBAL`/`SYSTEM=/dev/null`); `core.fsmonitor` is forced off
  (`-c core.fsmonitor=false`) so a repo-local config cannot execute a command;
  `--untracked-files=all` overrides `status.showUntrackedFiles`; and
  `GIT_OPTIONAL_LOCKS=0` + `--no-optional-locks` keep `.git/index` untouched.
- **fail-closed everywhere**: a git spawn/probe failure, an unresolvable main
  checkout, an unreadable orchestrator tree, and a symlinked / non-regular /
  oversized / unparseable / schema-invalid lease all BLOCK (overridable by
  `--force`). Only a parsed git "not a repository" result and a missing tree
  (ENOENT) are inert.

## Consequences

- Reuses `classifyLeaseHealth` (leases.ts) and the lease path helpers — no new
  staleness logic.
- One new settings key (`upgrade.guard_in_flight`), additive and defaulted, so
  existing settings.yaml files stay valid.
- Exit-2 is wired into the `forge upgrade` exit-code matrix alongside 1/3/4.
