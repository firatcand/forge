// FORGE-235: the reconciliation journal (plan v3 Δ14 / v5 Δ20) and the merge
// attestation writer (v3 Δ12 / v5) — the two durable artifacts the merge tick
// owns.
//
// The journal is the STATUS owner for merge_pending observation: probe
// timestamps, uncertainty streaks, pending-since, the merge-call reservation,
// and tracker-sync progress. It is deliberately separate from the ship record
// so routine probes never advance the revision attestations bind to.
//
// The attestation is the ONE local artifact permitted to assert a merge fact,
// and only because this module enforces its provenance: create-only, written
// exclusively from an exact live proof, with the subject revalidated under the
// CAS marker. A DIFFERENT existing attestation is corruption — never
// overwritten (FORGE-233's invariant survives: bookkeeping asserts nothing;
// only proof-derived, provenance-enforced evidence does).

import { lstatSync, readFileSync } from 'node:fs';
import { CasError, OrchestratorError } from '../core/errors.ts';
import { casGuardedWrite, type CasHolderIdentity } from '../core/fs-atomic.ts';
import {
  MergeAttestationSchema,
  type MergeAttestation,
} from '../schemas/merge-attestation.ts';
import type { ShipRecord } from '../schemas/ship-record.ts';
import type { MergeResult } from '../repo-hosts/types.ts';
import {
  ReconciliationRecordSchema,
  type ReconciliationRecord,
  type ReconciliationSubject,
} from '../schemas/reconciliation.ts';
import { mergeAttestationFilePath, reconciliationFilePath } from './questions/paths.ts';

const FILE_MAX_BYTES = 256 * 1024;

// The merge tick has no worker lease (released on entering merge_pending), so
// CAS writes carry a synthetic holder identity naming the run.
export function tickHolder(runId: string): CasHolderIdentity {
  return { run_id: runId, claim_id: `merge-tick:${runId}`, generation: 0 };
}

function readGuarded(path: string, what: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OrchestratorError('IO_ERROR', `cannot stat ${what}`, { path, cause: err });
  }
  if (!st.isFile()) throw new OrchestratorError('IO_ERROR', `${what} is not a regular file`, { path });
  if (st.size > FILE_MAX_BYTES) throw new OrchestratorError('IO_ERROR', `${what} exceeds the size cap`, { path });
  return readFileSync(path, 'utf8');
}

function revisionOf(raw: string): number {
  const parsed = JSON.parse(raw) as { revision?: unknown };
  if (typeof parsed?.revision !== 'number' || !Number.isInteger(parsed.revision)) {
    throw new OrchestratorError('SCHEMA_INVALID', 'reconciliation.json has no integer revision', {});
  }
  return parsed.revision;
}

// ─── Journal ─────────────────────────────────────────────────────────────────

export function readReconciliationRecord(forgeDir: string, taskId: string): ReconciliationRecord | null {
  const raw = readGuarded(reconciliationFilePath(forgeDir, taskId), 'reconciliation.json');
  if (raw === null) return null;
  const parsed = ReconciliationRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError('SCHEMA_INVALID', `reconciliation.json for ${taskId} failed schema validation`, {
      taskId,
      zodError: parsed.error.message,
    });
  }
  if (parsed.data.task_id !== taskId) {
    throw new OrchestratorError('SCHEMA_INVALID', `reconciliation.json task_id ${parsed.data.task_id} != ${taskId}`, {
      taskId,
    });
  }
  return parsed.data;
}

export function sameSubject(a: ReconciliationSubject, b: ReconciliationSubject): boolean {
  return (
    a.cycle === b.cycle &&
    a.reviewed_head_sha === b.reviewed_head_sha &&
    a.ship_record_revision === b.ship_record_revision &&
    a.pr.repo === b.pr.repo &&
    a.pr.number === b.pr.number
  );
}

// A mutator may ABORT the write by throwing this. It propagates verbatim
// instead of being wrapped as an IO_ERROR, so callers can express
// "test-and-set inside the CAS" and reliably recognise their own refusal.
export class JournalAbort extends Error {
  constructor(readonly reason: string) {
    super(`journal mutation aborted: ${reason}`);
    this.name = 'JournalAbort';
  }
}

export interface JournalUpdate {
  subject: ReconciliationSubject;
  mutate: (current: ReconciliationRecord) => ReconciliationRecord;
  holder: CasHolderIdentity;
  now: () => Date;
}

