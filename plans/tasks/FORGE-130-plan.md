# FORGE-130 — Unify task-id schema (A+B hybrid) + GitHub id normalization

> Status: draft for Codex pre-opinion · User decision 2026-06-11: **A+B hybrid** — one exported TaskId module imported by every validation site, PLUS boundary normalization in the GitHub adapter (`#42` → `GH-42`, reverse-mapped for native API calls).

## What ships

| Artifact | Change |
|---|---|
| `src/schemas/task-id.ts` (NEW) | The single source of truth: `TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (path-safe: no separators, no `#`, no leading dot/dash, 64-char cap), `TaskIdSchema` (zod), `isValidTaskId()`, plus a doc comment naming every consumer. |
| `src/schemas/cli-args.ts` | `TaskIdSchema` re-exported from task-id.ts (regex widened from Linear-only — phases ids + GH-42 now pass). |
| `src/orchestrator/questions/paths.ts` | `validateIdSegment` delegates to the shared module (dots now allowed). |
| `src/core/workspace.ts` | `ALLOWED_PATTERN` / `sanitizeIssueId` delegate to the shared module (semantics preserved: still throws WorkspaceError codes). |
| `src/cli/orchestrate/gc.ts` | FORGE-116's local dual-regex `isValidTaskId` replaced by the shared import. |
| `src/trackers/github.ts` | Boundary normalization: `toIssue` emits `identifier: 'GH-' + number` (replacing `'#' + number`); a `parseGhIdentifier()` reverse-maps `GH-42`/`#42`/`42` → number for every native call site (claim/comment/updateState/setBlockedBy/updateIssueBody/releaseClaim). Footer/blocker round-trips updated. BACKWARDS-COMPAT: reverse mapping ACCEPTS the legacy `#42` shape so existing phases.yaml bindings keep working; reconcile --pull migrates stored ids forward naturally (identifier now GH-42 → diff updates tracker_issue_id?? — NO: tracker_issue_id matching uses issue.id (number-as-string? verify) AND identifier; seeding both namespaces already handles it — verify in plan review). |
| Tests | task-id module unit tests (accept: FORGE-98, P2.5-T07, GH-42, ETOE-1, notion uuid-with-dashes; reject: `#42`, `../x`, `a/b`, leading dot, >64, empty); GitHub adapter normalization + reverse-map round-trip incl. legacy `#42` acceptance; a GitHub-style id through the full claim→ensure-worktree→dispatch flow (extends the FORGE-110 lifecycle or a focused e2e); existing fixtures pass unchanged. |
| Docs | docs/adapters/github.md identifier note; CHANGELOG Unreleased entry (id normalization, legacy `#` accepted on read). |

## Compat / migration

- Old `.forge/orchestrator/tasks/<id>/` dirs: all previously-VALID ids remain valid under the wider shape — no migration. `#`-shaped ids never worked (they failed all sites), so no adopter state can contain them.
- phases.yaml with `tracker_issue_id: '#42'`-style (hand-entered): reverse map accepts on the adapter side; reconcile --pull rewrites to the canonical identifier over time.

## Out of scope

Notion/Linear emit already-conformant shapes (verify in tests, no changes); schema versioning.

## Pre-opinion deltas (mandatory)

1. The shared module is a PRIMITIVE (regex + predicate + zod schema), and each existing validator WRAPS it preserving its own error codes and intentional policy differences (workspace keeps its specific WorkspaceError codes incl. the `..`/leading-dash rules; questions/paths keeps its call-shape). Drop the false "all previously-valid ids stay valid" claim — document the exact narrowings (workspace `.foo` leading-dot, paths `_foo`/`-foo` leading chars) and verify nothing in the repo or plausible adopter state uses them (UUID run/attempt ids + Notion UUIDs survive; tests prove).
2. GitHub reverse-map list INCLUDES setClaimFence (claim.ts calls claim/releaseClaim/setClaimFence with taskId; github.ts:931 parses numbers there too).
3. parseIssueNumber() accepts `GH-42`, `#42`, `42`, and issue URLs (github.ts:983 is the central place).
4. setBlockedBy's numeric-only blockerId validation (github.ts:779): widen the public adapter input to accept GH-42/#42/42 via the same parse — internal native calls still use numbers.
5. reconcile: identifier change must NOT churn existing adopters — diffPull already seeds both issue.id and identifier into seenTrackerIds; ADD legacy-alias seeding (`#<n>` and bare `<n>` for github) so phases.yaml storing any of `#42`/`42`/`GH-42` binds without false-removal; --push body targeting must resolve through the same alias set. Dedicated tests for all three stored shapes, blocker footer `42` → `GH-42` mapping, and push with tracker_issue_id: GH-42.
6. Error texts mentioning the Linear-only shape updated (claim/ensure-worktree INVALID_ARGS messages).
