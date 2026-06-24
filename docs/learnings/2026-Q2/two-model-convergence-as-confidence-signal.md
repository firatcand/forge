# Two independent models converging on the same finding is a confidence signal, not just noise reduction

> 2026-05-17 · FORGE-94 · tags: [review, multi-model, codex, ethos, trackers, code-review]

## What we expected
Dispatching Codex (gpt-5.5) and the Claude code-reviewer agent (Sonnet) in parallel against the same diff would surface overlapping findings — reducing review latency at the cost of some redundancy. Priority of overlapping findings would be no higher than a single reviewer's finding.

## What happened
Both models independently identified the same #1 bug: `assertValidBodyInput` rejected only two known forge comment markers, but `parseExtraForgeFooters` preserved every `<!-- forge:KEY=... -->` marker. A caller passing `<!-- forge:ownerType=evil -->` in their body would produce two contradictory `forge:ownerType` comments in the output — silent round-trip corruption. Neither model had seen the other's output.

## Why
When two models with different training distributions, different prompting contexts, and different code-reading strategies independently surface the same finding, the probability that finding is a false positive collapses. Each model's independent prior over "is this a real bug" is roughly p; convergence gives p² odds of false positive. This is structurally different from running one model — convergence is evidence the bug is non-obvious enough to require real understanding, not just pattern-matching on surface syntax. This is ETHOS principle 6 ("multi-model second opinion") working as designed: the value is not just "more eyes" but "independent agreement raises priority."

## Next time
When two models converge on the same finding without coordination, treat that finding as P0-equivalent regardless of how minor it looks in isolation. Conversely, a finding surfaced by only one model warrants checking the other model's take before acting. Budget parallel review time on all adapter PRs; the convergence signal pays for the overhead.
