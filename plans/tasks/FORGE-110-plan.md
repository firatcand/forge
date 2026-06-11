# FORGE-110 — E2E fixtures + deterministic lifecycle drive-through + CI

> Status: implementing (Codex pre-opinion "revise" applied) · Attempt 019eb6e5-4403-700a-990f-ab31c8b86f3f
>
> **Pre-opinion deltas (mandatory):**
> 1. EXTEND, don't duplicate: test/integration/cli/orchestrate/{e2e,apply-decision.e2e,reconcile.e2e}.test.ts already cover verb-chain, apply-resume, and reconcile mechanics. The new file adds ONLY: per-fixture parametrization, the CAS race with a scripted first-wins tracker, amend-roadmap drive (while an attempt is still RUNNING — ready_for_review is NOT in ACTIVE_STATES, so the drift-warning assertion must run before `complete`), the full update-spec closed loop ON the fixtures, the migrate smoke, and fixture sanity. Where an existing e2e file covers a scenario generically, the new file references it rather than re-testing.
> 2. Seam reality: the FACTORY cannot inject transports — verbs taking trackerOverride get real GitHubTracker/NotionTracker instances constructed with scripted GhExec/NtnExec; settings-built verbs (claim/dispatch/…) run under FORGE_NOOP_TRACKER=1, EXCEPT the CAS race which uses whatever override surface claim exposes (verify; if none, race at the lease layer + a tracker-mock claim() unit seam — name the exact mechanism in code comments). No Linear FakeTracker fixture exists — define the in-memory one locally (apply-decision.test.ts pattern) + reuse MockServerState response builders.
> 3. CI: matrix = {node 22/24} × {github,linear,notion} = 6 cells; the new file is gated behind FORGE_E2E_FIXTURE=<name> and SELF-SKIPS under plain `npm test` (no double-run). Wall target <60s per cell.
> 4. Determinism = schema/consistency assertions + normalized ids/timestamps (claim/attempt UUIDs, lease expiries, synced_at are dynamic by design; reconcile ALWAYS bumps synced_at). Never byte-compare regenerated files.
> 5. AC rewrite wording: the harness proves "programmatic verb composition with injected trackers over frozen fixtures" — not skill execution; manual checklist covers skills.
> 6. scripts/test-pack.mjs FORBIDDEN_PREFIXES += 'examples/'.
> User decisions 2026-06-11 (Confusion Protocol — ticket ACs predate the §21 pivot):
> 1. **Drift-event AC → kept as v0.5-deferred note** in the ticket (machinery canceled in v0.4; SPEC says so at 20/46/964).
> 2. **Path C: fully deterministic harness, NO AI lane.** Real-LLM session runs (skills driven by Claude/Codex) become a documented MANUAL pre-release checklist; nothing in CI calls an LLM.
> 3. **CI matrix = 3 tracker fixtures × Node 22/24** (deterministic). Claude+Codex live = manual checklist; Cursor+Gemini = verified-deferred (no Cursor adapter; FORGE-160).

## What ships

| Artifact | Content |
|---|---|
| `examples/greenfield-github/`, `-linear/`, `-notion/` | Frozen mini-projects, one per tracker: `.forge/settings.yaml` (tracker-typed; notion = database_id only), `plans/phases.yaml` (deterministic: 2 phases × 3 tasks, fixed ids, `source` stanza with fixed synced_at), `spec/` (compact BRIEF/PRD/SPEC/DESIGN stubs — SPEC carries two real headings so §-anchors resolve), `templates/adr.template.md`, `spec/decisions/` (empty + .gitkeep), `CLAUDE.md` stub. Doubles as living docs (`examples/README.md` explains each). |
| `test/integration/cli/orchestrate/lifecycle.e2e.test.ts` | The drive-through (below). Deterministic — NO env gating; runs in CI on every PR via the existing `npm test` glob. |
| `.github/workflows/ci.yml` | New visible `e2e` job (matrix Node 22/24) running just the lifecycle file — distinct red/green signal from unit `test`. Unit job unchanged (the glob also covers it; the dedicated job is the named AC artifact). |
| `docs/release-checklist.md` | The manual pre-release ritual replacing the AI lane: live Claude+Codex skill-driven greenfield run, live tracker integration suites (existing FORGE_E2E_* gates), version/publish steps. Linked from CONTRIBUTING/README. |
| Linear FORGE-110 | AC list updated: drift AC marked deferred-v0.5; 'driven by /forge orchestrate' AC reworded to the verb-layer drive-through + manual checklist split; Cursor+Gemini verified-deferred. |

## The drive-through (per fixture: copy `examples/<fixture>` → temp dir, `git init`, commit)

Per-tracker transport seams: github → scripted `GhExec` mock; notion → scripted `NtnExec` mock (reuse unit fixture builders); linear → in-memory `FakeTracker` via `trackerOverride`. State-machine verbs (claim/dispatch/heartbeat/complete) run under `FORGE_NOOP_TRACKER=1` where the tracker is irrelevant to the assertion, and via injected mocks where it isn't.

