# Forge Audit & Fix Guide

> **Purpose:** A single, self-contained, agent-actionable guide to fix every issue found in the 2026-06-01 repo audit. Each item below is a "fix card" — symptom, verified root cause (with `file:line`), exact fix, required test, and guardrails. A coding agent should be able to execute any card without reading anything else.
>
> **Date:** 2026-06-01 · **Branch:** `main` @ `9a8e79d` · **Repo:** github.com/firatcand/forge (Forge CLI framework, TypeScript)
>
> **Provenance — two-model convergence:** Two independent audit passes produced this guide. Pass 1: static analysis (knip + ts-prune baseline → 6 parallel sub-agent readers → self-verification). Pass 2 (Codex / gpt-5.5): full validation gate (`typecheck`/`build`/`test`/`test:pack` — all pass, 1,724 passing / 19 skipped) + orchestrator-log review + GitHub-issue cross-reference. The two passes **converged on the same 2 bugs, same dead-code list, and same top simplifications, refuting none** — per the repo's own `two-model-convergence-as-confidence-signal` learning, treat these as high-confidence.

---

## How to use this guide

1. **Work in a worktree**, branch `feat/{TICKET-ID}-audit-fixes` (or per-card branches). Never edit on `main`.
2. **Validation gate** (must stay green after every card):
   ```
   npm run typecheck            # tsc --noEmit
   npm run build                # tsdown → ESM + CJS
   npm test                     # node --test --import tsx 'test/**/*.test.ts'
   npm run test:pack            # npm-pack-gate
   node dist/bin/forge.cjs --version   # smoke the built artifact (tests via tsx miss bundler-only breaks)
   ```
   Run `npm test` **outside any sandbox** — `tsx` cannot open its IPC pipe under a restricted sandbox, which false-fails subprocess tests.
3. **Test-or-die:** every bug card ships a failing-first regression test in the same PR.
4. **Respect the DO-NOT-SIMPLIFY guardrails** in §3 — several look like duplication but are intentionally divergent.

## Priority / fix order

| Order | Card | Why first | Severity |
|------|------|-----------|----------|
| 1 | **B2** stale-dist e2e test | Restores CI signal — until fixed, every other fix is validated against possibly-stale `dist` | medium (CI integrity) |
| 2 | **B1** Linear claim retry (+ classifier guard) | Product correctness — claim resilience under contention | medium |
| 3 | **A1 / #256** missing `lint` script | Adopter CI breakage; cheap | low–med |
| 4 | **A2 / #243** question-budget wiring | Workers silently miss soft-cap warnings | medium |
| 5 | **A3 / #209** GC executors | Detected divergences can't be repaired | medium |
| 6 | **D1–D7** dead code | Zero-risk removal; do after bugs so diffs stay clean | nil-risk |
| 7 | **S1–S5** simplification | Quality; small batches; defer S2 | nil-behavior |

---

## §1 — BUGS (urgent, confirmed, untracked)

Both are recurrences of logged learnings that crept back into the code. Both verified twice against live code.

### B1 — Linear claim path loses transient-failure retries

- **Severity:** medium · **Recurrence of:** FORGE-76 `with-retry-requires-tracker-error-instances`
- **Symptom:** A transient `@linear/sdk` failure (ECONNRESET / 503 / timeout) during a contended claim becomes an immediate `version_conflict`/claim failure instead of being retried — exactly the read→recheck race window where resilience matters under parallel dispatch.

**Root cause (verified):**
- `src/trackers/linear.ts:604` (`claim.read`) and `:690` (`claim.recheck`) pass `() => client.issue(issueId)` **raw** into `withRetry`.
- `wrapLinearClient.issue` (`src/trackers/linear.ts:268`) does **not** normalize: `async issue(id) { const issue = await client.issue(id); return flattenIssue(issue); }` — no `try/catch`, no `normalizeError`.
- `withRetry`'s default predicate `defaultIsRetriable` (`src/trackers/base.ts:215`) is `err instanceof TrackerError && isRetriableTrackerErrorCode(err.code)`. A raw SDK error is **not** a `TrackerError` → predicate returns false → **zero retries**.
- **Parity proof:** GitHub's `claim.read` (`src/trackers/github.ts:378`) wraps `this.readIssueLabels(number)`, which normalizes caught errors to `TrackerError` (`src/trackers/github.ts:1022`) → GitHub retries correctly. Linear's non-retry reads (`linear.ts:977,1042,1098`) normalize too; only the two `claim` retry callbacks were left raw.