// Fenced journal write. A subject change (refreshed PR / reviewed head / record
// revision / cycle) RESETS the observation status — stale streaks, pending
// timestamps, and reservations never describe a different subject (v5 Δ20).
export function updateReconciliationRecord(
  forgeDir: string,
  taskId: string,
  opts: JournalUpdate,
): ReconciliationRecord {
  const attempt = (): ReconciliationRecord => {
    const current = readReconciliationRecord(forgeDir, taskId);
    const base: ReconciliationRecord =
      current !== null && sameSubject(current.subject, opts.subject)
        ? current
        : {
            version: 1,
            task_id: taskId,
            revision: current?.revision ?? 0,
            subject: opts.subject,
            last_probed_at: null,
            last_probe_outcome: null,
            probe_failure_streak: 0,
            pending_since: null,
            merge_failure_streak: 0,
            last_merge_failure_at: null,
            merge_reservation: null,
            tracker_sync: { status: 'pending', attempts: 0, last_error: null, owner_run_id: null, reserved_at: null },
            updated_at: opts.now().toISOString(),
          };
    const next: ReconciliationRecord = {
      ...opts.mutate(base),
      version: 1,
      task_id: taskId,
      subject: opts.subject,
      revision: base.revision + 1,
      updated_at: opts.now().toISOString(),
    };
    const validated = ReconciliationRecordSchema.safeParse(next);
    if (!validated.success) {
      throw new OrchestratorError('SCHEMA_INVALID', `reconciliation.json for ${taskId} failed schema validation`, {
        taskId,
        zodError: validated.error.message,
      });
    }
    casGuardedWrite({
      filePath: reconciliationFilePath(forgeDir, taskId),
      expectedVersion: current === null ? 'create' : current.revision,
      holder: opts.holder,
      readVersion: revisionOf,
      buildContent: () => JSON.stringify(validated.data, null, 2),
    });
    return validated.data;
  };

  for (let round = 0; ; round += 1) {
    try {
      return attempt();
    } catch (err) {
      // A caller's deliberate abort is never a write failure.
      if (err instanceof JournalAbort) throw err;
      if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
        if (round === 0) continue; // one marker-held retry
        throw new OrchestratorError('STATE_VERSION_CONFLICT', `reconciliation.json for ${taskId} changed concurrently`, {
          taskId,
          cause: err,
        });
      }
      if (err instanceof OrchestratorError) throw err;
      throw new OrchestratorError('IO_ERROR', `reconciliation write failed for ${taskId}`, { taskId, cause: err });
    }
  }
}

// ─── Attestation ─────────────────────────────────────────────────────────────

export type AttestationRead =
  | { kind: 'valid'; attestation: MergeAttestation }
  | { kind: 'absent' }
  | { kind: 'invalid'; detail: string };

