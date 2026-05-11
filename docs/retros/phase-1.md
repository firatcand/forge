# Phase 1 — Foundations retrospective

> Closed 2026-05-11 · 8 tasks · 8 PRs · session-long sprint (~15h calendar, 2026-05-10 → 2026-05-11)

## Summary

Phase 1 migrated forge off the legacy v0.2.1 bash+JS surface and onto a strict-TypeScript foundation: tsdown dual-build (ESM+CJS) under `dist/`, zod-validated `settings.yaml` and `phases.yaml` schemas with hot-reload loaders, a width-aware chalk+JSONL logger with secret redaction, and a security-hardened worktree manager that auto-copies project meta into new worktrees. The published `bin` now points at `dist/bin/forge.cjs` and the legacy `lib/` + `bin/forge.js` are deleted — v0.3.0 ships foundations-only and the full CLI re-lands incrementally as Phase 2 patches.

## Tasks shipped

| Task | PR | SHA | Estimate | Owner type |
|---|---|---|---|---|
| FD-6 [P1-T01] Bootstrap TS toolchain | #30 | `f04454b` | M | devops-engineer |
| FD-7 [P1-T02] Define settings.yaml zod schema | #31 | `e5be792` | S | db-architect |
| FD-8 [P1-T03] Define phases.yaml zod schema | #32 | `554fbf6` | S | db-architect |
| FD-11 [P1-T06] Build core/logger.ts with chalk + JSONL | #33 | `d931d24` | M | backend-dev |
| FD-13 [P1-T07] Build core/workspace.ts worktree manager | #34 | `c45500b` | M | backend-dev |
| FD-9 [P1-T04] Build core/settings.ts loader + hot-reload | #35 | `e464b8b` | M | backend-dev |
| FD-10 [P1-T05] Build core/phases.ts loader | #36 | `ad1cf31` | S | backend-dev |
| FD-12 [P1-T08] Delete legacy lib/ JS files | #37 | `5714a5e` | S | backend-dev |

## Gate verification

| Criterion | Status | Evidence |
|---|---|---|
| All P0+P1 tasks Done | PASS | 8/8 PRs merged into `main` (final SHA `5714a5e`) |
| `npm run typecheck` | PASS | `tsc --noEmit` exits 0, zero diagnostics |
| `npm run test` | PASS | 203/203 passing via `node --test --import tsx`, duration ~2.0s |
| `npm run build` | PASS | tsdown 0.22.0 emits `dist/index.{mjs,cjs}` + `dist/bin/forge.{mjs,cjs}`, build time 27ms |
| dist <1 MB | PASS | `du -sk dist/` → **80 kB** (CJS 38.7 kB + ESM 35.8 kB) — 1.3% of budget |
| `dist/bin/forge.cjs --version` | PASS | prints `0.2.1` (reads dynamically from package.json; bump to 0.3.0 deferred per follow-up 9) |
| Legacy lib/ deleted | PASS | `ls lib/` → "No such file or directory"; `bin/forge.js` also gone |
| No lib/ imports in src/ | PASS | `grep -rn "lib/" src/` returns empty |

**Deviation logged**: gate criterion 5 says "tsup config produces bin/forge.cjs". Actual bundler is **tsdown** (Rust-based, faster). FD-6 retro `tsdown-engines-floor-binding.md` documents why; `engines.node` was pinned to `^22.18.0 || >=24.0.0` as a consequence.

## Decisions made (with rationale)

