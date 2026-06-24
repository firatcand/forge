# code-reviewer, security-auditor, and Codex each caught strictly different bugs
> 2026-05-15 · FORGE-78 · tags: [code-review, multi-model-review, planning]

## What we expected
Running three reviewers on the same PR would produce overlapping findings — redundant but thorough.

## What happened
All three rounds produced BLOCK findings with zero overlap. code-reviewer caught flow bugs (generation reset to 0 after release-then-reacquire). security-auditor caught invariant gaps (`appendAttemptEvent` missing `assertLeaseOwnership`). Codex caught symmetric races (steal verify-before-write). Each operated at a different level of analysis: code-path, must-always-be-true, and state-diagram respectively.

## Why
Each reviewer model has a different primary lens. Flow bugs are visible by tracing execution paths. Invariant gaps require asking "what must hold everywhere?" Symmetric races require reading the state diagram for a matching operation on the other side.

## Next time
For safety-critical primitives (atomic-claim CAS layer, auth/billing, schema migrations), run all three reviewers — they are not redundant. A panel missing any one of them would have shipped a BLOCK-level bug.
