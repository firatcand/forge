# FORGE-101 — /amend-roadmap skill + `forge orchestrate amend-roadmap` verb

> Status: implemented (Codex pre-opinion verdict "revise" applied — see §Codex revision) · Attempt 019eb598-9e0c-733f-8215-af561f421c55
>
> **§Codex revision (all 6 findings incorporated):**
> 1. (high) pull can't materialize `added[]` → shipped the `stagedAdditions` option on `runOrchestrateReconcile` + `insertTaskIntoDocument` in the engine; full-document PhasesSchema re-validation before write, fail-closed.
> 2. (high) dep namespace → deps resolved against phases.yaml, relations wired with tracker-INTERNAL ids from a `listAllIssues` index; deps without tracker backing refused.
> 3. (high) adoption safety → exactly-one `forgeTaskId` match + title match required; truncated-view-with-no-match refuses to re-create.
> 4. (med) reconcile invocation → `argv: ['--pull','--no-prune','--json']` + `trackerOverride` + captured streams; world-state verification (task present in re-read phases.yaml), not the `applied` flag.
> 5. (med) id-reservation race → O_EXCL journal create reserves the computed task id; identical-payload EEXIST is an implicit resume, different-payload is JOURNAL_EXISTS.
> 6. (med) relations never wired by createIssue → one independently-resumable journal entry per relation.
> Plus: archive-before-unlink finalize, normalized payload hash, EXPECTED_BANDS registration test, the extra failure-mode tests.
> Architecture decisions confirmed by user 2026-06-11:
> 1. **In v0.4** — stale "deferred to v0.5" language in SPEC/PRD gets amended in this PR.
> 2. **AC5 replaced** — worktree-drift-guard is dead (FORGE-103 canceled); replaced by a lightweight inline drift warning.
> 3. **Tracker-first write path** — verb pushes to tracker, then triggers reconcile-pull to regenerate phases.yaml. Preserves the SPEC §invariant: "phases.yaml is written only by /reconcile --pull". No dual-write rollback dance.

## What ships

| Artifact | Path |
|---|---|
| Verb | `src/cli/orchestrate/amend-roadmap.ts` (band: mutate) |
| Payload schema | `src/schemas/amend-payload.ts` (new) + journal schema `src/schemas/amend-journal.ts` (new) |
| Skill | `skills/amend-roadmap/SKILL.md` |
| Registration | `src/cli/orchestrate/index.ts` VERBS + HELP_ORDER |
| Tests | `test/unit/cli/orchestrate/amend-roadmap.test.ts` |
| Spec sync | `spec/SPEC.md` + `spec/PRD.md` stale-deferral amendments |

## Verb contract

```
forge orchestrate amend-roadmap --payload <file.json> [--resume] [--json]
```

No human prompts (SPEC verb contract). The skill collects fields interactively and writes the payload file.

**Payload schema** (`AmendPayloadSchema`, zod, .strict()):
- `phase`: `phase-\d+(\.\d+)?` — must exist in phases.yaml
- `title` (1–200 chars), `description` (1–10k chars)
- `type` ∈ TASK_TYPES, `priority` ∈ PRIORITIES, `estimate` ∈ {S,M,L} (XL refused — "No XL tasks ship")
- `owner_type` ∈ OWNER_TYPES
- `acceptance`: string[] min 1
- `depends_on`: string[] (task ids OR tracker identifiers; resolved against phases.yaml — every dep must exist; cycle impossible since new task has no dependents)
- `write_globs?`: string[] optional

## Algorithm (journaled, resumable)

Journal at `.forge/orchestrator/global/amend-journal/<task-id>.json`; archived to `completed/<task-id>.json` when done (mirrors apply-decision conventions; `writeAtomic` for every write).