- **Bundler: tsdown over tsup (FD-6)** — Rust-based rolldown core, ~10x faster builds. Trade-off: tsdown's own `engines` floor (`^22.18.0 || >=24.0.0`) propagated to forge's `engines.node`. Learning: `tsdown-engines-floor-binding.md`.
- **Fixture-first schema enums over SPEC (FD-8)** — `owner_type` locked to the 8 hyphenated forms in the live `plans/phases.yaml` (e.g. `backend-dev`) rather than SPEC §Data model's 8 short forms (e.g. `backend`). AC1 ("schema validates this very phases.yaml fixture") forced fixture-match. SPEC doc-PR pending (follow-up 1). Same pattern resolved `phase.id` vs `phase.number`, presence of `priority`, `estimate` enum, and `version: 1` literal.
- **Loader-throws + orchestrator-wraps separation (FD-9, FD-10)** — settings/phases loaders throw `ValidationError` with zod issues on bad input; the orchestrator polling loop is responsible for catching and emitting `settings.invalid` events. Aligns with FD-6 silent-no-op retro — loaders fail loud.
- **`workspace.create()` defaults `copyMeta: true` (FD-13)** — every new worktree auto-copies `spec/`, `plans/`, `docs/learnings/`, `CLAUDE.md`, `CRITICAL.md`, `.forge/settings.yaml` from the main worktree. Writes a `copied-from-main.json` manifest. Direct structural fix for the `worktrees-blind-to-gitignored-context` learning. Caller opts out with `{ copyMeta: false }`.
- **Strict-reject (not replace-with-underscore) `sanitizeIssueId` (FD-13)** — overrides SPEC L512. Throws `WorkspaceError` on every invalid input across 11 typed codes (EMPTY, TOO_LONG, PATH_TRAVERSAL, CONTROL_CHAR, INVALID_CHAR, etc.). Lossy sanitization is a silent-data-corruption anti-pattern; FD-6 retro applied to security-perimeter code.
- **`copyMeta` uses `lstatSync` + SYMLINK_REJECTED (FD-13)** — a malicious `CLAUDE.md -> /etc/passwd` in the main worktree no longer gets dereferenced and copied. Found mid-implementation while hardening; was not in the original AC list.
- **Manifest-aware cleanup (FD-13, post-Codex)** — initial `cleanup()` threw `GITIGNORED_LOSS` immediately on any default-created worktree because copyMeta baseline files looked like "loss". Codex P2 caught it; fix reads the manifest and subtracts baseline files before counting real loss.
- **Aggressive cut-the-cord on v0.2.1 CLI (FD-12)** — chose the radical option over the conservative defer-to-Phase-2 alternative. Deleted all 7 `lib/` files + `bin/forge.js` outright. v0.3.0 published CLI is now placeholder + fail-loud for unknown commands (`init`, `orchestrate`, `doctor` all stderr+exit 1). Full CLI re-lands in 0.3.x patches as Phase 2 ships.
- **Harden `src/bin/forge.ts` mid-phase (FD-12)** — FD-6 placeholder silently exited 0 on unknown args. FD-12 PR fixed it: `--version`/`-v` prints version, `--help`/`-h`/no-args prints brief help, anything else stderr+exit 1. Catches the silent-no-op anti-pattern (FD-6 retro) AND a Codex P1 catch on the bare-no-args install regression (commit `3f7550a`).

## Scope changes from original phases.yaml

- **FD-8 (phases schema) enum divergence from SPEC §Data model** — `owner_type`, `priority`, `estimate`, `task_type`, `version`, and `phase.id` vs `phase.number` all resolved fixture-first. SPEC doc-PR pending (follow-up 1).
- **FD-12 (delete legacy lib/) rescope** — originally read as "delete migrated JS files only"; rescoped mid-task to "cut entire v0.2.1 CLI cord" per user decision. Re-pointed `package.json` `bin` to `dist/bin/forge.cjs`, dropped `bin/` and `lib/` from `files`, replaced legacy `source ~/.forge/lib/...` examples in `docs/WORKTREES.md` with raw `git worktree` commands.
- **FD-13 added `copyMeta` defaulting true** — not in original ACs. Added in response to the FD-7 `worktrees-blind-to-gitignored-context` learning during the same task window.
- **`src/bin/forge.ts` hardened twice mid-phase (FD-12)** — once for the FD-6-era silent-exit-0 anti-pattern, then a follow-up commit for a Codex P1 catch on the bare-no-args regression. Net: 6 new CLI behavior tests covering all 3 paths.

