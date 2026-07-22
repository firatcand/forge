import { z } from 'zod';

export const LEASE_TTL_MS_DEFAULT = 1_800_000;
export const HEARTBEAT_INTERVAL_MS_DEFAULT = 300_000;
export const STEAL_GRACE_MS_DEFAULT = 300_000;

export const LeaseSchema = z.object({
  version: z.literal(1),
  claim_id: z.string().min(1).max(64),
  task_id: z.string().min(1).max(64),
  attempt_id: z.string().min(1).max(64).nullable(),
  owner_run_id: z.string().min(1).max(64),
  acquired_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  last_heartbeat_at: z.string().datetime(),
  generation: z.number().int().min(0),
  // "git:<40-hex>" or "digest:<hex>" — stamped at claim time. See spec-diff.ts.
  spec_revision: z.string().min(1).max(128),
  // FORGE-231: monotonic mutation counter for the lease FILE's entire lifetime
  // (across acquire → heartbeat → release-tombstone → reacquire cycles). Every
  // mutation bumps it by exactly one; casGuardedWrite serializes writers on it.
  // Defaults to 1 so legacy lease files (written before FORGE-231) parse; the
  // first guarded mutation of a legacy file therefore expects version 1.
  lease_version: z.number().int().min(1).default(1),
});

export type Lease = z.infer<typeof LeaseSchema>;

// FORGE-231: after its first acquisition a task's lease.json is NEVER deleted —
// release writes this tombstone instead. The tombstone keeps `lease_version`
// monotonic across ownership cycles (so the CAS protocol has a version to
// serialize on) and carries `last_generation` so re-acquire continues the
// generation sequence without consulting claim history.
//
// A genuinely ABSENT lease file therefore means one of exactly two things:
// never leased (no claim history either), or a legacy pre-FORGE-231 release /
// admin release (claim history present) — acquire() derives the next
// generation from claim history in that case (R8 CRIT-1).
export const ReleasedLeaseTombstoneSchema = z.object({
  version: z.literal(1),
  status: z.literal('released'),
  task_id: z.string().min(1).max(64),
  lease_version: z.number().int().min(1),
  last_generation: z.number().int().min(0),
  released_at: z.string().datetime(),
  released_by: z.object({
    run_id: z.string().min(1).max(64),
    claim_id: z.string().min(1).max(64),
    generation: z.number().int().min(0),
  }),
});

export type ReleasedLeaseTombstone = z.infer<typeof ReleasedLeaseTombstoneSchema>;

// Discriminated read contract for lease.json (R8 MAJ-2): consumers that mean
// "is this task actively leased?" must use the active variant only — a parsed
// tombstone is generation/version HISTORY, not an active lease, and must never
// trigger expiry, abandonment, or repeated release.
export const LeaseFileSchema = z.union([ReleasedLeaseTombstoneSchema, LeaseSchema]);

export type LeaseFileRecord =
  | { kind: 'active'; lease: Lease }
  | { kind: 'released'; tombstone: ReleasedLeaseTombstone };

// Shared discriminating parser for already-JSON.parse'd lease.json content.
// Every consumer that previously ran LeaseSchema.safeParse directly must go
// through this instead, so a release tombstone is classified as 'released'
// (no active lease) rather than misread as schema-invalid/corrupt.
export function parseLeaseFile(
  json: unknown,
): LeaseFileRecord | { kind: 'invalid'; error: string } {
  const result = LeaseFileSchema.safeParse(json);
  if (!result.success) return { kind: 'invalid', error: result.error.message };
  if ('status' in result.data && result.data.status === 'released') {
    return { kind: 'released', tombstone: result.data };
  }
  return { kind: 'active', lease: result.data as Lease };
}