// Strict, capped, no-symlink read with path↔task_id binding (v3 Δ12). Any
// malformed / misbound artifact is INVALID — surfaced as operator action,
// never silently treated as absent (which would degrade into live-probe
// fallback and hide corruption).
export function readMergeAttestation(forgeDir: string, taskId: string): AttestationRead {
  let raw: string | null;
  try {
    raw = readGuarded(mergeAttestationFilePath(forgeDir, taskId), 'merge-attestation.json');
  } catch (err) {
    return { kind: 'invalid', detail: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { kind: 'absent' };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', detail: 'merge-attestation.json is not JSON' };
  }
  const parsed = MergeAttestationSchema.safeParse(parsedJson);
  if (!parsed.success) return { kind: 'invalid', detail: 'merge-attestation.json failed schema validation' };
  if (parsed.data.task_id !== taskId) {
    return { kind: 'invalid', detail: `attestation task_id ${parsed.data.task_id} != ${taskId}` };
  }
  if (parsed.data.merged_head_sha !== parsed.data.reviewed_head_sha) {
    // Self-inconsistent: an attestation may only exist for an exact-head merge.
    return { kind: 'invalid', detail: 'attestation merged_head_sha != reviewed_head_sha' };
  }
  return { kind: 'valid', attestation: parsed.data };
}

// Identity = every binding field. `attested_at` is deliberately excluded: a
// crash-resume replay re-derives the same witness at a later clock reading and
// must be recognised as the SAME attestation, not as corruption.
export function sameAttestationIdentity(a: MergeAttestation, b: MergeAttestation): boolean {
  return (
    a.task_id === b.task_id &&
    a.cycle === b.cycle &&
    a.pr.repo === b.pr.repo &&
    a.pr.number === b.pr.number &&
    a.base_repo === b.base_repo &&
    a.base_branch === b.base_branch &&
    a.reviewed_head_sha === b.reviewed_head_sha &&
    a.merged_head_sha === b.merged_head_sha &&
    a.merge_commit_sha === b.merge_commit_sha &&
    a.ship_record_revision === b.ship_record_revision
  );
}

export type AttestationWrite =
  | { kind: 'created'; attestation: MergeAttestation }
  | { kind: 'replayed'; attestation: MergeAttestation }
  | { kind: 'corrupt'; detail: string };

// PROOF-DERIVED, CREATE-ONLY writer. There is deliberately no way to hand this
// module a caller-authored attestation: the payload is built HERE from a live
// `MergeResult` plus the task's own ship record, and only after re-checking
// exactness (merged into the recorded base branch, at the recorded reviewed
// head). That keeps "an attestation exists" equivalent to "an exact live proof
// was observed" — the property the dependency gate and the promotion fence
// both rely on. The `fence` additionally revalidates the subject UNDER the CAS
// marker. An existing IDENTICAL attestation is replay success; an existing
// DIFFERENT one is corruption and is never overwritten.
export function mintMergeAttestation(
  forgeDir: string,
  taskId: string,
  input: {
    proof: MergeResult;
    record: ShipRecord;
    now: () => Date;
    holder: CasHolderIdentity;
    fence?: () => void;
  },
): AttestationWrite {
  const { proof, record } = input;
  if (record.task_id !== taskId) {
    return { kind: 'corrupt', detail: `ship record task_id ${record.task_id} != ${taskId}` };
  }
  if (record.pr === null || record.base === null) {
    return { kind: 'corrupt', detail: 'ship record has no pr/base binding to attest' };
  }
  if (!proof.merged) {
    return { kind: 'corrupt', detail: 'refusing to attest: the PR is not merged' };
  }
  if (proof.base_ref !== record.base.branch) {
    return {
      kind: 'corrupt',
      detail: `refusing to attest: merged into '${proof.base_ref}', recorded base is '${record.base.branch}'`,
    };
  }
  if (proof.merged_head_sha !== record.reviewed_head_sha) {
    return {
      kind: 'corrupt',
      detail: `refusing to attest: merged head ${proof.merged_head_sha} != reviewed head ${record.reviewed_head_sha}`,
    };
  }
  return writeMergeAttestation(
    forgeDir,
    taskId,
    {
      version: 1,
      task_id: taskId,
      cycle: record.cycle,
      pr: record.pr,
      base_repo: record.base.repo,
      base_branch: record.base.branch,
      reviewed_head_sha: record.reviewed_head_sha,
      merged_head_sha: proof.merged_head_sha,
      merge_commit_sha: proof.merge_commit_sha,
      ship_record_revision: record.revision,
      attested_at: input.now().toISOString(),
    },
    { holder: input.holder, fence: input.fence },
  );
}

// The low-level create-only write. NOT exported: `mintMergeAttestation` is the
// only way in, so an attestation can never be authored from anything but proof.
function writeMergeAttestation(
  forgeDir: string,
  taskId: string,
  attestation: MergeAttestation,
  opts: { holder: CasHolderIdentity; fence?: () => void },
): AttestationWrite {
  const existing = readMergeAttestation(forgeDir, taskId);
  if (existing.kind === 'invalid') {
    return { kind: 'corrupt', detail: `existing attestation is invalid: ${existing.detail}` };
  }
  if (existing.kind === 'valid') {
    if (sameAttestationIdentity(existing.attestation, attestation)) {
      opts.fence?.();
      return { kind: 'replayed', attestation: existing.attestation };
    }
    return { kind: 'corrupt', detail: 'a DIFFERENT attestation already exists — never overwritten' };
  }
  const validated = MergeAttestationSchema.safeParse(attestation);
  if (!validated.success) {
    return { kind: 'corrupt', detail: `attestation failed schema validation: ${validated.error.message}` };
  }
  try {
    casGuardedWrite({
      filePath: mergeAttestationFilePath(forgeDir, taskId),
      expectedVersion: 'create',
      holder: opts.holder,
      readVersion: () => 0,
      fence: opts.fence,
      buildContent: () => JSON.stringify(validated.data, null, 2),
    });
  } catch (err) {
    if (err instanceof CasError && (err.code === 'cas_conflict' || err.code === 'version_conflict')) {
      // A concurrent writer won the create race: accept ONLY an identical one.
      const now = readMergeAttestation(forgeDir, taskId);
      if (now.kind === 'valid' && sameAttestationIdentity(now.attestation, validated.data)) {
        return { kind: 'replayed', attestation: now.attestation };
      }
      return { kind: 'corrupt', detail: 'concurrent attestation write produced a different artifact' };
    }
    throw err;
  }
  return { kind: 'created', attestation: validated.data };
}
