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
});

export type Lease = z.infer<typeof LeaseSchema>;
