// FORGE-233: the real SHIP dependency-merge gate (spec/ORCHESTRATOR.md Phase 3;
// plan v2-v4 in .forge/loop-notes/). READ-ONLY over dependency state — the
// merge_pending→shipped promotion belongs to FORGE-235's reconciliation.
//
// The ONLY positive vector is `live_merge_proof`: a platform-confirmed merge
// into the dependency's RECORDED base at its RECORDED reviewed head. Local
// artifacts never satisfy: task state 'shipped' merely selects the probe (its
// ship record is write-ahead bookkeeping, populated BEFORE any merge —
// src/schemas/ship-record.ts), phases.yaml status is a stale cache, tracker
// status is never merge proof (ORCHESTRATOR:880).

import { lstatSync, readFileSync } from 'node:fs';
import { OrchestratorError } from '../core/errors.ts';
import type { Task } from '../schemas/phases.ts';
import {
  dispositionFor,
  gateRetriable,
  DependencyGateReportSchema,
  type DepEntry,
  type DependencyGateReport,
  type DepUnsatisfiedReason,
} from '../schemas/dependency-gate.ts';
import { ShipRecordSchema, type ShipRecord } from '../schemas/ship-record.ts';
import { TASK_ID_RE } from '../schemas/task-id.ts';
import type { MergeResult } from '../repo-hosts/types.ts';
import { readTaskState } from './state-machine.ts';
import { readMergeAttestation } from './reconciliation-record.ts';
import { shipRecordFilePath, stateFilePath } from './questions/paths.ts';

const RECORD_MAX_BYTES = 256 * 1024;

/** The gate needs exactly one observation capability (Codex plan R1 #4). */
export type DependencyObserver = { mergeResult: (pr: { repo: string; number: number; url: string }) => Promise<MergeResult> };

export interface DependencyGateOptions {
  forgeDir: string;
  /** The SUBJECT task id as supplied by the verb (dispatch/complete). */
  taskId: string;
  /** Latest phases.yaml tasks (flattened). */
  tasks: readonly Task[];
  /**
   * Observation factory per dependency STATE id. Returns null when no usable
   * persisted PR identity exists (the gate maps null per its reason taxonomy).
   * Production wiring lives in the CLI layer; tests inject fakes.
   */
  observerFor: (depStateId: string) => Promise<DependencyObserver | null>;
}

// ─── Global alias-owner index (plan v4 ΔA) ───────────────────────────────────

// Every identifier in {task.id} ∪ {task.tracker_issue_id} maps to exactly one
// owning task; ANY identifier claimed by two different tasks (including
// cross-namespace: one task's tracker_issue_id equals another task's id) is
// ambiguous and must never resolve — before any state or record access.
type AliasIndex = Map<string, { task: Task; ambiguous: boolean }>;

export function buildAliasIndex(tasks: readonly Task[]): AliasIndex {
  const index: AliasIndex = new Map();
  const claim = (alias: string, task: Task): void => {
    const existing = index.get(alias);
    if (existing === undefined) {
      index.set(alias, { task, ambiguous: false });
    } else if (existing.task !== task) {
      existing.ambiguous = true;
    }
  };
  for (const task of tasks) {
    claim(task.id, task);
    if (task.tracker_issue_id !== undefined) claim(task.tracker_issue_id, task);
  }
  return index;
}

// ─── Strict per-dependency readers ───────────────────────────────────────────

type StateRead =
  | { kind: 'valid'; state: string }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string };