## Learnings harvested

All five live at `/Users/firatcandogan/repos/forge/docs/learnings/2026-Q2/`.

1. **`tsdown-engines-floor-binding.md`** (FD-6) — Dev-tool `engines` propagate transitively; pin the bundler before deciding `engines.node`. Run `npm view <dep>@<ver> engines` BEFORE finalizing.
2. **`codex-caught-silent-no-op-placeholder.md`** (FD-6) — "Placeholder OK" in a spec doesn't excuse exit-0-on-anything. Placeholder CLIs must fail loud (stderr + non-zero exit). Acceptance criteria are necessary, not sufficient.
3. **`worktrees-blind-to-gitignored-context.md`** (FD-7) — Gitignored spec/plans/learnings don't propagate into worktrees on creation, AND any gitignored work product written inside a worktree dies on worktree removal. Two structural fixes filed: `/pickup-task` should copy meta (now solved by FD-13's `copyMeta`); `/learn` should target the main worktree's absolute path.
4. **`codex-vs-code-reviewer-find-different-things.md`** (FD-7) — code-reviewer examines diff-against-conventions; Codex examines diff-against-intent. Two-for-two on integration-completeness bugs that ACs missed. Always run `/codex` on foundation / public-API tasks even when no CRITICAL path is touched.
5. **`parallel-tasks-need-barrel-conflict-prediction.md`** (FD-{8,11,13}) — Parallel worktrees with non-overlapping domains still collide on shared barrel files (`src/core/index.ts`). FD-11 and FD-13 both created the file → `add/add` conflict, ~5min serialization on the slower PR. Pre-flight: intersect "Files to change/create" across parallel tasks; nominate one to `add`, others `modify`, or pre-create stubs on main.

## What to do differently in Phase 2

- **Run `/codex` on every foundation / public-API / security-perimeter task.** Three-for-three pattern across Phase 1: FD-6 silent-exit, FD-7 dead-code public-API, FD-13 cleanup-lifecycle bug. ~$0.10/run; code-reviewer alone is insufficient.
- **Predict barrel-file conflicts BEFORE parallel kickoff.** When fanning out N tasks, intersect their "Files to change/create" lists; nominate one task to `add` shared barrels, the others to `modify`. Worth weighing per-feature barrels (`@firatcand/forge/core/logger`) for v0.4 architecture pass.
- **Mandate `/codex` skill update before Phase 2 starts.** Current skill docs still reference the 0.x codex CLI shape; codex 0.129.0 uses `review --base <branch>` and `--base` is mutually exclusive with `[PROMPT]`. Without the update the skill's invocations will fail.
- **Update `/pickup-task` to call `workspace.create({ copyMeta: true })`** instead of falling back to manual `cp`. The infra exists now (FD-13); the skill doesn't use it yet.
- **Update `/implement` precondition.** "Plan must be committed" is unsatisfiable when `plans/tasks/*.plan.md` is gitignored. Either drop the precondition for gitignored paths or move plans outside the repo root (see follow-up 4).
- **Bump `package.json` version to 0.3.0 BEFORE the first Phase 2 PR.** Currently still at 0.2.1; `forge --version` prints 0.2.1 against a non-0.2.1 `bin` surface, which is misleading.

## Open follow-ups (deferred from Phase 1)

