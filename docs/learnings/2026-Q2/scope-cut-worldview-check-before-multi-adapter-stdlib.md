# Worldview check before building multi-adapter stdlib

> 2026-05-12 · FORGE-18 · tags: [scope, architecture, slim-then-expand, planning, foundation]

## What we expected
Build 3 secret-manager adapters (env_file + 1password + doppler, ~700 LOC, 3pt) per the original SPEC.md plan.

## What happened
Paused mid-plan to ask "why are we building this?" — triggered a worldview check: is forge a scaffolder, a runtime stdlib, or both? SPEC implies both, but only env_file is needed to validate the abstraction. Slimmed to 1 adapter (~250 LOC, 1pt).

## Why
Multi-adapter abstractions are bets on an interface shape. If the shape is wrong, you've wasted N adapters' worth of code. Validating with the simplest provider first costs the least and de-risks the abstraction. CLI-drift and maintenance burden scale linearly with adapter count.

## Next time
Before any multi-adapter / multi-provider layer: ship 1 provider that exercises the full interface (factory + classify-error + happy + sad paths). Keep interface + factory shapes additive-friendly. Defer providers 2..N until adopter pull is real. State the worldview question explicitly in the plan — "what is this tool, and does this feature fit that worldview?"
