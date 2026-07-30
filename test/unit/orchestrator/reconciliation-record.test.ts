// FORGE-235: the two durable artifacts the merge tick owns — the
// reconciliation journal (status) and the merge attestation (proof witness).
//
// The attestation's value rests entirely on its provenance rules, so they are
// tested directly here rather than only through the coordinator.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OrchestratorError } from '../../../src/core/errors.ts';
import {
  mintMergeAttestation,
  readMergeAttestation,
  readReconciliationRecord,
  sameSubject,
  tickHolder,
  updateReconciliationRecord,
} from '../../../src/orchestrator/reconciliation-record.ts';
import type { MergeAttestation } from '../../../src/schemas/merge-attestation.ts';
import type { ReconciliationSubject } from '../../../src/schemas/reconciliation.ts';
import type { ShipRecord } from '../../../src/schemas/ship-record.ts';
import type { MergeResult } from '../../../src/repo-hosts/types.ts';

const TASK = 'FORGE-J1';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const PR = { repo: 'octo/base', number: 4, url: 'https://github.com/octo/base/pull/4' };
const HOLDER = tickHolder('run-j');

const SUBJECT: ReconciliationSubject = { cycle: 1, pr: PR, reviewed_head_sha: SHA, ship_record_revision: 2 };
const now = (): Date => new Date();

function taskDir(): string {
  const forgeDir = mkdtempSync(join(tmpdir(), 'forge-235-j-'));
  mkdirSync(join(forgeDir, 'orchestrator', 'tasks', TASK), { recursive: true });
  return forgeDir;
}

const attestationOf = (over: Partial<MergeAttestation> = {}): MergeAttestation => ({
  version: 1,
  task_id: TASK,
  cycle: 1,
  pr: PR,
  base_repo: 'octo/base',
  base_branch: 'main',
  reviewed_head_sha: SHA,
  merged_head_sha: SHA,
  merge_commit_sha: COMMIT,
  ship_record_revision: 2,
  attested_at: new Date().toISOString(),
  ...over,
});

const RECORD: ShipRecord = {
  version: 1,
  task_id: TASK,
  revision: 2,
  reviewed_head_sha: SHA,
  review_attempt_id: 'att-rev',
  cycle: 1,
  base: { repo: 'octo/base', branch: 'main', push_remote: 'origin' },
  pr: PR,
  merge_attempt: 'submitted',
  updated_at: new Date().toISOString(),
};

const PROOF: MergeResult = { merged: true, base_ref: 'main', merge_commit_sha: COMMIT, merged_head_sha: SHA };

/** The ONLY way to author an attestation: proof + record, checked internally. */
const mint = (
  fd: string,
  over: { proof?: MergeResult; record?: ShipRecord; fence?: () => void; taskId?: string } = {},
) =>
  mintMergeAttestation(fd, over.taskId ?? TASK, {
    proof: over.proof ?? PROOF,
    record: over.record ?? RECORD,
    now,
    holder: HOLDER,
    ...(over.fence ? { fence: over.fence } : {}),
  });

const attPath = (fd: string): string => join(fd, 'orchestrator', 'tasks', TASK, 'merge-attestation.json');

// ─── Journal ─────────────────────────────────────────────────────────────────

test('an absent journal reads as null and is created at revision 1', () => {
  const fd = taskDir();
  assert.equal(readReconciliationRecord(fd, TASK), null);

  const created = updateReconciliationRecord(fd, TASK, {
    subject: SUBJECT,
    holder: HOLDER,
    now,
    mutate: (cur) => ({ ...cur, last_probe_outcome: 'open' }),
  });
  assert.equal(created.revision, 1);
  assert.equal(created.task_id, TASK);
  assert.equal(created.last_probe_outcome, 'open');
  assert.equal(created.tracker_sync.status, 'pending');
});

test('each fenced write advances the revision monotonically', () => {
  const fd = taskDir();
  for (let i = 1; i <= 3; i += 1) {
    const rec = updateReconciliationRecord(fd, TASK, {
      subject: SUBJECT,
      holder: HOLDER,
      now,
      mutate: (cur) => ({ ...cur, probe_failure_streak: cur.probe_failure_streak + 1 }),
    });
    assert.equal(rec.revision, i);
    assert.equal(rec.probe_failure_streak, i);
  }
});