1. SPEC doc-PR reconciling phases.yaml field divergences: `owner_type` (hyphenated 8 vs short 8), `priority` (absent in SPEC), `task_type` (6-value enum), `estimate` (S/M/L/XL enum vs free string), `version: 1` literal, `phase.id: "phase-N"` vs `phase.number: int`.
2. Clarify whether `frontend` is a `task_type` (currently only an `owner_type`).
3. Update `/pickup-task` skill to call `workspace.create()` with `copyMeta: true`.
4. Update `/implement` precondition: plan-must-be-committed is unsatisfiable for gitignored plans. Either move plans outside repo or relax the precondition.
5. Update `/codex` skill: codex 0.129.0 CLI uses `review --base <branch>`; `--base` mutually exclusive with `[PROMPT]`.
6. Stale Codex-using skills need manual resync: `draft-design`, `draft-prd`, `forge`, `ingest-spec`.
7. Windows reserved-name filtering for `sanitizeIssueId` (deferred per SPEC §Runtime targeting macOS/Linux).
8. README + CHANGELOG: document v0.3.0 breaking changes (bin path moved to `dist/bin/forge.cjs`; `init`/`orchestrate`/`doctor` fail loud until 0.3.x patches re-land them).
9. Bump `package.json` `version` to 0.3.0 (currently 0.2.1).
10. Per-feature barrels instead of cross-cutting `src/core/index.ts` — architectural fix that eliminates the FD-{11,13} `add/add` conflict class entirely. Defer to v0.4 architecture pass.
11. `/learn` skill should write to the main-worktree absolute path so learnings survive worktree removal (inverse failure documented in FD-7 learning).

## Phase 2 — Core features (next milestone)

Phase 2 unblocks: FD-14 and FD-18 have no dependencies; FD-15/16/17/23 are eligible once FD-14 lands; FD-19/20 chain off the Phase 1 core modules.

| Task | Linear | Deps cleared? | Notes |
|---|---|---|---|
| P2-T01 Tracker interface + base | FD-14 | YES (none) | Eligible immediately |
| P2-T05 Secret-managers (env_file/1pass/doppler) | FD-18 | YES (none) | Eligible immediately; parallel-safe with FD-14 |
| P2-T02 GitHubTracker via gh CLI | FD-15 | After FD-14 | |
| P2-T03 LinearTracker via MCP | FD-16 | After FD-14 | |
| P2-T04 MotionTracker via REST | FD-17 | After FD-14 | |
| P2-T10 Rename /push-to-linear → /push-to-tracker | FD-23 | After FD-14 | |
| P2-T06 Init flow CLI | FD-19 | After FD-9 (DONE), FD-11 (DONE), FD-14 | Unblocks once FD-14 ships |
| P2-T07 Orchestrator dispatcher | FD-20 | After FD-9/10/11/13 (all DONE), FD-14 | Unblocks once FD-14 ships; split into 7a/7b/7c |
| P2-T08 Orchestrator worker (subprocess + phase machine) | FD-21 | After FD-20 | Split into 8a/8b/8c |
| P2-T09 Orchestrator retry queue + signals | FD-22 | After FD-20 | |

**Eligible-for-parallel-pickup right now**: FD-14 + FD-18.

## Surprises during gate verification

- **`node_modules/` was not installed** at gate-check time — `npm run typecheck` initially failed with `sh: tsc: command not found`. Ran `npm install` (73 packages, 1s) and re-ran. Suggests CI or a `postmerge` hook should keep deps fresh, or `phase-gate` should `npm ci` first.
- **`forge --version` prints `0.2.1`**, not 0.3.0. The bin reads dynamically from `package.json` (FD-12 hardening), but `package.json.version` was never bumped during Phase 1. Gate criterion 5 only requires "prints `--version`" — passes literally — but this is shippable-blocker for Phase 3 / v0.3.0 cut. Filed as follow-up 9.
- **`dist/` is 80 kB**, ~1.3% of the 1 MB budget. Headroom is massive even after Phase 2 adds 3 tracker adapters + init flow + orchestrator. Tree-shaking + tsdown's rolldown core paying off.
- **No `lib/` references anywhere in `src/`** — clean cut. Some doc references survive (CRITICAL.md, templates/, agents/code-reviewer.md, docs/PHILOSOPHY.md) but FD-12 PR body confirms these are user-project template paths or hypothetical illustrations, not forge paths.
