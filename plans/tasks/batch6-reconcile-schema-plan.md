# Batch 6 — reconcile/schema (FORGE-127, FORGE-119, FORGE-123)

**Branch:** `feat/hardening-reconcile-schema` · **Worktree:** `.forge/worktrees/FORGE-127`
No user forks — FORGE-123's design is settled in-ticket (provider-native opaque tokens, equality-only; consumer = `reconcile --pull --check` per its own integration AC).

## FORGE-127 — `tracker_url` moves into `source`

- `src/schemas/phases.ts`: add `tracker_url: z.string().min(1).optional()` to SourceSchema (lines 42–49; ticket says `.url()` "or similar" — choose `min(1)`: the template ships `tracker_url: ""` and adopter values may be non-URL; note the choice in the PR). REMOVE top-level `tracker_url` from PhasesSchema (line 124). PhasesSchema is non-strict → legacy top-level keys are silently stripped on parse (back-compat preserved; add a test proving it).
- `src/cli/orchestrate/reconcile.ts`:
  - `resolveSourceForPull` (688–716): also read legacy top-level `tracker_url` from the raw Document (same Scalar/string handling as `tracker_project_id`) AND preserve an existing `source.tracker_url`; carry into the returned Source only when non-empty.
  - `setSourceOnDocument` (721–733): write `source.tracker_url` when present; `doc.deleteIn(['tracker_url'])` for legacy cleanup (idempotent like tracker_project_id).
- Migrations of references (scout-verified, smaller than ticket): `templates/phases.template.yaml` line 2 (`tracker_url: ""` top-level → move into the commented `source:` block), `test/unit/phases.schema.test.ts` 502–510 (flip 'accepts tracker_url at top level' → tolerated-and-stripped + new source.tracker_url accept test), `skills/push-to-tracker/SKILL.md:55` (skill writes it → now under source), `agents/tracker-syncer.md:38` (pre-review major: the delegated /push-to-tracker contract still instructs writing top-level tracker_url AND the long-gone tracker_project_id — fix BOTH to the source-block fields), `docs/trackers/linear.md:131`, `spec/SPEC.md:80` (prose says "tracker_url stays at the top level" — REVERSE it, cite FORGE-127) and `spec/SPEC.md:393` (zod snippet mirror: move the field into the SourceSchema snippet at 337–344). NO changes needed in reconcile test fixtures / plans/phases.yaml / test/fixtures/orchestrator/phases.yaml (verified zero occurrences).
- Tests: legacy top-level migration on --pull (unit, asserts deleteIn + source.tracker_url written); source.tracker_url round-trips through a pull/push cycle; legacy file with top-level key still parses.

## FORGE-119 — `reconcile --task <id>` filter

- `parseReconcileArgv` (310–351): add value flag `--task <id>` (consume next argv token; error `missing value for --task` if absent).
- Thin post-diff filter: after `diffPull` (558) / `diffPush`, keep only entries whose `task_id` matches OR whose `tracker_issue_id` equals the phases-side mapping for that task (PullPlan: filter updated/removed by task_id, added/unmanaged by tracker_issue_id when the id resolves to one; PushPlan: bodies/skipped by task_id). Filtering happens before plan emission, apply, and prune logic — a scoped run must never prune/apply outside the scope.
- Unknown id: `INVALID_ARGS` `unknown task id: <id>` at **exit 3** (pre-review major: exit 1 is reserved for PRUNE_PENDING in this verb; 3 is the existing INVALID_ARGS code) when the id is not in phases.yaml AND no tracker result carries it as tracker_issue_id.
- Dry-run preview surfaces `scoped to <id> only` (both human + a `scoped_to` field in --json plan output).
- FLAG_DECLS honesty (batch-5 contract): add `--task <id>` and `--check` to the reconcile entry in src/cli/orchestrate/index.ts FLAG_DECLS — and remove the pre-existing DUPLICATE JSON_FLAG in that entry (pre-review minor).
- `spec/ORCHESTRATOR.md` reconcile synopsis (260): re-add `[--task <task-id>]`, and fix the PRE-EXISTING staleness by also documenting `[--confirm-prune|--no-prune]` (implemented but undocumented) + FORGE-123's `[--check]`.
- Tests: unit (parse + filter both directions + unknown-id error) and integration (both directions scoped; scoped pull does not touch out-of-scope tasks).