test('a subject change RESETS observation status — stale streaks never describe a new subject', () => {
  const fd = taskDir();
  updateReconciliationRecord(fd, TASK, {
    subject: SUBJECT,
    holder: HOLDER,
    now,
    mutate: (cur) => ({
      ...cur,
      probe_failure_streak: 5,
      merge_failure_streak: 4,
      pending_since: new Date().toISOString(),
      merge_reservation: { cycle: 1, seq: 1, status: 'reserved', owner_run_id: 'run-j', reserved_at: new Date().toISOString(), outcome: null },
    }),
  });

  const rotated = updateReconciliationRecord(fd, TASK, {
    subject: { ...SUBJECT, ship_record_revision: 3 },
    holder: HOLDER,
    now,
    mutate: (cur) => cur,
  });
  assert.equal(rotated.probe_failure_streak, 0);
  assert.equal(rotated.merge_failure_streak, 0);
  assert.equal(rotated.pending_since, null);
  assert.equal(rotated.merge_reservation, null, 'a reservation never survives a subject rotation');
  assert.equal(rotated.revision, 2, 'the revision still advances monotonically across the reset');
});

test('sameSubject compares the full binding, not just the cycle', () => {
  assert.equal(sameSubject(SUBJECT, { ...SUBJECT }), true);
  assert.equal(sameSubject(SUBJECT, { ...SUBJECT, cycle: 2 }), false);
  assert.equal(sameSubject(SUBJECT, { ...SUBJECT, reviewed_head_sha: OTHER }), false);
  assert.equal(sameSubject(SUBJECT, { ...SUBJECT, ship_record_revision: 9 }), false);
  assert.equal(sameSubject(SUBJECT, { ...SUBJECT, pr: { ...PR, number: 5 } }), false);
});