**Fix (two parts — the second is mandatory, do not skip):**
1. Normalize inside `wrapLinearClient.issue` (`linear.ts:268`): wrap the call so a thrown SDK error becomes a `TrackerError` via the existing classification before it reaches `withRetry`. Every caller inherits the fix.
2. **⚠ Guard against a NOT_FOUND regression:** the catch sites at `linear.ts:609` and `:695` currently call `classifyLinearError(err)` on the (previously raw) error to decide `NOT_FOUND → version_conflict`. `classifyLinearError` does **not** read `TrackerError.code`, so a normalized `TrackerError('NOT_FOUND')` whose message lacks "not found" would fall through to `UNKNOWN` and skip the intended `version_conflict` return. **Therefore also** teach `classifyLinearError` to honor `err instanceof TrackerError` (return `{ code: err.code, details: err.details }`), **or** branch on `err instanceof TrackerError` first at both catch sites. (Both audit passes independently flagged this.)

**Required test:** a transient-then-success stub for `client.issue` proving **call count > 1** on `claim.read` and on `claim.recheck` (per `retry-test-must-prove-calls-greater-than-one`). Plus a test that a `NOT_FOUND` on initial read still returns `{ ok: false, reason: 'version_conflict' }`.

**Done-when:** transient claim reads retry; NOT_FOUND handling unchanged; full gate green.

---

### B2 — Orchestrate e2e test validates stale `dist`

- **Severity:** medium (false-green CI) · **Recurrence of:** FORGE-98 `integration-tests-against-dist-false-pass`
- **Symptom:** After the first build, the lifecycle e2e silently tests **stale compiled code** — adversarial regressions in current TypeScript source pass anyway.

