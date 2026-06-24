# State-based mocks for CLI-subprocess adapters
> 2026-05-13 · FORGE-63 · tags: [testing, trackers, mocks, process]

## What we expected

A CLI-wrapped adapter (GitHubTracker, which shells out to `gh`) would be testable with the same sequenced-response queue pattern already used for the SDK-based LinearTracker. Wiring it into `runTrackerConformance` (`test/fixtures/trackers/conformance.ts`) would be a small shim over existing infra.

## What happened

A sequenced queue works for asserting exact call order in unit tests, but it cannot satisfy conformance coverage: the conformance helper calls the tracker in high-level operations (create, transition, close…) without prescribing how many subprocess invocations each operation fires, or in what order. A state-based dispatcher was needed instead — one that parses raw `args[]`, mutates an in-memory issue/label/milestone store, and returns shaped `--json` output, mirroring what `gh` would return from a real API.

`MockGhServerState` (`test/fixtures/trackers/github-state.ts`, ~507 LOC) became that dispatcher. It is structurally parallel to `MockServerState` for Linear (`test/fixtures/trackers/linear-responses.ts:165–240`), but operates on CLI argument vectors rather than GraphQL request shapes.

Three non-obvious gh-CLI quirks surfaced during planning (caught before a line of code was written — see "Next time"):

1. `gh issue close --reason "not planned"` uses a human-readable phrase with a space; the underlying API enum is `not_planned`. The tracker already hard-codes the phrase form (`src/trackers/github.ts:503`), and the mock must match it exactly.
2. The tracker today passes `--remove-label state:in-progress,state:in-review,state:blocked` as one comma-joined value. The parser also accepts repeated `--add-label X --add-label Y` for future-proofing.
3. `Set` iteration order is insertion-order, not lexicographic. Labels serialized from a `Set` into JSON output will produce flaky ordering in future race-style tests. Fix: sort lex before serializing.

## Why

CLI-subprocess adapters have no structured request type to pattern-match against. The only stable contract is the arg vector that the adapter passes to `execa`/`spawnSync`. Conformance testing therefore requires arg-level parsing, not payload-level snapshotting.

Separately: the sequenced-mock layer remains valuable for unit tests asserting exact call sequences. Two layers co-existing is intentional — unifying them would sacrifice the precision of the queue-based tests for the flexibility of the state-based ones.

## Next time

**Mock pattern.** For any new CLI-based adapter: write a `MockXxxState` class that implements `handleArgs(args: string[]): string` before writing the tracker itself. It forces explicit documentation of the CLI's arg contract, and the same class becomes the conformance fixture. Reference `test/fixtures/trackers/github-state.ts` as the canonical template.

**Additive over migrate.** When retrofitting a new mock layer alongside an existing one, resist the urge to unify. Add the state mock; leave the sequenced queue in place. Each layer has a distinct job.

**Run codex on the plan, not just the diff.** All three gh-CLI quirks above were caught by feeding the plan file (`~/.claude/plans/deep-humming-elephant.md`) to `codex exec` with a focused prompt about subprocess-protocol edge cases — before writing code. Cost: one codex turn. Saved: at minimum one fix-and-retry cycle. Generalise: any ticket that wraps a subprocess or CLI protocol should get a codex review of the plan, not just a post-diff review.
