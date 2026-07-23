// FORGE-233: the SHIP dependency-merge gate report (spec/ORCHESTRATOR.md
// Phase 3 dependency check; plan v2-v4). A versioned, genuinely discriminated
// consumer contract: FORGE-234 and the dispatch skill route on closed enums —
// never string inspection. The ONLY positive vector is a live platform merge
// proof; every local artifact (task state, ship record, phases.yaml) is
// bookkeeping, not proof.

import { z } from 'zod';

export const DEP_WAITING_REASONS = ['not_merged', 'probe_unavailable'] as const;
export const DEP_OPERATOR_REASONS = [
  'unknown_dependency',
  'ambiguous_identity',
  'invalid_identity',
  'state_invalid',
  'ship_record_invalid',
  'ship_record_incomplete',
  'shipped_unproven',
  'pr_closed_unmerged',
  'tainted_merge',
  'legacy_dependency_unproven',
] as const;

// dep_state_blocking dispositions depend on the observed state: an ACTIVE dep
// (still working toward merge) is 'waiting'; failed/cancelled can never merge
// unattended → 'operator_action'. The map lives here so schema and gate agree.
export const BLOCKING_WAITING_STATES = new Set([
  'claimed',
  'dispatched',
  'running',
  'blocked_on_question',
  'awaiting_respawn',
  'ready_for_review',
  'reviewed',
]);

export type DepUnsatisfiedReason =
  | (typeof DEP_WAITING_REASONS)[number]
  | (typeof DEP_OPERATOR_REASONS)[number]
  | 'dep_state_blocking';

export function dispositionFor(reason: DepUnsatisfiedReason, observedState: string | null): 'waiting' | 'operator_action' {
  if (reason === 'dep_state_blocking') {
    return observedState !== null && BLOCKING_WAITING_STATES.has(observedState) ? 'waiting' : 'operator_action';
  }
  return (DEP_WAITING_REASONS as readonly string[]).includes(reason) ? 'waiting' : 'operator_action';
}

const ShaPair = z.object({
  base_ref: z.string().optional(),
  merged_head_sha: z.string().optional(),
  base_branch: z.string().optional(),
  reviewed_head_sha: z.string().optional(),
});

const DepSatisfiedSchema = z.object({
  declared_id: z.string(),
  resolved_task_id: z.string(),
  state_id: z.string(),
  observed_state: z.string(),
  satisfied: z.literal(true),
  vector: z.literal('live_merge_proof'),
  disposition: z.literal('satisfied'),
  observed: ShaPair,
});

// NOTE: discriminated-union members must be plain ZodObjects, so the fixed
// reason→disposition map is enforced by the top-level report refine below
// (and produced exclusively via dispositionFor in the gate).
const DepUnsatisfiedSchema = z.object({
  declared_id: z.string(),
  resolved_task_id: z.string().nullable(),
  state_id: z.string().nullable(),
  observed_state: z.string().nullable(),
  satisfied: z.literal(false),
  reason: z.enum([...DEP_WAITING_REASONS, ...DEP_OPERATOR_REASONS, 'dep_state_blocking']),
  disposition: z.enum(['waiting', 'operator_action']),
  detail: z.string().max(2000).optional(),
  observed: ShaPair.nullable(),
  expected: ShaPair.nullable(),
});

export const DepEntrySchema = z.discriminatedUnion('satisfied', [DepSatisfiedSchema, DepUnsatisfiedSchema]);
export type DepEntry = z.infer<typeof DepEntrySchema>;

const SubjectResolvedSchema = z.object({
  resolved: z.literal(true),
  task_id: z.string(),
});
const SubjectUnresolvedSchema = z.object({
  resolved: z.literal(false),
  reason: z.enum(['subject_unresolved', 'subject_ambiguous']),
  detail: z.string().max(2000).optional(),
});

export const DependencyGateReportSchema = z
  .object({
    version: z.literal(1),
    task_id: z.string(),
    subject: z.discriminatedUnion('resolved', [SubjectResolvedSchema, SubjectUnresolvedSchema]),
    satisfied: z.boolean(),
    deps: z.array(DepEntrySchema),
    // Deterministic, sorted; a dedup that changed the evaluated set must be
    // visible to consumers (Codex plan R2 #5).
    duplicate_declared_ids: z.array(z.string()),
  })
  // An unresolved subject can never be satisfied, and empty deps are legal
  // ONLY when derived from a resolved subject (Codex plan R3 ΔB).
  .refine((r) => r.satisfied === (r.subject.resolved && r.deps.every((d) => d.satisfied)), {
    message: 'satisfied must equal subject.resolved && all deps satisfied',
    path: ['satisfied'],
  })
  // The fixed reason→disposition map (Codex plan R2 #4): schema-valid reports
  // can never carry a contradictory disposition.
  .refine(
    (r) => r.deps.every((d) => d.satisfied || d.disposition === dispositionFor(d.reason, d.observed_state)),
    { message: 'disposition must follow the fixed reason→disposition map', path: ['deps'] },
  );

export type DependencyGateReport = z.infer<typeof DependencyGateReportSchema>;

/** retriable iff every blocker is a pure waiting condition. */
export function gateRetriable(report: DependencyGateReport): boolean {
  if (report.satisfied) return true;
  if (!report.subject.resolved) return false;
  return report.deps.every((d) => d.satisfied || d.disposition === 'waiting');
}
