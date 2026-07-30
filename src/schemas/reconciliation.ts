import { z } from 'zod';
import { PullRequestRefSchema } from './ship-record.ts';

// FORGE-235 (plan v3 Δ14 / v5 Δ20): the durable reconciliation journal —
// the status owner for merge_pending observation. Deliberately SEPARATE from
// the ship record so routine probe timestamps never advance the revision that
// attestations bind to.
//
// Subject scope is {cycle, pr, reviewed_head_sha, ship_record_revision}: a
// refreshed PR or reviewed head invalidates pending timestamps, streaks, and
// reservations even without a numeric cycle change.

export const MergeReservationSchema = z.object({
  cycle: z.number().int().min(1),
  seq: z.number().int().min(1),
  status: z.enum(['reserved', 'settled']),
  owner_run_id: z.string().min(1).max(64),
  reserved_at: z.string().datetime(),
  outcome: z.string().max(200).nullable(),
});
export type MergeReservation = z.infer<typeof MergeReservationSchema>;

export const ReconciliationSubjectSchema = z.object({
  cycle: z.number().int().min(1),
  pr: PullRequestRefSchema,
  reviewed_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  ship_record_revision: z.number().int().min(1),
});
export type ReconciliationSubject = z.infer<typeof ReconciliationSubjectSchema>;

export const ReconciliationRecordSchema = z.object({
  version: z.literal(1),
  task_id: z.string().min(1).max(64),
  // monotonic, +1 per fenced write; casGuardedWrite serializes on it.
  revision: z.number().int().min(1),
  subject: ReconciliationSubjectSchema,
  last_probed_at: z.string().datetime().nullable(),
  last_probe_outcome: z.string().max(200).nullable(),
  // Transport/schema/unknown UNCERTAINTY only. A long-running pending check is
  // expected waiting and is tracked by pending_since — never this streak.
  probe_failure_streak: z.number().int().min(0),
  pending_since: z.string().datetime().nullable(),
  // FORGE-235 records unexplained merge-call failures HERE ONLY (no task-state
  // mutation — plan v5 Δ17). FORGE-237 converts the streak into budget charges
  // once it owns the escalation destinations.
  merge_failure_streak: z.number().int().min(0),
  last_merge_failure_at: z.string().datetime().nullable(),
  merge_reservation: MergeReservationSchema.nullable(),
  tracker_sync: z.object({
    status: z.enum(['pending', 'done', 'failed']),
    attempts: z.number().int().min(0),
    last_error: z.string().max(500).nullable(),
    // FORGE-235: who is CURRENTLY inside markDone, and since when. Without
    // this, `pending` cannot distinguish "an attempt is in flight" from
    // "settled, retry later" — so a contender would count the in-flight
    // attempt as consumed and emit a false exhaustion fatal, and a crash
    // mid-call would leave the budget permanently ambiguous.
    owner_run_id: z.string().min(1).max(120).nullable().default(null),
    reserved_at: z.string().datetime().nullable().default(null),
  }),
  updated_at: z.string().datetime(),
});
export type ReconciliationRecord = z.infer<typeof ReconciliationRecordSchema>;
