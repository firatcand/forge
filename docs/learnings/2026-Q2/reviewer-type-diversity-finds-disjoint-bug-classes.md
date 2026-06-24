# Reviewer-type diversity finds disjoint bug classes
> 2026-05-22 · FORGE-154 · tags: [review, testing, multi-model]

## What we expected
Running multiple reviewers on the same diff would yield overlapping findings, or at least that different *models* would be the source of diversity.

## What happened
Three reviewers fired on the FORGE-154 diff: code-reviewer (Sonnet), security-auditor (Sonnet), and codex (second-opinion, GPT-5-codex). Each found a strictly different bug class with zero overlap. Crucially, code-reviewer and security-auditor share the same model lineage (both Sonnet) — the diversity came from the *prompt frame*, not the model. code-reviewer caught a comment-vs-code contradiction (semantic doc bug). security-auditor caught symlink attack vectors in `writeFileSync`. Codex caught a silent whitespace rewrite violating the verbatim-preservation guarantee.

## Why
Each reviewer type is optimized for a different invariant: code correctness, threat surface, and spec fidelity. Same model with different prompt framing (code-focused vs STRIDE-framed) finds disjoint things. The frame, not the model, determines the invariant class inspected.

## Next time
When the diff touches file mutations, security boundaries, or public API, fire all three reviewer types in parallel even when `CRITICAL.md` doesn't strictly match. Marginal cost is ~3 minutes; each surfaces bugs the others miss because they look at different invariants. See also: [[multi-model-review-catches-distinct-bug-classes]] (extends that finding — same-lineage reviewers with different prompt frames also diverge).
