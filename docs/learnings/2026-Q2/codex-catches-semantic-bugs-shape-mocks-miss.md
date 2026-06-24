# Codex catches semantic bugs that shape-mock unit tests pass through

> 2026-05-13 · FORGE-16 · tags: [review, multi-model, codex, semantic-bugs, testing, mocks, ethos]

## What we expected
58 LinearTracker unit tests passing — including a deterministic 20× claim-race test and an interface-conformance suite — would catch the major bug classes before review. Codex would surface minor stylistic issues at most.

## What happened
Codex (run after green tests) flagged three independent P2 semantic bugs that all unit tests passed through:
1. `IssueRelation` direction was reversed — `setBlockedBy(issueId, blockerId)` was creating a relation declaring "the blocked issue blocks its blocker" instead of "the blocker blocks the blocked issue". UI dependency arrow would point the wrong way. Mock didn't care about arg values.
2. Footer-dedup early-return permanently skipped native relation create on retry after partial failure. If the footer write succeeded but `createIssueRelation` failed transiently, the next call short-circuited on `blockerIds.includes(blockerId)` and never retried the native relation. Linear UI dependency missing forever. No test simulated the retry-after-partial-failure path.
3. `tryRemoveLabelByName` read from a process-local label cache; on cache miss (fresh orchestrator process) it silently no-op'd. Stale overlay labels would persist on issues being transitioned, corrupting `deriveStateFromLinearIssue` on subsequent `listActiveIssues`. Unit-test setUp pre-populated the cache, so the cache-cold path never ran.

All three are call-content bugs — the SDK calls *are* happening, just doing the wrong thing. Shape-validating mocks (call-with-X-args returns-Y) can't detect this category. Codex reads code semantically against intent.

## Why
Mock-based unit tests verify call shape (this function was called with these args, returns this value). They cannot verify call meaning (the arg semantics match the provider's interpretation, the call is the right one to make, the retry path re-reaches the operation). Codex shells out to verify content: reads provider schemas (Linear's `IssueRelationType.Blocks` enum, `IssueRelation` source/related semantics), simulates flow ("if updateIssue succeeds and the next call fails, what does the retry do?"), and judges against intent. Same shape as the `gh-cli-flag-spelling-vs-api-enum.md` learning (FORGE-15: mocked `gh` accepted any `--reason` value, real `gh` rejected the API enum spelling) — that one caught flag spelling, this one caught direction + retry-path + cache-coherence. Generalizes: multi-model review is high-leverage on adapter PRs precisely because the mock layer hides the very bugs the mocks were meant to test.

## Next time
On any tracker/secret-manager/external-system adapter PR, treat `/codex review --base main` as **required pre-merge**, regardless of CRITICAL.md state (the existing learning `codex-on-security-paths-even-when-critical-md-stale.md` says this for atomic-claim paths specifically; this generalizes it to all adapter PRs). Budget time for ≥1 round of codex findings + fixup commit; assume the mock layer will hide a semantic bug worth catching. The integration test against the real API is the secondary safety net — codex is cheaper and catches more.
