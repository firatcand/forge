# Bundling resolve+match into one helper reordered a fail-closed security check
> 2026-05-28 · FORGE-65 · tags: [backend, security, refactoring, second-opinion]

## What we expected
Extracting `guardrail-check`'s path logic into a reusable `preflight.ts`
(`runPreflight` = resolveRepoRelative + matchAny) was "pure refactor" — same
behavior, now testable. The 12 existing guardrail tests stayed green, so it
looked safe.

## What happened
The verb went from *resolve-containment → load-settings → match* to
*load-settings → runPreflight(resolve+match)*. So an out-of-repo / symlink-escape
path with a missing or malformed `settings.yaml` now returned
`SETTINGS_LOAD_ERROR` instead of the fail-closed `INVALID_ARGS` (OUTSIDE_REPO).
The existing tests never combined "bad settings" + "escaping path", so they
couldn't catch it. The impl-stage Codex review did — by diffing against the
*old* ordering, which a plan-stage review structurally cannot see.

## Why
Bundling two side-effecting steps into one helper hides their ordering. A cheap
fail-closed guard (containment) got sequenced *after* a failable config load
(settings), so config failure masked the security rejection.

## Next time
When extracting bundled logic, preserve the SEQUENCE of side-effecting steps,
not just the inputs/outputs — especially cheap fail-closed checks that must run
before any failable I/O. Keep the combiner (`runPreflight`) for direct tests,
but expose the pieces (`resolveRepoRelative` + `matchPreflight`) so callers can
keep "reject escaping path before touching config." And run an *impl-stage*
second opinion on refactors of security-sensitive code even when a plan review
already passed — they catch disjoint bug classes (see
[[codex-multi-pass-catches-different-bug-classes-per-stage]]).
