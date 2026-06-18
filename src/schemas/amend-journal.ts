import { createHash } from 'node:crypto';
import { z } from 'zod';

import { ESTIMATES, OWNER_TYPES, PRIORITIES, TASK_TYPES } from './phases.ts';
import { EntryStatusSchema } from './apply-journal.ts';

// Journal for `forge orchestrate amend-roadmap` (FORGE-101).
//
// The verb is TRACKER-FIRST: it creates the issue + blocked-by relations on
// the tracker, then materializes the task into phases.yaml through the
// reconcile --pull machinery (staged addition) so the single-writer invariant
// — "phases.yaml is written only by the reconcile pull path" — holds. Each
// step is journaled so a partial failure resumes with --resume; the journal
// file itself (created with O_EXCL) doubles as the task-id reservation, so two
// concurrent amends that compute the same next id cannot both proceed.
//
// Mirrors the apply-decision journal discipline (src/schemas/apply-journal.ts):
// write-ahead pending entries, persist after every transition, archive to
// completed/ before unlinking the active journal.

// Payload authored by the /amend-roadmap skill (or a test fixture). The skill
// owns the interactive prompts; the verb only ever sees this validated shape.
export const AmendPayloadSchema = z
  .object({
    phase: z.string().regex(/^phase-\d+(\.\d+)?$/),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(10_000),
    type: z.enum(TASK_TYPES),
    priority: z.enum(PRIORITIES),
    // "No XL tasks ship — split them" (decompose hard rule). Refuse at the
    // schema layer so neither the skill nor a hand-authored payload can sneak
    // an XL task into the roadmap.
    estimate: z.enum(ESTIMATES).refine((e) => e !== 'XL', {
      message: 'XL tasks do not ship — split before amending (decompose hard rule)',
    }),
    owner_type: z.enum(OWNER_TYPES),
    acceptance: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    // Entries may be task ids (P2.5-T03) OR tracker identifiers (FORGE-93);
    // the verb resolves both against phases.yaml and refuses unknowns.
    depends_on: z.array(z.string().min(1).max(64)).max(50).default([]),
    write_globs: z.array(z.string().min(1).max(512)).max(50).optional(),
  })
  .strict();
export type AmendPayload = z.infer<typeof AmendPayloadSchema>;

// Canonical hash of the schema-NORMALIZED payload (not raw file bytes): key
// order is fixed by explicit field listing, depends_on is deduped + sorted.
// --resume compares this against the journal so a mutated payload can never
// silently graft onto a half-applied amend (Codex pre-opinion).
export function amendPayloadHash(payload: AmendPayload): string {
  const canonical = {
    phase: payload.phase,
    title: payload.title,
    description: payload.description,
    type: payload.type,
    priority: payload.priority,
    estimate: payload.estimate,
    owner_type: payload.owner_type,
    acceptance: payload.acceptance,
    depends_on: [...new Set(payload.depends_on)].sort(),
    write_globs: payload.write_globs ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const stepBase = {
  status: EntryStatusSchema,
  applied_at: z.string().datetime().optional(),
  error: z.string().max(4_000).optional(),
};

// Step 1: createIssue on the tracker. issue_id / identifier / url are recorded
// the moment the tracker returns so a crash immediately after creation is
// adoptable on --resume (exactly-one forgeTaskId match; see verb).
export const AmendCreateIssueStepSchema = z.object({
  ...stepBase,
  issue_id: z.string().min(1).max(128).optional(),
  identifier: z.string().min(1).max(64).optional(),
  url: z.string().max(2_048).optional(),
});
export type AmendCreateIssueStep = z.infer<typeof AmendCreateIssueStepSchema>;

// Step 2 (×N): one entry per dependency relation, independently resumable —
// no adapter wires relations inside createIssue (Codex pre-opinion), so every
// entry here is required work. blocker ids are resolved at PLAN time and
// frozen in the journal so --resume is deterministic.
export const AmendRelationStepSchema = z.object({
  ...stepBase,
  blocker_task_id: z.string().min(1).max(64),
  blocker_issue_id: z.string().min(1).max(128),
  retries: z.number().int().min(0).default(0),
});
export type AmendRelationStep = z.infer<typeof AmendRelationStepSchema>;

// Step 3: materialize into phases.yaml via reconcile --pull + staged addition.
export const AmendReconcileStepSchema = z.object({ ...stepBase });
export type AmendReconcileStep = z.infer<typeof AmendReconcileStepSchema>;

export const AmendJournalSchema = z.object({
  version: z.literal(1),
  task_id: z.string().regex(/^P\d+(\.\d+)?-T\d+$/),
  phase: z.string().regex(/^phase-\d+(\.\d+)?$/),
  payload: AmendPayloadSchema,
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  // depends_on resolved to canonical phases.yaml task ids (what the staged
  // task will carry), in sorted order.
  resolved_depends_on: z.array(z.string().min(1).max(64)).default([]),
  started_at: z.string().datetime(),
  create_issue: AmendCreateIssueStepSchema,
  relations: z.array(AmendRelationStepSchema).default([]),
  reconcile_pull: AmendReconcileStepSchema,
  completed_at: z.string().datetime().optional(),
});
export type AmendJournal = z.infer<typeof AmendJournalSchema>;
