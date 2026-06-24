# Cross-review with independent context catches what single-pass review misses
> 2026-05-17 · FORGE-100 · tags: [review, process, cross-review, multi-model]

## What we expected
One review round (code-reviewer + security-auditor agents, both Sonnet, same session) is sufficient before merge. The 1st round found 3 BLOCKs + 4 MEDIUMs and all were fixed. QA passed. We expected no material issues to remain.

## What happened
A 2nd-pass cross-review — Codex CLI (separate process, separate context, different model family) followed by a fresh Claude code-reviewer — found 3 additional BLOCKs after the 1st round's fixes: (1) duplicate `forgeTaskId` footer on an adversarial tracker issue could attribute title/dep updates to the wrong local task; (2) the `{npx, node}` MCP allowlist was security theater — `node -e '...'` bypasses it; (3) YAML anchor splice could crash `doc.toString()` on next read. All three were real, all shipped in commit `f6b6ef2`.

## Why
In-session reviewers are primed by the plan context and implementation narrative — they anchor on what was intended and verify correctness within that frame. An agent starting from a blank context (Codex, or a fresh Claude call with no conversation history) approaches the code without that prior and notices different invariant violations. Three independent reviewers do not triple-check the same things; they each find a distinct class of bugs because each has different priors.

## Next time
For any change touching a critical path or introducing a new abstraction (new verb, new diff function, new trust boundary): run a 2nd-pass cross-review with at minimum one agent that has no in-session context for the PR. A fresh Claude code-reviewer call with only the diff and the review brief is sufficient; Codex as a second model family is additive. This pass reliably pays for itself on PRs above ~500 LOC.