## FORGE-123 — `Tracker.getCurrentRevision()` + `--pull --check`

- `src/trackers/base.ts` (24–78): add `getCurrentRevision(): Promise<string>` to the Tracker interface. Token is OPAQUE — equality only; document that in the interface jsdoc.
- Adapters (each via its existing DI seam; mechanics are implementer's choice within these intents):
  - Linear (LinearSdkLike seam): max `updatedAt` over the project/team's issues — one SDK query, top-1 ordered by updatedAt desc (extend LinearSdkLike with a narrow method; update wrapLinearClient + MockLinearSdk).
  - GitHub (GhExec seam): cheapest provider-native signal via `gh` — e.g. latest updated issue (`gh issue list --state all --search "sort:updated-desc" --limit 1 --json updatedAt` or an ETag/Last-Modified from `gh api -i`); pick one, make the mock deterministic.
  - Notion (NtnExec seam): `last_edited_time` from `ntn api v1/databases/<id>` (same call shape resolveDataSourceId already uses).
  - Prefix tokens with a provider tag (e.g. `linear:<iso>`) so cross-provider equality is never accidentally true.
- `SourceSchema`: add `tracker_revision: z.string().min(1).optional()` (additive; `.strict()` stays — lands alongside FORGE-127's tracker_url in the same edit).
- `reconcile --pull`: stamp `source.tracker_revision = await tracker.getCurrentRevision()` in resolveSourceForPull/setSourceOnDocument alongside the other fields (best-effort: if getCurrentRevision throws, warn on stderr and stamp nothing — a flaky revision probe must not fail a pull).
- `--check` (new boolean on parseReconcileArgv, only valid with `--pull`): before `tracker.listAllIssues()` (line 540), call `getCurrentRevision()`:
  - **match** → REFRESH the freshness stamp (pre-review major: a verified-fresh snapshot must not keep tripping staleness warnings): write `source.synced_at` (now), recomputed `spec_revision`, and the (unchanged) `tracker_revision` via the existing setSourceOnDocument + phases-write-lock save path, then emit ok `{ check: 'match', message: 'no upstream changes' }` exit 0 — issue list NEVER fetched.
  - **mismatch or no stored revision** → proceed with the normal pull (stamps fresh revision as part of it).
  - **probe failure** (getCurrentRevision throws; pre-review major): warn on stderr and FALL BACK to a full pull — a flaky revision probe must never fail or wedge a pull. Dedicated test for this path.
- SPEC.md:78 forward-reference prose: update to "shipped in FORGE-123" phrasing; SPEC source-block snippet (54–60) gains tracker_revision + tracker_url lines.
- Tests: per-adapter unit tests via mock seams (token shape + the exact query issued); integration: `--pull --check` on match performs ZERO listAllIssues calls (count on the mock) and exits 0; mismatch falls through to a full pull; missing stored revision falls through.

## Gates

1. typecheck · 2. full suite 0 fail (baseline 2013/1987/26; expect +~15) · 3. lint · 4. build + doctor spec-code `drift: []`
5. Manual: `reconcile --help` shows the new flags (FLAG_DECLS honesty); a /tmp fixture pull with legacy top-level tracker_url migrates it under source.
6. Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8.

## Commit skeleton

```
feat(reconcile): schema + scoping + live drift batch — FORGE-127/119/123

FORGE-127: tracker_url moves into source block (legacy top-level migrated
  on --pull, silently stripped on parse); template/skill/docs/SPEC updated
FORGE-119: reconcile --task <id> scopes pull/push plans (INVALID_ARGS on
  unknown id; scoped runs never apply/prune outside scope)
FORGE-123: Tracker.getCurrentRevision() (opaque provider-native tokens,
  equality only) stamped as source.tracker_revision on pull;
  --pull --check short-circuits without fetching when revisions match
```
