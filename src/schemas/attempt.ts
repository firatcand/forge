import { z } from 'zod';

import { byteBoundedString } from './byte-bounded.ts';

const Ts = z.string().datetime();
const Id = z.string().min(1).max(64);

export const AttemptEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attempt_started'),
    ts: Ts,
    attempt_id: Id,
    run_id: Id,
    claim_id: Id,
    generation: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('worktree_inspected'),
    ts: Ts,
    head_sha: z.string().min(7).max(40),
    dirty: z.boolean(),
    conflicts: z.boolean(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    ts: Ts,
    lease_expires_at: Ts,
  }),
  z.object({
    type: z.literal('files_modified'),
    ts: Ts,
    files: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('tests_run'),
    ts: Ts,
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    output_excerpt: byteBoundedString(2048),
  }),
  z.object({
    type: z.literal('lint_run'),
    ts: Ts,
    clean: z.boolean(),
    violations: z.number().int().min(0),
    output_excerpt: byteBoundedString(2048),
  }),
  z.object({
    type: z.literal('commit'),
    ts: Ts,
    sha: z.string().min(7).max(40),
    message_excerpt: byteBoundedString(200),
  }),
  z.object({
    type: z.literal('question_written'),
    ts: Ts,
    question_id: Id,
    decision_key: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('answer_observed'),
    ts: Ts,
    question_id: Id,
  }),
  // FORGE-65: the question verb hit the per-task hard_cap and proceeded without
  // asking. `reason` records the logged justification (AC7); `chosen_option_id`
  // is the option the worker is told to take (its recommendation, or null when
  // it fell back to the classification's default_action).
  z.object({
    type: z.literal('autonomous_decision'),
    ts: Ts,
    decision_key: z.string().min(1).max(200),
    chosen_option_id: z.string().min(1).max(64).nullable(),
    reason: byteBoundedString(2_000, { min: 1 }),
  }),
  z.object({
    type: z.literal('attempt_completed'),
    ts: Ts,
    verdict: z.enum(['ready_for_review', 'changes_needed', 'blocked']),
  }),
  z.object({
    type: z.literal('attempt_cancelled'),
    ts: Ts,
    reason: byteBoundedString(1000, { min: 1 }),
  }),
  z.object({
    type: z.literal('attempt_abandoned_by_steal'),
    ts: Ts,
    new_generation: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('lease_stolen'),
    ts: Ts,
    from_generation: z.number().int().min(0),
    to_generation: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('guardrail_checked'),
    ts: Ts,
    // Repo-relative path the worker is about to write to.
    path: z.string().min(1).max(1024),
    // The glob from settings.yaml#agents.preflight_globs that matched, if any.
    matched_glob: z.string().min(1).max(256).nullable(),
    // Stable suggested decision-key for the question the worker should write.
    // Null if the path did not match any guardrail.
    suggested_decision_key: z.string().min(1).max(200).nullable(),
  }),
]);

export type AttemptEvent = z.infer<typeof AttemptEventSchema>;

// FORGE-231: the dispatch-time attempt manifest (attempts/<id>/manifest.json).
// Previously written untyped by dispatch and hand-parsed by its readers
// (complete's resolveWorktreePath, render-worker-prompt). REVIEW/SHIP are
// first-class phase attempts (owner decision PA): `phase` discriminates them,
// and a review attempt carries BOTH pinned diff endpoints — review_base_sha is
// resolved at DISPATCH time so the reviewed range can never float.
export const ATTEMPT_PHASES = ['implement', 'review', 'ship'] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export const AttemptManifestSchema = z
  .object({
    version: z.literal(1),
    attempt_id: Id,
    task_id: Id,
    run_id: Id,
    claim_id: Id,
    generation: z.number().int().min(0),
    // default preserves legacy manifests written before FORGE-231.
    phase: z.enum(ATTEMPT_PHASES).default('implement'),
    worktree_path: z.string().min(1).max(4096),
    dispatched_at: Ts,
    review_target_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    review_base_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  })
  .refine(
    (m) => m.phase !== 'review' || (m.review_target_sha !== undefined && m.review_base_sha !== undefined),
    {
      message: 'review-phase manifests require review_target_sha and review_base_sha',
      path: ['review_target_sha'],
    },
  );

export type AttemptManifest = z.infer<typeof AttemptManifestSchema>;
