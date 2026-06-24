# Exported fixture helper is not self-invoking — name lies, codex sees it
> 2026-05-15 · FORGE-72 · tags: [testing, ac-mapping, codex, fixtures]

## What we expected
Adding `export function runClaimResultUnionFixture()` to the conformance file
would satisfy the AC bullet *"fixtures cover both `Result.ok=true` variants"*.
The function name reads like a runtime claim, the body exercises both shapes,
and the all-green test run made it look done.

## What happened
Codex flagged the helper as dead code on review: nothing imported or called
it. The AC checklist was satisfied **lexically** (the fixture exists) but
**functionally** the variant never executed each run. Fix was a one-liner —
import it from `types.compile.test.ts` and call it inside a `node:test`
block — but the gap would have shipped without the second-opinion pass.

## Why
"Fixture exists" and "fixture runs" are different invariants. A `node:test`
file only executes the body of `test(...)` callbacks; exported helpers are
inert until something invokes them. Naming a helper `run*` implies execution
but does not cause it. The unit-test suite passing did not prove the helper
ran — it proved everything that *did* run, ran clean.

## Next time
For any AC bullet of the form "fixtures/helpers cover X", grep the helper
name from inside `test/` directly. If the only hit is the `export`, the
fixture is unwired regardless of how plausible the name reads. Bonus: prefer
inlining the assertions directly into a `test('...', ...)` block when the
helper has exactly one caller — the indirection earns nothing and hides the
no-invocation case.
