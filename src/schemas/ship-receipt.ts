import { z } from 'zod';
import { PullRequestRefSchema } from './ship-record.ts';

// FORGE-234: the fenced SHIP-operation receipt (plan v3 Δ10 + R3 ΔR1/ΔR2).
// Written by the ship verb UNDER the ship fence AFTER the tracker step — the
// proof that verify, secrets, the SHA-bound push, PR binding, and the tracker
// mutation all completed for THIS attempt at THIS target. complete requires
// it ONLY for the SUCCESS outcome (ready_for_review → merge_pending);
// budgeted failures complete without one (no receipt can exist when a
// pre-milestone step failed).
export const ShipReceiptSchema = z.object({
  version: z.literal(1),
  task_id: z.string().min(1).max(64),
  attempt_id: z.string().min(1).max(64),
  target_sha: z.string().regex(/^[0-9a-f]{40}$/),
  // The state_version captured at ship admission: a park/answer round-trip
  // (reviewed → blocked_on_question → reviewed) preserves every other
  // identity — only this pin invalidates the stale invocation (R3 ΔR2).
  admitted_state_version: z.number().int().min(0),
  // 'passed' = auto-policy honesty probe passed the bar; 'skipped_approval' =
  // approval policy (no bar). A skipped_approval receipt never authorizes
  // completion after a policy flip to 'auto'.
  probe: z.enum(['passed', 'skipped_approval']),
  pushed: z.literal(true),
  pr: PullRequestRefSchema,
  tracker_updated: z.literal(true),
  created_at: z.string().datetime(),
});
export type ShipReceipt = z.infer<typeof ShipReceiptSchema>;
