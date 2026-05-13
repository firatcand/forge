# test/fixtures/orchestrator/

Shared fixtures for FORGE-31 / FORGE-20 / FORGE-21 / FORGE-32 / FORGE-22 test suites. Each task's implementation tests load from this directory rather than constructing inline fixtures, so contract drift is caught immediately.

## Files

| File | Purpose | Used by |
|---|---|---|
| `phases.yaml` | Minimal 3-task dependency graph: T01 → T02, T01 → T03. Exercises eligibility filter, slot accounting, and the case where two tasks become eligible simultaneously after a blocker completes. | FORGE-20 dispatcher tests, FORGE-22 retry queue tests |
| `settings.yaml` | Settings for the orchestrator under test: GitHub tracker, env_file secrets, max_concurrent=2 (smaller than default so tests can probe slot exhaustion). | FORGE-20 dispatcher, FORGE-21 worker, hot-reload tests |
| `question-open.json` | A valid open `Question` document. | FORGE-31 reader tests, FORGE-20 notification-stream tests |
| `question-with-recommendation.json` | Open question that includes `recommended_option_id` + `what_happens_if_unanswered`. | FORGE-32 worker question writer round-trip tests |
| `answer-valid.json` | A valid `Answer` matching `question-open.json`. | FORGE-31 answer reader, FORGE-20 dispatch-respawn tests |
| `question-corrupt-options.json` | Question file with `options: []` — invalid; readers must reject. | FORGE-31 untrusted-input tests |
| `notification-stream.jsonl` | Replay of a small orchestrator run: one question, one answered resolution, one fatal. | FORGE-20 stream emit tests, `forge orchestrate attach` tests |

## Layout (in-test convention)

Tests stage these into a `tmpdir/.forge/...` tree using `fs.cp` rather than relying on absolute paths. The fixture directory itself never gets mutated by a test.

Schema versions are pinned to v1 throughout. When the schemas advance, fixtures land in a sibling `v2/` directory; v1 fixtures remain as historical regression evidence.
