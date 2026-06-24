# AC-as-unit-test vs "it already exists"
> 2026-05-16 · FORGE-77 · tags: [testing, tracker, github, claim, ac-discipline, codex-review]

## What we expected
Read the existing `github.ts` claim flow, saw the three-step structure (read → add → reread) from FORGE-72, declared verify-on-readback complete. Scoped FORGE-77 to prefix migration and `releaseClaim` narrowing only.

## What happened
Codex flagged a MAJOR finding at `github.ts:422`: the `length <= 1` correctness check returned `{ ok: true }` when the reread produced zero claim labels (silent strip) or exactly one label that wasn't ours (another agent won). Pre-existing bug from FORGE-72, but FORGE-77's first AC bullet explicitly required "`claim()` returns `version_conflict` if another `forge:claimed-by:*` label appears" — the bug was in scope the entire time.

## Why
Pattern-matched "three-step structure exists ⇒ verify-on-readback works" instead of reading each AC bullet as a failing test against the live code. Codex has no assumption pattern to inherit, so it read the branch predicate cold and caught what the structure-level scan missed.

## Next time
Treat each AC bullet as a failing unit test before declaring scope done. For every behavior the AC enumerates, either write the test or mentally execute the code against the failure case — then confirm it passes. "It's already there" is a smell, not a conclusion, when the AC explicitly names the behavior.