**Root cause (verified):**
- `test/integration/cli/orchestrate/e2e.test.ts:30` rebuilds **only** `if (!existsSync(distBin))`.
- `test/integration/cli/orchestrate/e2e.test.ts:52` then spawns `node dist/bin/forge.cjs`.
- This test drives the full claim/dispatch/complete lifecycle (highest-value surface) and is the **lone holdout**. **6 integration tests + 1 unit test** already use the shared helper: `init.e2e`, `upgrade.e2e`, `eject.e2e`, `spec-diff.e2e`, `dispatch-skill-flow`, `init.perf`, and `test/unit/bin/forge.test.ts:6`. *(Correction to an earlier draft that said "7 sibling integration tests" — it's 6 integration + 1 unit.)*

**Fix:** migrate to `test/helpers/spawn-tsx.ts`. Delete the `before()` build hook + `distBin`, and spawn `tsxBin` **directly** (matching the working sibling at `test/integration/cli/orchestrate/dispatch-skill-flow.test.ts:54`):
```ts
import { spawnSync } from 'node:child_process';
import { tsxBin, forgeBinEntry as entry } from '../../../helpers/spawn-tsx.ts';
// spawn current source, not stale dist:
const res = spawnSync(tsxBin, [entry, ...args, '--json'], { cwd, env, encoding: 'utf8' });
```
> ⚠ **Do NOT** spawn `process.execPath` with `['--import','tsx', ...]` — from this test's temp `cwd`, Node can't resolve `tsx`. Spawn `tsxBin` (the `createRequire`-resolved `tsx/cli` path) as the executable. The helper resolves `src/bin/forge.ts` (`spawn-tsx.ts:7`) and `tsx/cli` (`spawn-tsx.ts:12`) so it works from worktrees. Keep dist execution **only** in an explicit build-smoke test that gates `npm run build`.

**Required test:** the migrated e2e itself is the test; add an assertion (or comment) documenting that it runs source, not dist. Optionally add a guard that fails if `distBin` is spawned by lifecycle tests.

**Done-when:** orchestrate e2e runs `src/` via tsx; gate green.

---

## §2 — TRACKED BACKLOG (already filed — cross-referenced here so an agent can pick them up)

These are **not new** — they have open GitHub issues. Included with `file:line` so they're actionable from this guide.

### A1 / #256 — `npm run lint` referenced but no script exists
- **Evidence:** `CLAUDE.md:30` (`Lint: npm run lint`); `templates/CLAUDE.project.template.md:28`, `templates/AGENTS.project.template.md:22`, `templates/GEMINI.project.template.md:22`; `templates/github-workflows/test.yml:17` runs `npm run lint`; `package.json` has only `lint:test-helpers`. `npm run lint` → `Missing script: "lint"`.
- **Fix options:** (a) add a real `lint` script + config, or (b) replace `npm run lint` references with `typecheck` if that's the intended static gate. **Pick one consistently across package.json + all 3 templates + the workflow template.**

### A2 / #243 — question-budget soft-cap warning never reaches workers
- **Nuance (verified):** the machinery is fully built in the **library** layer but the **CLI verb never feeds it**:
  - `src/orchestrator/decision-classifier.ts:108` `buildSoftCapWarning()`, `:182` produces it; `resolveBudget`/`computeTaskBudget` exist.
  - `src/orchestrator/render-worker-prompt.ts:60` has `softCapWarning?` on `WorkerPromptContext`, rendered at `:153` into `{{BUDGET_WARNING}}`.
  - `templates/worker-prompt.template.md:252` has the slot.
  - **Gap:** `src/cli/orchestrate/render-worker-prompt.ts:235` builds the `ctx` literal (through `:247`) **without** `softCapWarning`; `skills/forge-orchestrate/SKILL.md:97` calls `render-worker-prompt` without budget flags. → workers always render "(none)".
- **Fix:** at dispatch/render, resolve task `question_budget` over `settings.agents.question_budget`, compute current count, inject `buildSoftCapWarning(...)` into the CLI `ctx`, and pass resolved budget flags to worker question commands.

### A3 / #209 — GC planner detects divergences the executor can't repair
- **Evidence:** `src/cli/orchestrate/gc.ts:86` documents 5 deferred actions (`mark_terminal`, `mark_abandoned`, `mark_unclaimed`, `reverify_verdict`, `prune_branch`); `gc.ts:636` reports them via stderr without mutating. `src/schemas/task-state.ts:38` has `failure_reason` but no `last_failed_at`.
- **Related open issues:** #208 (`last_failed_at` + writer → activate retry-eligibility filter), #207 (emit `DECISION_KEY_EXHAUSTED` from the max-attempts site).
- **Fix:** implement the 5 executor paths; add `last_failed_at` (#208) to unblock retry-eligibility.

---

## §3 — DEAD CODE (verified zero usage — safe deletions)

All confirmed by `grep -rn` across `src test scripts`: only the definition line matches. Delete, then run the gate.

| # | Item | Location | Note |
|---|------|----------|------|
| D1 | `fs-extra` dependency | `package.json:37` | No source/test/script imports or runtime use (repo uses `node:fs`/`execa`); only `package-lock.json` + docs prose mention it. Remove the package entry + `npm install` to update the lockfile. |
| D2 | `IssueStateSchema` (`:3`), `IssueSchema` (`:12`), `CreateIssuePayloadSchema` (`:22`), `ClaimResultSchema` (`:33`) | `src/schemas/trackers.ts:3–43` | Not re-exported by `schemas/index.ts:78`; importers `github.ts:5`/`notion.ts:4` pull only the `Gh*`/`Notion*` schemas (those are **live — keep**). `IssueSchema` is **stale/incomplete** vs canonical `Issue` (`src/trackers/types.ts:17`, missing claim-fence fields) — strengthens deletion. |
| D3 | `registerVerb` | `src/cli/orchestrate/index.ts:308` | Never wired; verbs register inline in the `VERBS` map. |
| D4 | `existingStaticPaths` | `src/cli/manifest.ts:55` | Defined, never called. |
| D5 | `QuestionIdSchema` | `src/schemas/cli-args.ts:31` | Composes nothing, validates nothing. |
| D6 | `extractCreatedPage` (`:1144`), `export { z }` (`:1204`) | `src/trackers/notion.ts` | Both unconsumed; the `z` re-export's promised test consumer doesn't exist. |
| D7 | `parseForgeFooters`/`serializeWithForgeFooters` re-export | `src/trackers/github.ts:214` | Redundant — canonical exports flow via `src/trackers/index.ts:28-29` + `src/trackers/footers.ts`. Delete the re-export line + stale comment. |

**Over-exported (optional cleanup — used in-module, `export` keyword redundant; no behavior change):** `manifestPath` (manifest.ts:34), `substitute` (init/templates.ts:30), `validateNonEmpty` (init/prompts.ts:31), `slugify` (preflight.ts:46), `PHASES_YAML_PATHS` (phases.ts:78), `TRACKER_TYPES`/`SourceSchema` (schemas/phases.ts:31,39), `FAILURE_REASONS` (task-state.ts:23), `deriveStateFromLinearIssue`/`toIssue`/`LINEAR_WORKFLOW_STATES_LIMIT` (linear.ts), the `linear.ts:1494–1500` tail `export {}` block, and the redundant barrel re-export lines in `harnesses/index.ts:3–12` + `cli/upgrade/index.ts:10–47`. **Keep** `__smFsForTesting`/`__eventsFsForTesting` (deliberate fs test-seams).

---

## §4 — SIMPLIFICATION (identical behavior, ~250–400 LOC; small batches)

### Safe, high-value (endorsed by both passes)
- **S1 · `readLease` duplicated byte-identical in 6 files** → extract `src/cli/orchestrate/lease-io.ts`. Sites: `complete.ts:256`, `heartbeat.ts:168`, `dispatch.ts:211`, `question-write.ts:463`, `cancel.ts:225`, `event.ts:105`. Reuse `leaseFilePath()` from `orchestrator/questions/paths.ts`. Bundle: the **17×** `{ run_id, claim_id, generation }` projection (`callerFromLease`) and **8×** `parseFlag(rest,'task') ?? rest.find(a=>!a.startsWith('--')) ?? ''` (`taskIdFrom(rest)` in `flags.ts` — **not** interchangeable with `firstPositional`, which skips a separated flag's value). ~150 LOC.
- **S3 · `dashboard.ts:54,137` reinvents** `resolvePhasesYaml`/`PHASES_YAML_PATHS` byte-identical to `core/phases.ts:82,78` (already imports `loadPhases` from there). Add to the import, delete copies. ~14 LOC.
- **S4 · Tracker helper triplication** → hoist to `base.ts`: `isTransientCode` (`github:1119`/`notion:1133`/`linear:240`), `tiebreakWinner` (`github:1128`/`linear:249`), `errToString`/`errMessage` (`github:1138`/`notion:1139`/`linear:1486`), `parseRetryAfter` (`github:206`/`linear:233`). Task-id regex `/^P\d+(\.\d+)?-T\d+[a-z]?$/` duplicated `phases.ts:55`↔`apply-journal.ts:45` → shared `TASK_ID_REGEX`. ~60 LOC.
- **S5 · `e instanceof Error ? e.message : String(e)`** appears **92× in `src/`** (87 in `src/cli/`) → one `errorMessage()` util. **Preserve all surrounding `instanceof OrchestratorError/TrackerError` code-mapping** — only collapse the message-extraction half. ~40–60 LOC.

### Safe, medium-value (from pass 1; verify divergence before merging)
- **S-orch · in-`leases.ts` lease-ownership comparison repeated** → pure `leaseIdentityMatches()` predicate. Sites: `leases.ts:596,643,701,828`. **⚠ The admin-release checks at `leases.ts:986` and `:1080` are 4-field (they add `expires_at`)** — do **not** collapse those into the 3-field predicate. **Keep** the cross-file `state-machine.ts:400` TWIN intentionally duplicated (documented circular-dep avoidance). ~40 LOC.
- **S-q · `questions/lookup.ts` duplication** — `findOpen…`/`findAnswered…ByDecisionKey` (`lookup.ts:213` / `:277`) are near-identical, and four functions re-inline the attempt-walk + dir joins that `questions/paths.ts:65–79` already exports as `questionsDir()`/`answersDir()`. Parameterize one `scanAttemptsByDecisionKey(...)` helper and use the existing path helpers. ~90 LOC.
- **Tier-2 mechanical (opportunistic, fold into PRs already touching these files):** `fail(err instanceof OrchestratorError ? err.code : 'IO_ERROR', …)` ~19×; tracker-error derivation in `src/cli/orchestrate/reconcile.ts:221,283,437,465`; Notion `readRichText`/`readTitle` near-dup (`src/trackers/notion.ts:246–260`); upgrade agent-flag validation 4 blocks (`src/bin/forge.ts:178–199` — **preflight-glob path, verify before touching**); `gc.ts` `split('/').pop()!` → `path.basename` (`src/cli/orchestrate/gc.ts:473,475,550,621`).

### Needs care
- **S2 · Triplicated atomic-write plumbing** (`leases.ts:89–170`, `state-machine.ts:91–106,276–342`, `questions/writer.ts:60–192`). **Extract ONLY the plumbing** (`tempName`, `writeTempFile` = openSync'wx'→writeSync-loop→fsync→close, and the EEXIST/EPERM/ENOTSUP mapping) via an error-factory callback. **⚠ DO NOT unify placement semantics — they differ by design:** acquire = hard-link never-overwrite (`leases.ts:174`); heartbeat/steal = unlink→link with verify-after-write (`leases.ts:680`); state = rename-overwrite after CAS (`state-machine.ts:258`); questions = link-never-overwrite (`writer.ts:164`). Leave the best-effort `writeStateUnclaimed` (`leases.ts:413`) inline. **Defer until it has its own focused test plan** (both passes agree). ~180 LOC potential.

### ⛔ DO-NOT-SIMPLIFY (look like duplication; are intentionally divergent — flagged so a future pass doesn't break them)
- Two glob→regex compilers: `orchestrator/glob-match.ts:33` (segment-aware `**`, FORGE-97 boundary fix) vs `overlap.ts:70` (`**`→`.*`). **Different semantics.**
- Three `classify*Error` adapters (linear/github/notion) — map genuinely different provider surfaces; branch ordering is load-bearing.
- `status.ts:112/142` double size-cap — deliberate TOCTOU defense (file can grow between stat and read).
- `logger.ts:234` `redact` — explicit by design to aid the secrets-redaction audit.

---

## §5 — Corpus health (do NOT re-fix — already resolved)

The full ~100-learning corpus was replayed against current code. **~40 concrete code-defect invariants have their fix still in place at every site** — do not "re-fix" these; they're correct: TOCTOU stat→read wrapping, link-vs-rename never-overwrite, utf8 byte caps (not utf16), opendir cap-guarded walks, sentinel-last crash recovery, `.strict()` exclusion guards, `gh --reason 'not planned'` CLI spelling, chalk v5 single-unwrap, lease identity tuples (claim_id+generation+owner_run_id, +expires_at on admin release), drift-regex non-self-matching, validator/preserver footer-regex parity, `rmdirSync` ENOTEMPTY guard. The remaining ~45 learnings are process/review/workflow meta with no code invariant. The orchestrator log (`.forge/logs/orchestrator.jsonl`, 1,418 events) shows only **expected** init/refusal `errorBlock` titles — e.g. "Cannot init here", "Invalid review host CLI", `FORGE_INIT_NONINTERACTIVE=1 requires FORGE_INIT_ANSWERS_JSON`, "forge init cancelled" — **no new runtime crash pattern.** The log is useful regression context, not evidence of a live defect.

---

## Acceptance for the umbrella ticket

- [ ] B2 migrated to `spawn-tsx`; orchestrate e2e runs source.
- [ ] B1 normalized at `wrapLinearClient.issue` **and** `classifyLinearError` honors `TrackerError.code`; retry-count + NOT_FOUND regression tests pass.
- [ ] D1–D7 deleted; gate green.
- [ ] S1, S3, S4, S5 applied in small batches (S2 deferred to its own PR with a test plan).
- [ ] A1/#256, A2/#243, A3/#209 either resolved or explicitly left to their own tickets (cross-linked).
- [ ] Full gate green: `typecheck` + `build` + `test` + `test:pack` + `forge --version` smoke.