1. **Fixture sanity** — phases.yaml parses + validates (PhasesSchema, DAG), settings parse, spec anchors resolve via parseSectionRef.
2. **Lifecycle chain** — `run start` → `phases --ready` surfaces the dep-free tasks → `claim` (tracker mock asserts CAS call) → `ensure-worktree` → `dispatch` → first `heartbeat` (dispatched→running) → `question` + `answer` round-trip → `complete` (verdict fixture, running→ready_for_review→…). Assert state.json transitions + lease lifecycle + events.jsonl shape after every verb (the exact integration seams unit tests fake).
3. **Multi-main CAS race** — two concurrent `claim` calls, different run ids, tracker mock scripted first-wins: exactly one `ok:true`; loser gets ALREADY_CLAIMED; lease + claim-history consistent.
4. **Mid-flight /update-spec closed loop** — author an accepted ADR + payload-complete journal in the fixture (the FORGE-93 worked-example shape) → `apply-decision --dry-run` plan matches → apply with tracker mock: SPEC/PRD sections rewritten between forge:adr-section markers, phases task field amended, tracker body call recorded, INDEX.md line appended, commit-msg written, ADR deleted, journal archived.
5. **`--resume` crash recovery** — same scenario, tracker mock `failOnCall` mid-tracker-push → verb exits retriable, journal shows applied/failed split → re-run `--resume` with healed mock → completes; no duplicate SPEC writes (markers idempotent).
6. **amend-roadmap mid-flight** — payload fixture → tracker-first create + relations on the mock → staged addition materializes the task into phases.yaml → drift warning lists the active attempt from step 2.
7. **reconcile --pull drift** — mock tracker returns a retitled issue + changed blockers → phases.yaml updated comment-preservingly; `--push` writes bodies via the mock (linear/github/notion all capable post-FORGE-117).
8. **migrate smoke** — copy the github fixture, de-modernize it (strip settings blocks, add @inherit + /push-to-linear) → `forge migrate --yes` → re-run detectors clean. (Cheap end-cap proving FORGE-109 composes with real fixture trees.)

Assertions favor world-state (files, state.json, mock call logs) over stdout. Each fixture's run is independent (temp dirs); total target wall time < 60s.

## Explicitly out (per decisions)

- No LLM host invocation anywhere in CI. The skill layer's correctness remains covered by its contract tests (FORGE-93 pattern) + the manual checklist.
- No drift-event scenario (v0.5; ticket note).
- No Cursor/Gemini jobs (verified-deferred; FORGE-160 will add the adapter first).

## Risks / notes

- The CLI verbs write to `<cwd>/.forge` — the temp-dir copies isolate fully (no contamination of the repo's own orchestrator state); assert that.
- Verbs print freshness/warnings to stderr — harness captures, asserts envelopes only on stdout (regression guard for the single-envelope discipline).
- Reuse, don't fork, the unit fixture builders (notion-responses.ts etc.) — export them where needed instead of duplicating.
- package size guardrail: examples/ must be excluded from the npm pack `files` allowlist (verify package.json files field).

## As-built deltas (post-review)

- **FORGE_E2E_FIXTURE env gating** — plan body stated "Deterministic — NO env gating; runs in CI on every PR via the existing `npm test` glob." Shipped with gating: the file self-skips under plain `npm test` unless `FORGE_E2E_FIXTURE=github|linear|notion` is set. This was the correct call per delta-3 (CI matrix job runs it explicitly; the unit glob must not double-run the heavier scenarios on every PR).
- **Tracker verbs driven via in-memory per-tracker-typed Tracker overrides** — plan body said "github → scripted GhExec mock; notion → scripted NtnExec mock (reuse unit fixture builders)." Shipped with a locally-defined generic `makeFakeTracker(type, initial)` for all three fixtures. Transport argv parsing (GhExec/NtnExec) is already covered exhaustively by the adapter unit suites (test/unit/trackers + test/fixtures/trackers/*); re-driving it here would be duplication per plan delta-2.
- **Lifecycle chain exercised to RUNNING, not full completion in one pass** — plan body described driving the chain through `complete` (running→ready_for_review→…). Shipped stopping at RUNNING + question/answer round-trip; `complete` is not invoked in the lifecycle test. This satisfies plan delta-1: amend-roadmap's drift-warning assertion must observe an ACTIVE attempt (ready_for_review is NOT in ACTIVE_STATES), so the chain stops before `complete`. amend-roadmap now runs immediately after the first heartbeat (state === 'running') and BEFORE the question verb; the question/answer round-trip follows.
- **migrate smoke runs on the github fixture only** — plan body listed it as scenario 8 without a fixture restriction. Shipped with an explicit `if (FIXTURE !== 'github') return t.skip(...)` guard. The migrate detectors are tracker-agnostic; running the smoke once (github) is sufficient and keeps the other cells fast.
- **World-state + envelope assertions with normalized dynamic fields** — plan delta-4 stated never byte-compare regenerated files. Implemented: claim/attempt UUIDs matched against a UUIDv7 regex, lease expiries and synced_at not compared byte-for-byte, envelope assertions check schema/consistency fields (ok, error.code, data shape) not raw JSON strings.
