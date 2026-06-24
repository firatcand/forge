# Verify SPEC's API assumptions against the provider's real surface before designing around them

> 2026-05-13 · FORGE-16 · tags: [spec, api-verification, planning, foundation, dogfooding, eureka-preservation]

## What we expected
SPEC.md line 207 said LinearTracker should claim issues via "custom field `forge_claimed_by` (string), atomic via Linear's optimistic concurrency (revisions)". The plan would design the atomic-claim primitive around that mechanism, exactly as written. Sibling adapter `GitHubTracker` shipped against a SPEC that matched API reality, so the assumption was that SPEC would track reality here too.

## What happened
A planning-phase verification step (read Linear's GraphQL schema at `linear/linear@master/packages/sdk/src/schema.graphql`) found that `IssueUpdateInput` has **no** `revision` / `expectedRevision` / `customFields` / `metadata` field. Linear's revision counter exists in their database but is not exposed in the public API. SPEC was describing a mechanism that cannot be built. Pivoted to label-based claim + lexicographic tiebreak (same primitive `GitHubTracker` uses) before any code was written, then amended SPEC.md post-ship in six places to match shipped reality.

## Why
SPECs are written before adapter implementations and tend to describe the intended semantic ("atomic claim") in provider-shaped vocabulary the SPEC author guesses from documentation skimming. Provider docs frequently expose internal capabilities the public API doesn't. Designing around the SPEC text without API verification means designing around a phantom feature — caught only at implementation time, often after wasted plan/design work. The inverse of `spec-beats-linear-ac.md` (SPEC drift toward AC): here SPEC drifted *away* from API reality.

## Next time
For any adapter task whose SPEC references a provider capability (revision-based CAS, custom fields, native relations, webhooks, optimistic concurrency, partial updates) — **fetch the provider's actual schema/SDK types and grep for the named feature in the planning step**, before drafting per-method data flow. If absent, surface the divergence as a §11 EUREKA, pick a working primitive, and amend SPEC post-ship. Cheap to do in CC-minutes; saves multi-hour pivots. Generalizes to: don't trust upstream docs/specs that describe a provider's API surface — verify against the provider's type definitions before locking design.
