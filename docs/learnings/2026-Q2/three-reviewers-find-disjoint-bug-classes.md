# Three reviewers find disjoint bug classes — non-overlap is the point
> 2026-05-17 · FORGE-115 · tags: [review, multi-model, codex, foundation]

## What we expected
Running code-reviewer → security-auditor → Codex in sequence would produce significant overlap by the second and third pass, making the later passes mostly redundant.

## What happened
Eight findings across three passes, near-zero overlap:

| Reviewer | Findings |
|---|---|
| code-reviewer | CRLF false-negative in `appendLineIfMissing` |
| security-auditor | TOCTOU between existsSync/readFileSync (HIGH); unbounded readFileSync on user configs (MEDIUM); space-unsafe `cp` glob in skill bash (LOW) |
| Codex | `safeReadConfig` too narrow on fs errors (EACCES/EISDIR/ELOOP); bash sanitizer locale gap (LC_ALL on builtins) |

Each reviewer's blind spot was another's specialty. The security-auditor explicitly cross-referenced CRITICAL.md and existing learnings in `docs/learnings/` — it caught a TOCTOU class the repo had already named, which neither of the other reviewers surfaced.

## Why
The three reviewers use structurally different priors. code-reviewer examines the diff as a peer engineer (correctness, conventions, tests). security-auditor applies a threat model lens and explicitly consults the repo's own named bug classes. Codex runs in a separate process with no in-conversation priming — it can't be anchored by what the other reviewers concluded, so it approaches the diff cold.

## Next time
For CRITICAL-path or security-adjacent changes, run all three. The compute cost is negligible; the non-overlap justifies every pass. Don't substitute one for another — they are not redundant, they are complementary in the strictest sense: covering disjoint parts of the failure space.
