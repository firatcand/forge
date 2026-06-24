# Heartbeat renewal preserves identity fields — identity-gated mutations need a freshness field
> 2026-05-20 · FORGE-22 · tags: [foundation, concurrency, lease, gc]

## What we expected

An identity check on `(claim_id, generation, owner_run_id)` would be sufficient to gate `adminReleaseLeaseByIdentity` against concurrent mutation between snapshot and unlink. If the lease owner changed, all three fields would have changed.

## What happened

`heartbeat()` deliberately preserves all three identity fields and only advances `expires_at` + `last_heartbeat_at` — its purpose is to extend the same claim, not produce a new one. The 3-field check passed against a freshly-renewed lease, and gc was one syscall away from unlinking an actively-held lease. Codex 3rd-pass review caught it at confidence 10 before merge; unit tests had not. Fix in `164800b`: extend identity to four fields by adding `expectedExpiresAt`, plus verify-before-unlink re-read.

## Why

Identity in `leases.ts` was modelled as "WHO owns this claim" — but the question gc needs to answer is "is this claim still the SAME claim as my snapshot saw?" Those are different. heartbeat semantics required identity to be stable across renewal, so the freshness signal had to live outside the identity tuple. Pure unit tests don't trigger it because they don't fire heartbeat mid-test; only an adversarial reader (codex) traced the cross-function interaction.

## Next time

For any identity-gated mutation that spans a snapshot → action gap, include a **freshness** field in the identity tuple that any in-scope concurrent operation must advance. `expires_at` is the canonical freshness field for leases. Also: cheap verify-before-mutate (re-read at the last moment, re-confirm all gates) closes the snapshot → mutation TOCTOU window without OS-level locks. The pattern echoes `steal()`'s "Fix 1 — verify-before-write" at `leases.ts:809`.