1. **Validate + plan (pure):** load phases.yaml (loader + PhasesSchema), validate payload, resolve `depends_on` → tracker identifiers, compute next task id `P<phase>-T<nn>` (max existing T-number in that phase + 1; collision-checked against ALL task ids). Refuse if phases.yaml has no `source` stanza (tracker not configured) or task id already journaled with a different payload hash.
2. **Write journal** (status: pending steps `create_issue`, `set_relations[]`, `reconcile_pull`) BEFORE any side effect. Payload hash stored so `--resume` with a mutated payload is refused.
3. **create_issue:** `tracker.createIssue({title, body, forgeTaskId, ownerType, acceptance, dependsOn})` → record returned `identifier` + `id` in journal, mark applied.
   **Crash-window idempotency:** on `--resume` with `create_issue` pending, first `listAllIssues()` and search for `forgeTaskId` match — adopt instead of re-creating (no duplicate issues).
4. **set_relations:** for each dep identifier, `tracker.setBlockedBy(newIssueId, blockerId)`; one journal entry per relation (adapters whose `createIssue` already wires deps make this a no-op verify; idempotent re-run safe).
5. **reconcile_pull:** invoke `runOrchestrateReconcile({pull, noPrune: true, json})` programmatically — the single-writer path regenerates phases.yaml from tracker. `--no-prune` because an amend must never delete; unrelated drift is surfaced, not pruned.
6. **Drift warning (AC5 replacement):** read `orchestrator/tasks/*/state.json`, filter ACTIVE_STATES (`claimed|dispatched|running|blocked_on_question|awaiting_respawn`); print a table of active attempts + the hint that the roadmap changed under them (mentioning new task id + its deps). Purely informational, exit code unaffected.
7. **Finalize:** journal `completed_at`, archive to `completed/`. Output `{ok, data:{task_id, tracker_identifier, url, phases_updated}}`.

**Failure at any step:** journal keeps `failed` + error; verb exits non-zero with `--resume` hint. Tracker-first means a half-applied amend is always tracker-ahead — exactly the state /reconcile --pull already heals.

## Skill (skills/amend-roadmap/SKILL.md)

Frontmatter `name/description/tools` per conventions. Flow: collect fields (one round; AskUserQuestion-style prompts listed) → preview computed payload incl. next task id estimate → user confirms → write payload JSON to `/tmp` → run verb `--json` → display result (tracker URL, new id, drift warnings) → on failure show `--resume` invocation. Never edits phases.yaml directly (skill↔verb contract).

## Spec sync (same PR)

- PRD: §Amendments row (line ~16) + line ~71 + §Feature 6 banner (~473-477) + Feature-6 AC list: /amend-roadmap now "ships in v0.4 (FORGE-101)"; drift-guard remains dropped; AC5 reworded to inline drift warning; write path documented as tracker-first.
- SPEC: lines ~19, ~91, ~608, ~1029-1030 same correction; §Module layout gains `amend-roadmap.ts` as shipped. SPEC invariant line ~50 already matches the chosen write path — referenced, not changed.
- Linear FORGE-101 description AC updated (AC5 → drift warning; atomic-dual-write wording → tracker-first) + stale `v0.5` label removed.

## Tests (node --test, FakeTracker pattern from apply-decision.test.ts)

1. Happy path: payload → issue created with correct CreateIssuePayload, relations set, phases.yaml gains task via pull, journal archived, JSON output shape.
2. Next-id generation: gaps + suffixed ids (`T04a`) handled; collision with existing id in another phase refused.
3. Dep validation: unknown dep → INVALID_ARGS, no journal, no tracker call.
4. Resume after createIssue failure: failOnCall(create) → exit non-zero, journal pending; re-run with --resume + tracker now containing the forgeTaskId match → adopts, no duplicate create call.
5. Resume payload-mutation refusal (hash mismatch).
6. XL estimate refused; phase missing refused; no-source-stanza refused.
7. Drift warning: seed two task states (running, blocked_on_question) → output lists both.

## Risks / notes

- `runOrchestrateReconcile` is a verb-calls-verb composition; acceptable (single pull code path) but stdout discipline needed — call with `json:true` and capture, or factor its emit. Will verify during implementation; fallback is extracting the inline pull into an exported `runPull()`.
- Notion/GitHub createIssue parity assumed (base.ts abstract, all adapters implement); covered by FakeTracker in unit tests, real-adapter parity is FORGE-110's E2E concern.
- Lease/claim NOT required by this verb: amending the roadmap is supervisor action, not worker mutation of a claimed task.
