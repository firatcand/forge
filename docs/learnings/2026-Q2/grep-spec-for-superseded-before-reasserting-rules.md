# Grep SPEC for "Superseded" before reasserting rules
> 2026-05-18 · FORGE-106 · tags: [docs, multi-model-review, spec-drift, codex]

## What we expected
Implementing an option the user approved from /plan-task should be safe — the user reviewed it, the AC described it, and /implement applied it verbatim.

## What happened
The approved option reinstated a 6-level precedence chain (`user > SPEC > PRD > phases.yaml > tracker > attempts`) that SPEC had explicitly superseded two days earlier (SPEC.md lines 16 and 36 both mark it "Superseded — replaced with authority-by-field"). Codex's fresh read of SPEC caught it at confidence 10/10; plan-mode, user approval, and /implement all missed it.

## Why
The Linear AC predated SPEC's 2026-05-17 PM amendment, so every actor — the AC, the plan preview, and the user — was anchoring on stale wording. None of them grepped SPEC for "Superseded" or "replaced" before the rule was reasserted.

## Next time
Before shipping any text into `CLAUDE.md`, templates, or skill docs that cites or restates a rule from SPEC/PRD, grep the source for `Superseded`, `Replaced`, and `Deferred` and confirm the rule still exists in its current form.