// 'invalid' NEVER collapses into 'absent' (Codex plan R1 #3): while any
// resolution shortcut exists, a corrupt state must block, not vanish.
function readDependencyState(forgeDir: string, stateId: string): StateRead {
  let st;
  try {
    st = lstatSync(stateFilePath(forgeDir, stateId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', detail: `state unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!st.isFile()) return { kind: 'invalid', detail: 'state.json is not a regular file' };
  if (st.size > RECORD_MAX_BYTES) return { kind: 'invalid', detail: 'state.json exceeds the size cap' };
  try {
    const record = readTaskState(forgeDir, stateId);
    if (record.task_id !== stateId) {
      return { kind: 'invalid', detail: `state payload task_id ${record.task_id} != directory ${stateId}` };
    }
    return { kind: 'valid', state: record.state };
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'STATE_NOT_FOUND') return { kind: 'absent' };
    return { kind: 'invalid', detail: err instanceof Error ? err.message : String(err) };
  }
}

type RecordRead =
  | { kind: 'valid'; record: ShipRecord }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string };

// Strict gate-local record read (plan v4 Δ1): unlike readShipRecord, this
// BINDS record.task_id to the directory id — a restored/copied record from
// another task is invalid, never a probe source.
function readDependencyShipRecord(forgeDir: string, stateId: string): RecordRead {
  const p = shipRecordFilePath(forgeDir, stateId);
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', detail: `ship record unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!st.isFile()) return { kind: 'invalid', detail: 'ship-record.json is not a regular file' };
  if (st.size > RECORD_MAX_BYTES) return { kind: 'invalid', detail: 'ship-record.json exceeds the size cap' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    return { kind: 'invalid', detail: `ship record is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const validated = ShipRecordSchema.safeParse(parsed);
  if (!validated.success) return { kind: 'invalid', detail: 'ship record failed schema validation' };
  if (validated.data.task_id !== stateId) {
    return { kind: 'invalid', detail: `ship record task_id ${validated.data.task_id} != directory ${stateId}` };
  }
  return { kind: 'valid', record: validated.data };
}

// ─── Gate evaluation ─────────────────────────────────────────────────────────

interface UnsatisfiedFields {
  resolved_task_id?: string | null;
  state_id?: string | null;
  observed_state?: string | null;
  detail?: string;
  observed?: { base_ref?: string; merged_head_sha?: string } | null;
  expected?: { base_branch?: string; reviewed_head_sha?: string } | null;
}

function unsatisfied(
  declaredId: string,
  reason: DepUnsatisfiedReason,
  fields: UnsatisfiedFields = {},
): DepEntry {
  const observedState = fields.observed_state ?? null;
  return {
    declared_id: declaredId,
    resolved_task_id: fields.resolved_task_id ?? null,
    state_id: fields.state_id ?? null,
    observed_state: observedState,
    satisfied: false,
    reason,
    disposition: dispositionFor(reason, observedState),
    detail: fields.detail,
    observed: fields.observed ?? null,
    expected: fields.expected ?? null,
  };
}

async function evaluateDep(
  opts: DependencyGateOptions,
  index: AliasIndex,
  declaredId: string,
): Promise<DepEntry> {
  const entry = index.get(declaredId);
  if (entry === undefined) return unsatisfied(declaredId, 'unknown_dependency');
  if (entry.ambiguous) {
    return unsatisfied(declaredId, 'ambiguous_identity', {
      detail: `identifier ${declaredId} is claimed by more than one task`,
    });
  }
  const depTask = entry.task;
  const stateId = depTask.tracker_issue_id ?? depTask.id;

  // The CANONICAL id must itself be unambiguously owned by this dep (plan v4
  // ΔA): when A.tracker_issue_id equals B.id, directory `stateId` may hold
  // B's perfectly valid state — resolution through it must refuse, or B's
  // merge would satisfy A.
  const canonicalEntry = index.get(stateId);
  if (canonicalEntry === undefined || canonicalEntry.ambiguous || canonicalEntry.task !== depTask) {
    return unsatisfied(declaredId, 'ambiguous_identity', {
      resolved_task_id: depTask.id,
      detail: `canonical state id ${stateId} is not uniquely owned by ${depTask.id}`,
    });
  }

  // Canonical id must satisfy the orchestrator path contract BEFORE any
  // filesystem access (plan v3 Δ2) — a schema-valid `gh#42` tracker id becomes
  // an in-report refusal, never an INVALID_ID throw.
  if (!TASK_ID_RE.test(stateId)) {
    return unsatisfied(declaredId, 'invalid_identity', {
      resolved_task_id: depTask.id,
      detail: `canonical state id ${JSON.stringify(stateId)} violates the orchestrator id contract`,
    });
  }

  // Alias-directory conflict: when the dep's phase id and tracker id BOTH have
  // state directories, identity is ambiguous (no alias shopping — R1 #3).
  if (depTask.tracker_issue_id !== undefined && depTask.tracker_issue_id !== depTask.id) {
    const aliasState = TASK_ID_RE.test(depTask.id) ? readDependencyState(opts.forgeDir, depTask.id) : { kind: 'absent' as const };
    if (aliasState.kind !== 'absent') {
      const canonicalState = readDependencyState(opts.forgeDir, stateId);
      if (canonicalState.kind !== 'absent') {
        return unsatisfied(declaredId, 'ambiguous_identity', {
          resolved_task_id: depTask.id,
          detail: `state directories exist under BOTH ${depTask.id} and ${stateId}`,
        });
      }
    }
  }

  const stateRead = readDependencyState(opts.forgeDir, stateId);
  if (stateRead.kind === 'invalid') {
    return unsatisfied(declaredId, 'state_invalid', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      detail: stateRead.detail,
    });
  }
  if (stateRead.kind === 'absent') {
    // NO phases.yaml/tracker fallback (Codex plan R1 CRIT #1): a local cache
    // is never merge proof. Historic escape = future explicit attestation.
    return unsatisfied(declaredId, 'legacy_dependency_unproven', {
      resolved_task_id: depTask.id,
      state_id: stateId,
    });
  }

  const state = stateRead.state;
  if (state !== 'shipped' && state !== 'merge_pending') {
    return unsatisfied(declaredId, 'dep_state_blocking', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
    });
  }

  // shipped OR merge_pending → the record supplies the probe identity.
  const recordRead = readDependencyShipRecord(opts.forgeDir, stateId);
  if (recordRead.kind === 'invalid') {
    return unsatisfied(declaredId, 'ship_record_invalid', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: recordRead.detail,
    });
  }
  if (recordRead.kind === 'absent') {
    return unsatisfied(declaredId, state === 'shipped' ? 'shipped_unproven' : 'ship_record_incomplete', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: 'no ship record',
    });
  }
  const record = recordRead.record;
  if (record.pr === null || record.base === null) {
    // merge_pending without a PR identity is durable invariant damage —
    // waiting can never heal it (plan v3 Δ3). shipped without identity is the
    // unproven-legacy case.
    return unsatisfied(declaredId, state === 'shipped' ? 'shipped_unproven' : 'ship_record_incomplete', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: record.pr === null ? 'ship record has no pr' : 'ship record has no base',
    });
  }

  // ── FORGE-235: the SECOND positive vector — a provenance-enforced merge
  // attestation. Unlike the ship record (write-ahead bookkeeping populated
  // BEFORE any merge), an attestation is created exclusively from an exact
  // live mergeResult proof under a marker-held revalidation, so it is a
  // durable WITNESS of prior live proof rather than an assertion. It must
  // match this dep's CURRENT record exactly; anything else is operator action.
  // The attestation is only honoured for a dependency whose own lifecycle has
  // COMPLETED (`shipped`). A task still in `merge_pending` has an attestation
  // only in the write-ahead window before its promotion CAS, and that window is
  // exactly when the binding is least settled — fall through to the live probe
  // there rather than widening the offline path.
  const attRead = state === 'shipped' ? readMergeAttestation(opts.forgeDir, stateId) : { kind: 'absent' as const };
  if (attRead.kind === 'invalid') {
    return unsatisfied(declaredId, 'attestation_invalid', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: attRead.detail,
    });
  }
  if (attRead.kind === 'valid') {
    const att = attRead.attestation;
    const matches =
      att.task_id === stateId &&
      att.cycle === record.cycle &&
      att.pr.repo === record.pr.repo &&
      att.pr.number === record.pr.number &&
      att.base_repo === record.base.repo &&
      att.base_branch === record.base.branch &&
      att.reviewed_head_sha === record.reviewed_head_sha &&
      att.merged_head_sha === record.reviewed_head_sha &&
      att.ship_record_revision === record.revision;
    if (!matches) {
      return unsatisfied(declaredId, 'attestation_invalid', {
        resolved_task_id: depTask.id,
        state_id: stateId,
        observed_state: state,
        detail: 'attestation does not match the dependency\'s current record binding',
      });
    }
    return {
      declared_id: declaredId,
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      satisfied: true,
      vector: 'merge_attestation',
      disposition: 'satisfied',
      observed: { base_ref: att.base_branch, merged_head_sha: att.merged_head_sha },
    };
  }

  // ── Fallback: live platform merge proof (absent attestation) ──
  let observer: DependencyObserver | null;
  try {
    observer = await opts.observerFor(stateId);
  } catch (err) {
    observer = null;
    return unsatisfied(declaredId, 'probe_unavailable', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  if (observer === null) {
    return unsatisfied(declaredId, 'probe_unavailable', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: 'no repo host observer available',
    });
  }
  let result: MergeResult;
  try {
    result = await observer.mergeResult(record.pr);
  } catch (err) {
    return unsatisfied(declaredId, 'probe_unavailable', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const expected = { base_branch: record.base.branch, reviewed_head_sha: record.reviewed_head_sha };
  if (result.merged) {
    if (result.base_ref === record.base.branch && result.merged_head_sha === record.reviewed_head_sha) {
      return {
        declared_id: declaredId,
        resolved_task_id: depTask.id,
        state_id: stateId,
        observed_state: state,
        satisfied: true,
        vector: 'live_merge_proof',
        disposition: 'satisfied',
        observed: { base_ref: result.base_ref, merged_head_sha: result.merged_head_sha },
      };
    }
    return unsatisfied(declaredId, 'tainted_merge', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      observed: { base_ref: result.base_ref, merged_head_sha: result.merged_head_sha },
      expected,
    });
  }
  if (result.state === 'open') {
    return unsatisfied(declaredId, 'not_merged', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      expected,
    });
  }
  if (result.state === 'closed_unmerged') {
    return unsatisfied(declaredId, 'pr_closed_unmerged', {
      resolved_task_id: depTask.id,
      state_id: stateId,
      observed_state: state,
      expected,
    });
  }
  return unsatisfied(declaredId, 'probe_unavailable', {
    resolved_task_id: depTask.id,
    state_id: stateId,
    observed_state: state,
    detail: result.reason ?? 'merge state unknown',
  });
}