test('a journal naming another task is refused, never adopted', () => {
  const fd = taskDir();
  updateReconciliationRecord(fd, TASK, { subject: SUBJECT, holder: HOLDER, now, mutate: (c) => c });
  const p = join(fd, 'orchestrator', 'tasks', TASK, 'reconciliation.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...raw, task_id: 'SOMEONE-ELSE' }));

  assert.throws(() => readReconciliationRecord(fd, TASK), (err: unknown) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID');
});

test('a malformed journal is a typed schema error, not a silent reset', () => {
  const fd = taskDir();
  writeFileSync(join(fd, 'orchestrator', 'tasks', TASK, 'reconciliation.json'), '{"version":1}');
  assert.throws(() => readReconciliationRecord(fd, TASK), (err: unknown) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID');
});

// ─── Attestation provenance ──────────────────────────────────────────────────

test('the attestation is create-only: first mint creates, an identical replay is idempotent', () => {
  const fd = taskDir();
  const first = mint(fd);
  assert.equal(first.kind, 'created');
  const bytes = readFileSync(attPath(fd), 'utf8');

  // A replay at a later clock reading is still the SAME witness — the
  // crash-resume path must not report corruption.
  const replay = mint(fd);
  assert.equal(replay.kind, 'replayed');
  assert.equal(readFileSync(attPath(fd), 'utf8'), bytes, 'the original bytes are never rewritten');
});

test('a DIFFERENT attestation is corruption — never overwritten', () => {
  const fd = taskDir();
  mint(fd);
  const bytes = readFileSync(attPath(fd), 'utf8');

  const conflicting = mint(fd, {
    proof: { merged: true, base_ref: 'main', merge_commit_sha: 'd'.repeat(40), merged_head_sha: SHA },
  });
  assert.equal(conflicting.kind, 'corrupt');
  assert.equal(readFileSync(attPath(fd), 'utf8'), bytes);
});

// ── Provenance: minting REFUSES anything that is not exact proof ────────────

test('an unmerged proof can never mint an attestation', () => {
  const fd = taskDir();
  const res = mint(fd, { proof: { merged: false, state: 'open' } });
  assert.equal(res.kind, 'corrupt');
  assert.match(res.kind === 'corrupt' ? res.detail : '', /not merged/);
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent');
});

test('a merge at the WRONG head can never mint an attestation', () => {
  const fd = taskDir();
  const res = mint(fd, {
    proof: { merged: true, base_ref: 'main', merge_commit_sha: COMMIT, merged_head_sha: OTHER },
  });
  assert.equal(res.kind, 'corrupt');
  assert.match(res.kind === 'corrupt' ? res.detail : '', /merged head/);
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent');
});

test('a merge into the WRONG base can never mint an attestation', () => {
  const fd = taskDir();
  const res = mint(fd, {
    proof: { merged: true, base_ref: 'release', merge_commit_sha: COMMIT, merged_head_sha: SHA },
  });
  assert.equal(res.kind, 'corrupt');
  assert.match(res.kind === 'corrupt' ? res.detail : '', /recorded base/);
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent');
});

test('a record belonging to ANOTHER task can never mint an attestation', () => {
  const fd = taskDir();
  const res = mint(fd, { record: { ...RECORD, task_id: 'SOMEONE-ELSE' } });
  assert.equal(res.kind, 'corrupt');
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent');
});

test('a record with no PR binding can never mint an attestation', () => {
  const fd = taskDir();
  const res = mint(fd, { record: { ...RECORD, pr: null } });
  assert.equal(res.kind, 'corrupt');
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent');
});

test('the minted payload is derived from the proof + record, not from any caller input', () => {
  const fd = taskDir();
  assert.equal(mint(fd).kind, 'created');
  const read = readMergeAttestation(fd, TASK);
  assert.equal(read.kind, 'valid');
  if (read.kind === 'valid') {
    assert.equal(read.attestation.merge_commit_sha, COMMIT);
    assert.equal(read.attestation.merged_head_sha, SHA);
    assert.equal(read.attestation.reviewed_head_sha, RECORD.reviewed_head_sha);
    assert.equal(read.attestation.ship_record_revision, RECORD.revision);
    assert.equal(read.attestation.cycle, RECORD.cycle);
    assert.equal(read.attestation.base_branch, 'main');
  }
});

test('the fence runs on the create path and aborts the write when it refuses', () => {
  const fd = taskDir();
  assert.throws(() =>
    mint(fd, {
      fence: () => {
        throw new OrchestratorError('STALE_ATTEMPT', 'subject moved', {});
      },
    }),
  );
  assert.equal(readMergeAttestation(fd, TASK).kind, 'absent', 'a refused fence leaves NO attestation');
});

test('the fence also runs on the replay path — a stale resume cannot claim proof', () => {
  const fd = taskDir();
  mint(fd);
  let fenced = 0;
  const replay = mint(fd, { fence: () => { fenced += 1; } });
  assert.equal(replay.kind, 'replayed');
  assert.equal(fenced, 1);
});

test('reads reject a foreign task_id, a self-inconsistent head, and non-JSON', () => {
  for (const [label, content] of [
    ['foreign task', JSON.stringify(attestationOf({ task_id: 'OTHER-1' }))],
    ['head mismatch', JSON.stringify(attestationOf({ merged_head_sha: OTHER }))],
    ['not json', 'nope'],
    ['schema', JSON.stringify({ version: 1, task_id: TASK })],
  ] as const) {
    const fd = taskDir();
    writeFileSync(attPath(fd), content);
    const read = readMergeAttestation(fd, TASK);
    assert.equal(read.kind, 'invalid', `${label} must read as invalid`);
  }
});

test('a symlinked or directory attestation is invalid, never followed', () => {
  const fd = taskDir();
  const decoy = join(fd, 'decoy.json');
  writeFileSync(decoy, JSON.stringify(attestationOf()));
  symlinkSync(decoy, attPath(fd));
  assert.equal(readMergeAttestation(fd, TASK).kind, 'invalid');

  const fd2 = taskDir();
  mkdirSync(attPath(fd2));
  assert.equal(readMergeAttestation(fd2, TASK).kind, 'invalid');
});

test('an oversized attestation file is refused rather than parsed', () => {
  const fd = taskDir();
  writeFileSync(attPath(fd), `{"pad":"${'x'.repeat(300 * 1024)}"}`);
  assert.equal(readMergeAttestation(fd, TASK).kind, 'invalid');
});

test('a valid attestation round-trips through the reader with its binding intact', () => {
  const fd = taskDir();
  mint(fd);
  const read = readMergeAttestation(fd, TASK);
  assert.equal(read.kind, 'valid');
  if (read.kind === 'valid') {
    assert.equal(read.attestation.task_id, TASK);
    assert.equal(read.attestation.merged_head_sha, SHA);
    assert.equal(read.attestation.reviewed_head_sha, SHA);
    assert.equal(read.attestation.ship_record_revision, 2);
  }
});
