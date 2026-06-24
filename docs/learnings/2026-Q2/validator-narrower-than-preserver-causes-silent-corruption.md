# Validator narrower than preserver causes silent round-trip corruption

> 2026-05-17 · FORGE-94 · tags: [trackers, backend, testing, integration, validation]

## What we expected
`assertValidBodyInput` rejecting known forge comment markers (`<!-- forge:task -->`, `<!-- forge:blockedBy -->`) would prevent callers from injecting forge-managed content into the body they supply. `parseExtraForgeFooters` preserving all `<!-- forge:KEY=... -->` markers through the replace cycle would correctly carry caller-supplied extras into the final output.

## What happened
The two functions had asymmetric recognition surfaces. `assertValidBodyInput` checked for two specific markers; `parseExtraForgeFooters` preserved every `<!-- forge:KEY=... -->` pattern. A caller passing `<!-- forge:ownerType=evil -->` passed validation, survived preservation, and landed alongside the adapter-managed `forge:ownerType` footer — two contradictory values in the same issue body. No error, no warning.

## Why
Whenever a round-trip has a validator on the input side and a preserver on the output side, both must agree on the same key namespace. If the validator is narrower (recognizes fewer values) than the preserver (preserves more values), the gap is a silent injection surface. The fix is either broaden the validator to cover all keys the preserver touches, or restrict the preserver to only keys the validator explicitly allows. Either direction works; inconsistency is the bug.

## Next time
When adding a preserve-through-replace helper for a structured comment namespace (forge footers, HTML annotations, metadata blocks), write the validator regex first, derive the preserver regex from it, and add a test that confirms a novel key in the namespace is rejected at input. Never write validator and preserver independently and assume they agree.