export async function evaluateShipDependencyGate(opts: DependencyGateOptions): Promise<DependencyGateReport> {
  const index = buildAliasIndex(opts.tasks);

  // Exact-one SUBJECT resolution through the SAME index (plan v4 ΔB): a
  // subject missing from phases.yaml must never synthesize dependsOn: [].
  const subjectEntry = index.get(opts.taskId);
  const build = (report: Omit<DependencyGateReport, 'version'>): DependencyGateReport => {
    const full = { version: 1 as const, ...report };
    const validated = DependencyGateReportSchema.safeParse(full);
    if (!validated.success) {
      throw new OrchestratorError('SCHEMA_INVALID', 'dependency gate produced an invalid report', {
        taskId: opts.taskId,
        zodError: validated.error.message,
      });
    }
    return validated.data;
  };

  if (subjectEntry === undefined) {
    return build({
      task_id: opts.taskId,
      subject: { resolved: false, reason: 'subject_unresolved', detail: `task ${opts.taskId} not found in phases.yaml` },
      satisfied: false,
      deps: [],
      duplicate_declared_ids: [],
    });
  }
  if (subjectEntry.ambiguous) {
    return build({
      task_id: opts.taskId,
      subject: { resolved: false, reason: 'subject_ambiguous', detail: `identifier ${opts.taskId} is claimed by more than one task` },
      satisfied: false,
      deps: [],
      duplicate_declared_ids: [],
    });
  }
  const subject = subjectEntry.task;
  const subjectCanonical = subject.tracker_issue_id ?? subject.id;
  // Symmetric to the dependency path (impl-R1 MAJ #1): a subject whose
  // canonical lifecycle id cannot legally own an orchestrator path must
  // refuse — never resolve and satisfy vacuously.
  if (!TASK_ID_RE.test(subjectCanonical)) {
    return build({
      task_id: opts.taskId,
      subject: {
        resolved: false,
        reason: 'subject_invalid_identity',
        detail: `canonical state id ${JSON.stringify(subjectCanonical)} violates the orchestrator id contract`,
      },
      satisfied: false,
      deps: [],
      duplicate_declared_ids: [],
    });
  }
  const subjectCanonicalEntry = index.get(subjectCanonical);
  if (subjectCanonicalEntry === undefined || subjectCanonicalEntry.ambiguous || subjectCanonicalEntry.task !== subject) {
    return build({
      task_id: opts.taskId,
      subject: {
        resolved: false,
        reason: 'subject_ambiguous',
        detail: `canonical state id ${subjectCanonical} is not uniquely owned by ${subject.id}`,
      },
      satisfied: false,
      deps: [],
      duplicate_declared_ids: [],
    });
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const declared: string[] = [];
  for (const depId of subject.depends_on) {
    if (seen.has(depId)) {
      duplicates.add(depId);
      continue;
    }
    seen.add(depId);
    declared.push(depId);
  }

  const deps: DepEntry[] = [];
  for (const depId of declared) {
    deps.push(await evaluateDep(opts, index, depId));
  }

  return build({
    task_id: opts.taskId,
    subject: { resolved: true, task_id: subject.id },
    satisfied: deps.every((d) => d.satisfied),
    deps,
    duplicate_declared_ids: [...duplicates].sort(),
  });
}

export { gateRetriable };
