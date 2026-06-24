# Gitignored fixture files in tests pass locally and fail in CI

> 2026-05-16 · FORGE-80 (repeat of FORGE-62) · tags: [testing, ci, dogfooding, regression, gitignore, forge-internal]

## What we expected
Wrote a "real-world phases.yaml smoke" test in `test/unit/sync-status/build-diagnostic.test.ts` that loaded `plans/phases.yaml` from the worktree to verify the `loadPhases → buildDiagnostic` pipeline. Test passed locally. /ship gates (typecheck + tests + manual build smoke + gitleaks) all green. Pushed the PR.

## What happened
CI failed on the PR within seconds. The `npm test` job logged `not ok 559 - AC bonus: real-world phases.yaml smoke`, with the error originating from `loadPhases()` trying to read a file that didn't exist on the runner. `plans/phases.yaml` is gitignored under the "Forge dogfooding" block in `.gitignore` (lines 45-54) along with `spec/BRIEF.md`, `spec/CONTEXT.md`, `plans/tasks/*.plan.md`, and `docs/learnings/**/*.md`. CI runners check out only tracked files. The test never had a chance to pass in CI.

This is the **exact** bug FORGE-62 already documented and resolved months ago for `phases.test.ts` AC3. I shipped it again in FORGE-80.

## Why
Forge dogfoods itself — we use it to build itself, but we don't ship our internal project plans/specs/learnings in the published npm package. So `plans/`, `spec/`, `docs/learnings/`, and `.forge/` are gitignored at the repo root. Tests that read them are testing files that don't exist for any consumer of the package, including CI runners.

`/pickup-task` hydrates these into fresh worktrees, which gives the false impression they're available everywhere. They're not — they're hydrated by an out-of-band copy step that only runs locally.

I missed the precedent (FORGE-62) because the learning store didn't have it as a learning file — only as a closed Linear ticket. The learning-curator that ran during /pickup-task only sees `docs/learnings/`. Tickets in Linear aren't surfaced to it.

## Next time
- **Before writing any test that reads a file path under `plans/`, `spec/`, `docs/learnings/`, or `.forge/`:** run `git check-ignore <path>` first. If it's ignored, you cannot use it in CI.
- For any integration smoke that needs realistic data, **use a committed fixture** under `test/fixtures/<area>/`. Inline construction (build objects in-memory) is even better when the production code is a pure function.
- The local-pass + CI-fail divergence is **invisible until you push**. `/ship`'s local test gate cannot catch this class of bug because the test passes against the locally-present-but-gitignored file. The right preventive: a static check on test files for path reads under any dogfooded directory.
- Forge-internal gitignored paths to watch:
  - `plans/phases.yaml`, `plans/tasks/*.plan.md`
  - `spec/BRIEF.md`, `spec/CONTEXT.md` (and others in the dogfooding block)
  - `docs/learnings/**/*.md`
  - `.forge/**`
- When a closed Linear ticket documents a bug class, **promote it to a learning file**. The learning store is what gets injected into future sessions; the ticket history is not. FORGE-62 should have had a learning file from the start.

## Related
- FORGE-62 (closed): "phases.test.ts AC3 fails in every worktree — reads gitignored plans/phases.yaml" — the original instance.
- [[ac-as-unit-test]] — same family: "local conditions made the test look fine; another check would have caught the failure mode."
- [[worktrees-blind-to-gitignored-context]] — root cause of why these files appear locally at all.
