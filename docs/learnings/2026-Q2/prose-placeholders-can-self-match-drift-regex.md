# Prose placeholders can self-match a drift regex
> 2026-05-18 · FORGE-99 · tags: [spec-hygiene, regex, doctor]

## What we expected
Writing `\`src/...ts\`` as a glob-like placeholder inside SPEC.md §Doctor prose ("for each `src/...ts` path mentioned in...") would be read as illustrative description — not as a real file path.

## What happened
Doctor's own regex `/\b(src\/[A-Za-z0-9_\-./]+\.ts)\b/g` matched the literal placeholder text. After SPEC + ORCHESTRATOR cleanup, baseline rose from 0 drift entries to 2 — both sourced from the placeholder strings just written into the spec while describing the regex itself. Caught by re-running doctor between SPEC edits and the test suite.

## Why
A rule-system author can violate their own rule via prose meant to describe it. The regex contains no semantic disambiguation between "this is a real path" and "this is a literal example describing the regex."

## Next time
When writing prose ABOUT a rule (regex, validator, lint check), use notation the rule cannot interpret as real input. Either escape to literal-form citation or use a non-matching prefix (`app/...ts`). Always re-run the rule itself against its own spec section after editing that section.
