# Batch 5 — CLI UX (FORGE-134, FORGE-149, FORGE-86, FORGE-84)

**Branch:** `feat/hardening-cli-ux` · **Worktree:** `.forge/worktrees/FORGE-134`
**User decision:** FORGE-134 = per-verb flag table (option 2).

## FORGE-134 — `forge orchestrate <verb> --help` prints help instead of running

`src/cli/orchestrate/index.ts`:
- Extend `VerbHandler` (lines 40–44) with `readonly flags?: ReadonlyArray<{ flag: string; takesValue: boolean; description: string }>`.
- Intercept in the dispatcher BEFORE `verb.run` — **value-aware** (pre-review major): scan the verb's args left-to-right using the verb's OWN flag declarations; a token immediately following a declared `takesValue: true` flag is a VALUE and is never treated as `--help` (so `answer --note --help`, `run start --name --help`, `question --question --help`, `cancel --reason --help`, `event --data --help` keep their current semantics). Intercept only a `--help`/`-h` in flag position. Unknown `--x` tokens are treated as boolean for the scan (declarations are required to be complete for every verb in this batch). `--help` takes precedence over `--json` execution; if BOTH present, emit an `ok` envelope `{ verb, band, synopsis, flags }` via the existing envelope.
- Human help format: `forge orchestrate <verb> — <synopsis>` + aligned flag table (`--flag <value>` vs `--flag`) + one-line footer pointing at `forge orchestrate --help`.
- Retrofit ALL verbs with flag declarations from the scouted reality table (phases, doctor, questions, status, dashboard, attach, spec-diff, guardrail-check, render-worker-prompt, run start, run list, ensure-worktree, claim, dispatch, heartbeat, question, answer, event, complete, cancel, reconcile, apply-decision, amend-roadmap, gc, second-opinion). Descriptions one-liners; flags must match what each handler ACTUALLY parses (scout report has the exact per-verb table incl. value-vs-boolean — declare `--run-id`/`--run` style aliases as one entry `--run <id>` noting the alias). reconcile parses inside reconcile.ts via `parseReconcileArgv`, which REJECTS unknown args and accepts exactly: `--pull, --push, --dry-run, --json, --confirm-prune, --no-prune` (NO --forge-dir) — declare exactly those, do NOT change its parser (pre-review major).
- Nested `run` verb: `run --help` lists sub-verbs (nestedUsage already exists); `run start --help`/`run list --help` get the same flag-table treatment.
- Tests (test/unit/cli/orchestrate/help.test.ts style): (a) loop over EVERY flat verb + run sub-verbs: `dispatchOrchestrate([verb, '--help'], opts)` in an ISOLATED mkdtemp cwd/forge-dir → exit 0, stdout contains the synopsis, AND the temp dir tree is byte-empty afterwards (recursive listing unchanged) — do NOT rely on INVALID_ARGS behavior, some verbs (gc, run start) can mutate with no args (pre-review major); (b) detailed assertions for doctor (--scope listed), phases (--ready listed), gc; (c) `--json --help` returns parseable ok envelope with flags array; (d) `-h` alias works; (e) value-aware negatives: `answer <qid> --note --help` does NOT print help (reaches the verb), same for `run start --name --help` (assert the verb's own behavior, not help output).

## FORGE-149 — opt-in JSON warning surface (auto-gc visibility)

- `src/cli/orchestrate/gc.ts` `detectCheapDivergences` (854–877): change return type from `void` to a structured array `GcCheapWarning[]` = `{ row_id, task_id, action, severity: 'warning', suggestion: 'run `forge orchestrate gc` to apply' }`, STILL writing the existing `[gc] …` stderr lines itself (back-compat for all callers). Failure path returns `[]` after the existing stderr note.
- `src/cli/orchestrate/phases.ts`: new boolean flag `--include-warnings` (declare it in the FORGE-134 flag table too). When set with `--json` on `--ready`, add `warnings: GcCheapWarning[]` to `PhasesResultData`. Without the flag: output byte-identical to today (field omitted entirely, not empty).
- `src/cli/orchestrate/status.ts`: add `--json` mode (currently text-only, 165 lines): emit an `ok` envelope mirroring EXACTLY what the text formatter actually prints today — run id, started_at, pid, worker status counts (pre-review minor: do NOT invent per-task entries; that's a new schema for another ticket). `--include-warnings` adds the same `warnings` array. Without `--json`, text output unchanged. Wire flags through the status handler in index.ts; also add `--run` as an alias for `--run-id` (ORCHESTRATOR.md already documents `--run`).
- ORCHESTRATOR.md correction (pre-review minor): the spec documents `status [--run <run-id>] [--task <task-id>] [--json]` but `--task` is NOT implemented and --json wasn't either — with this batch, `--run` and `--json` become true; REMOVE the `--task` mention from the spec line (not implemented, no ticket) and run doctor to confirm no drift.
- `spec/ORCHESTRATOR.md` §CLI surface (lines 144–178 read-only verbs): document `--include-warnings` on phases and the new `status --json [--include-warnings]`.
- Tests: phases `--ready --json --include-warnings` with a seeded cheap-divergence fixture → warnings array present on stdout with correct row/task/action; WITHOUT the flag → stdout JSON deep-equal to pre-change shape (no `warnings` key); status `--json` envelope parses + carries warnings only when flagged; stderr `[gc]` lines still emitted in all modes (use PassThrough streams per existing test style; phases-autogc.test.ts is the fixture model).

## FORGE-86 — `OrchestratorError.safeDetails()`

- `src/core/errors.ts` OrchestratorError (157–171): add `safeDetails(): Record<string, unknown>` filtering `details` through an allow-list of identifier-ish keys: `taskId, runId, attemptId, claimId, questionId, decisionKey, rowId, state, fromState, toState, expected, actual, generation, stateVersion`. Everything else (notably `path`, `dir`, `cause`, nested objects) → replaced with `'[redacted]'` (key preserved so the shape is debuggable). Non-allow-listed NESTED objects always redacted, never recursed.
- Add a doc comment: local CLI human output may keep using raw `details`; ANY future IPC/HTTP/structured-log serialization MUST use `safeDetails()` (M4 trigger condition: block remote-API tasks until they do).
- NO call-site changes — today's envelope is local CLI stdout (the ticket's trigger condition explicitly says no such surface exists yet). State this in the PR body.
- Tests (new test/unit/core/errors.test.ts, modeled on secrets-managers/errors.test.ts): unknown key redacted (the ticket's named AC), allow-listed keys pass through, `path`/`cause` redacted, nested object redacted, empty details → empty object.

## FORGE-84 — `overwriteAtomicLink` ENOENT-distinction comment

- `src/orchestrator/leases.ts` (200–231): expand the ENOENT comment to distinguish (1) expected absence — prior release/cleanup by a well-behaved process; (2) a concurrent deletion racing this write — an observer between our unlink and link sees no lease momentarily. State explicitly: both collapse into the same idempotent path ON PURPOSE; the torn window is bounded by the immediately following linkSync and is acceptable because callers validated ownership first. Comment-only, NO behavior change (verify diff touches only comments in that function).

## Gates

1. typecheck · 2. full suite 0 fail (baseline 1989/1963/26; expect +~20) · 3. lint · 4. build + doctor spec-code `drift: []`
5. Manual: `node dist/bin/forge.cjs orchestrate doctor --help` prints flag table exit 0; `orchestrate claim --help` does NOT error/claim; `orchestrate phases --help --json | python3 -m json.tool` parses.
6. Implementer: Opus 4.8. Cross-review: GPT 5.5 ≥8.

## Commit skeleton

```
feat(cli): CLI UX batch — FORGE-134/149/86/84

FORGE-134: forge orchestrate <verb> --help prints synopsis + flag table
  (all verbs + run sub-verbs); --help wins over --json (envelope help)
FORGE-149: detectCheapDivergences returns structured rows; phases --ready
  --json --include-warnings + status --json [--include-warnings] surface
  auto-gc warnings on stdout; stderr behavior unchanged
FORGE-86: OrchestratorError.safeDetails() allow-list getter (+tests);
  future IPC surfaces must use it — no call-site change today
FORGE-84: overwriteAtomicLink ENOENT comment distinguishes expected
  absence vs racing deletion (comment-only)
```
