import { z } from 'zod';
import { PullRequestRefSchema } from './ship-record.ts';

// FORGE-235: the durable merge attestation (plan v3 Δ12 / v5). This is the ONE
// local artifact that may assert a merge fact — and only because its write
// protocol enforces provenance: it is created EXCLUSIVELY from an exact live
// `mergeResult` proof, under a marker-held revalidation of state + cycle + PR +
// reviewed binding + ship-record revision, create-only (a DIFFERENT existing
// attestation is corruption, never overwritten).
//
// Contrast with the ship record (write-ahead bookkeeping populated BEFORE any
// merge — asserts nothing; FORGE-233's invariant).
export const MergeAttestationSchema = z.object({
  version: z.literal(1),
  task_id: z.string().min(1).max(64),
  cycle: z.number().int().min(1),
  pr: PullRequestRefSchema,
  base_repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  base_branch: z.string().min(1).max(200),
  reviewed_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  // Equal to reviewed_head_sha by construction — recorded explicitly so a
  // reader can verify the equality that made this attestation legal.
  merged_head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  merge_commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  // The ship-record revision the proof was taken against; a later record
  // revision invalidates the attestation for gate purposes.
  ship_record_revision: z.number().int().min(1),
  attested_at: z.string().datetime(),
});
export type MergeAttestation = z.infer<typeof MergeAttestationSchema>;
