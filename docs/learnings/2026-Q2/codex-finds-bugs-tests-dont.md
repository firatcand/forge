# Codex multi-model review finds correctness bugs that unit tests miss
> 2026-05-15 · FORGE-73 · tags: [orchestrator, multi-model-review, code-review, defense-in-depth, testing]

## What we expected
14 unit tests written specifically for the FORGE-73 question-channel re-path work — including edge-case coverage for writer, reader, and gc reconciliation — would catch all correctness regressions before merge.

## What happened
`codex review --uncommitted` (advisory path, since no CRITICAL.md paths were touched) surfaced two real bugs the test suite did not catch:

**Bug A (P2):** `src/orchestrator/questions/writer.ts` accepted `opts.taskId` and `question.task_id` as independent inputs. A caller passing mismatched values would write the file at one task's path while the JSON payload claimed another task. Cross-attempt `decision_key` deduplication scans by path but reads payloads — the mismatch would silently corrupt dedup. Fixed: pre-I/O guard throws `INVALID_ID` when the two values differ.

**Bug B (P3):** `src/cli/orchestrate-gc.ts` `listLegacyFiles` filtered with `name.endsWith('.json')`. A subdirectory named e.g. `something.json` (legal on POSIX) would pass the filter, causing `linkSync` to throw `EISDIR` mid-pass and abort the entire gc migration, leaving valid legacy files unmigrated. Fixed: switched to `readdirSync({ withFileTypes: true })` and filtered on `Dirent.isFile()`.

Both bugs were in code that the unit tests exercised — they were testing the right surface, just not the right invariants.

## Why
Unit tests validate the happy path and the cases the author thinks to model. The author who wrote the writer also wrote the tests — they modelled the same mental frame. Codex reviews with a different prior and catches invariant violations the author normalised away. The test suite also had no test for "what happens if taskId and question.task_id disagree" because the author never imagined a caller would do that.

## Next time
Run `codex review --uncommitted` on any orchestrator hot-path change regardless of whether CRITICAL.md paths are touched. The cost is ~2 minutes; the benefit is a second mental model that doesn't share the author's blind spots. Treat Codex findings as a checklist to verify, not as noise — both bugs here were real on first read.
