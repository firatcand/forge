import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  acquire,
  heartbeat,
  steal,
  release,
  assertLeaseOwnership,
  adminReleaseLeaseByIdentity,
  readLeaseRecord,
  __leasesFsForTesting,
} from '../../src/orchestrator/leases.ts';
import { OrchestratorError } from '../../src/core/errors.ts';
import {
  leaseFilePath,
  claimHistoryFilePath,
  stateFilePath,
} from '../../src/orchestrator/questions/paths.ts';
import { LeaseSchema, STEAL_GRACE_MS_DEFAULT } from '../../src/schemas/lease.ts';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-leases-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function forgeDir(name: string): string {
  const d = join(tmpDir, name, '.forge');
  mkdirSync(d, { recursive: true });
  return d;
}

// ---- acquire: happy path ----

test('leases: acquire returns a valid Lease', () => {
  const fd = forgeDir('acq-happy');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-A1', runId: 'run-001' });
  assert.equal(lease.version, 1);
  assert.equal(lease.task_id, 'TASK-A1');
  assert.equal(lease.owner_run_id, 'run-001');
  assert.equal(lease.generation, 0);
  assert.equal(lease.attempt_id, null);
  const parsed = LeaseSchema.safeParse(lease);
  assert.equal(parsed.success, true);
});

test('leases: acquire creates lease.json at the correct path', () => {
  const fd = forgeDir('acq-path');
  acquire({ forgeDir: fd, taskId: 'TASK-A2', runId: 'run-001' });
  const path = leaseFilePath(fd, 'TASK-A2');
  assert.equal(existsSync(path), true, 'lease.json should exist');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.task_id, 'TASK-A2');
});

// ---- acquire: concurrent — exactly 1 succeeds ----
// Note: this test exercises correctness within a single event-loop turn, NOT
// true inter-process concurrency. Node.js is single-threaded; Promise.allSettled
// here schedules all microtasks in one turn and they run sequentially. The test
// proves that linkSync is the correct atomic gate (EEXIST on the loser), but
// does NOT simulate two real OS processes racing simultaneously.

test('leases: concurrent acquire × 10 — exactly 1 succeeds, 9 throw LEASE_EXISTS', async () => {
  const fd = forgeDir('acq-concurrent');
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        acquire({ forgeDir: fd, taskId: 'TASK-CONC', runId: `run-${i}` }),
      ),
    ),
  );
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const leaseExists = results.filter(
    (r) =>
      r.status === 'rejected' &&
      r.reason instanceof OrchestratorError &&
      r.reason.code === 'LEASE_EXISTS',
  ).length;
  assert.equal(succeeded, 1, 'exactly 1 acquire should succeed');
  assert.equal(leaseExists, 9, '9 should get LEASE_EXISTS');
});

// ---- heartbeat: happy path ----

test('leases: heartbeat updates expires_at and last_heartbeat_at', () => {
  const fd = forgeDir('hb-happy');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HB1', runId: 'run-001' });
  const originalExpires = lease.expires_at;
  // Inject an explicitly-later clock so timestamps differ deterministically
  // (no flaky setTimeout / same-millisecond collision).
  const updated = heartbeat({
    forgeDir: fd,
    taskId: 'TASK-HB1',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
    now: Date.parse(lease.acquired_at) + 1000,
  });
  assert.notEqual(updated.expires_at, originalExpires, 'expires_at should be updated');
  assert.equal(
    updated.last_heartbeat_at,
    new Date(Date.parse(lease.acquired_at) + 1000).toISOString(),
    'last_heartbeat_at should reflect the heartbeat clock',
  );
  assert.equal(updated.generation, lease.generation, 'generation should not change');
  assert.equal(updated.claim_id, lease.claim_id, 'claim_id should not change');
});

// ---- heartbeat: stale claim_id → LEASE_STOLEN ----

test('leases: heartbeat with stale claim_id throws LEASE_STOLEN', () => {
  const fd = forgeDir('hb-stale-claim');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HB2', runId: 'run-001' });
  assert.throws(
    () =>
      heartbeat({
        forgeDir: fd,
        taskId: 'TASK-HB2',
        caller: { run_id: 'run-001', claim_id: 'wrong-claim', generation: lease.generation },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- heartbeat: stale generation → LEASE_STOLEN ----

test('leases: heartbeat with stale generation throws LEASE_STOLEN', () => {
  const fd = forgeDir('hb-stale-gen');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HB3', runId: 'run-001' });
  assert.throws(
    () =>
      heartbeat({
        forgeDir: fd,
        taskId: 'TASK-HB3',
        caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation + 1 },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- heartbeat: absent lease → LEASE_NOT_FOUND ----

test('leases: heartbeat with no existing lease throws LEASE_NOT_FOUND', () => {
  const fd = forgeDir('hb-absent');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-HB4'), { recursive: true });
  assert.throws(
    () =>
      heartbeat({
        forgeDir: fd,
        taskId: 'TASK-HB4',
        caller: { run_id: 'run-001', claim_id: 'c', generation: 0 },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_NOT_FOUND',
  );
});

// ---- steal: not yet expired → LEASE_NOT_EXPIRED ----

test('leases: steal before grace period throws LEASE_NOT_EXPIRED', () => {
  const fd = forgeDir('steal-not-expired');
  acquire({ forgeDir: fd, taskId: 'TASK-SN1', runId: 'run-001' });
  assert.throws(
    () =>
      steal({
        forgeDir: fd,
        taskId: 'TASK-SN1',
        runId: 'run-002',
        now: Date.now(), // within TTL
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_NOT_EXPIRED',
  );
});

// ---- steal: after grace period → succeeds, generation incremented ----

test('leases: steal after grace period succeeds and increments generation', () => {
  const fd = forgeDir('steal-eligible');
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-SE1',
    runId: 'run-001',
    leaseTtlMs: 1, // expire immediately
  });
  // Use now far past expiry + grace
  const futureNow = Date.now() + 10_000_000;
  const stolen = steal({
    forgeDir: fd,
    taskId: 'TASK-SE1',
    runId: 'run-002',
    now: futureNow,
    stealGraceMs: 0,
  });
  assert.equal(stolen.generation, original.generation + 1, 'generation should be incremented');
  assert.equal(stolen.owner_run_id, 'run-002');
  assert.notEqual(stolen.claim_id, original.claim_id);
});

// ---- steal then original holder heartbeat → LEASE_STOLEN ----

test('leases: original holder heartbeat after steal throws LEASE_STOLEN', () => {
  const fd = forgeDir('steal-then-hb');
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-STH',
    runId: 'run-001',
    leaseTtlMs: 1,
  });
  steal({
    forgeDir: fd,
    taskId: 'TASK-STH',
    runId: 'run-002',
    now: Date.now() + 10_000_000,
    stealGraceMs: 0,
  });
  assert.throws(
    () =>
      heartbeat({
        forgeDir: fd,
        taskId: 'TASK-STH',
        caller: { run_id: 'run-001', claim_id: original.claim_id, generation: original.generation },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- steal when no lease exists — falls through to acquire ----

test('leases: steal with no active lease throws LEASE_NOT_FOUND (fall-through removed, FORGE-231)', () => {
  const fd = forgeDir('steal-no-lease');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-SNL'), { recursive: true });
  assert.throws(
    () =>
      steal({
        forgeDir: fd,
        taskId: 'TASK-SNL',
        runId: 'run-001',
        now: Date.now(),
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_NOT_FOUND',
  );
});

// ---- assertLeaseOwnership ----

test('leases: assertLeaseOwnership passes for valid caller', () => {
  const fd = forgeDir('alo-valid');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-ALO1', runId: 'run-001' });
  assert.doesNotThrow(() =>
    assertLeaseOwnership(fd, 'TASK-ALO1', {
      run_id: 'run-001',
      claim_id: lease.claim_id,
      generation: lease.generation,
    }),
  );
});

test('leases: assertLeaseOwnership throws LEASE_STOLEN for wrong generation', () => {
  const fd = forgeDir('alo-gen');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-ALO2', runId: 'run-001' });
  assert.throws(
    () =>
      assertLeaseOwnership(fd, 'TASK-ALO2', {
        run_id: 'run-001',
        claim_id: lease.claim_id,
        generation: lease.generation + 99,
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

test('leases: assertLeaseOwnership throws LEASE_NOT_FOUND when no lease exists', () => {
  const fd = forgeDir('alo-absent');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-ALO3'), { recursive: true });
  assert.throws(
    () =>
      assertLeaseOwnership(fd, 'TASK-ALO3', {
        run_id: 'run-001',
        claim_id: 'c',
        generation: 0,
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_NOT_FOUND',
  );
});

// ---- release ----

test('leases: release writes a tombstone (file survives; generation continues on re-acquire)', () => {
  const fd = forgeDir('rel-happy');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-REL1', runId: 'run-001' });
  const path = leaseFilePath(fd, 'TASK-REL1');
  assert.equal(existsSync(path), true);
  release({
    forgeDir: fd,
    taskId: 'TASK-REL1',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  // FORGE-231: lease.json is never deleted after first acquisition — release
  // writes a tombstone carrying the version/generation history.
  assert.equal(existsSync(path), true, 'lease.json must survive release as a tombstone');
  const record = readLeaseRecord('TASK-REL1', path);
  assert.equal(record?.kind, 'released');
  if (record?.kind !== 'released') throw new Error('unreachable');
  assert.equal(record.tombstone.last_generation, lease.generation);
  assert.equal(record.tombstone.lease_version, lease.lease_version + 1);
  // Re-acquire continues the generation sequence from the tombstone.
  const second = acquire({ forgeDir: fd, taskId: 'TASK-REL1', runId: 'run-002' });
  assert.equal(second.generation, lease.generation + 1);
  assert.equal(second.lease_version, record.tombstone.lease_version + 1);
});

test('leases: release appends to claim-history.jsonl', () => {
  const fd = forgeDir('rel-history');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-REL2', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-REL2',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  const histPath = claimHistoryFilePath(fd, 'TASK-REL2');
  assert.equal(existsSync(histPath), true);
  const lines = readFileSync(histPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 2, 'at least 2 history entries (acquire + release)');
  const lastEntry = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEntry.event, 'released');
});

test('leases: release throws LEASE_STOLEN for wrong caller', () => {
  const fd = forgeDir('rel-stolen');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-REL3', runId: 'run-001' });
  assert.throws(
    () =>
      release({
        forgeDir: fd,
        taskId: 'TASK-REL3',
        caller: { run_id: 'run-002', claim_id: 'wrong-claim', generation: lease.generation },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- H1: assertLeaseOwnership rejects correct claim_id+generation but wrong run_id ----

test('leases: heartbeat with correct claim_id+generation but wrong run_id throws LEASE_STOLEN (H1)', () => {
  const fd = forgeDir('h1-run-id');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-H1', runId: 'run-real' });
  assert.throws(
    () =>
      heartbeat({
        forgeDir: fd,
        taskId: 'TASK-H1',
        caller: { run_id: 'run-impersonator', claim_id: lease.claim_id, generation: lease.generation },
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
});

// ---- B3: generation does not reset to 0 on release-then-reacquire ----

test('leases: re-acquire after release uses generation from history, not 0 (B3)', () => {
  const fd = forgeDir('b3-reacquire');
  const first = acquire({ forgeDir: fd, taskId: 'TASK-B3', runId: 'run-001' });
  assert.equal(first.generation, 0, 'first acquire should be generation 0');

  release({
    forgeDir: fd,
    taskId: 'TASK-B3',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });

  const second = acquire({ forgeDir: fd, taskId: 'TASK-B3', runId: 'run-002' });
  assert.equal(
    second.generation,
    first.generation + 1,
    'second acquire should use generation 1, not 0 (history read)',
  );
});

// ---- FORGE-85: generation continuity across claim-history rotation ----

test('leases: rotate-then-acquire continues the generation (reads .1 fallback)', () => {
  const fd = forgeDir('rotate-continuity');
  const first = acquire({ forgeDir: fd, taskId: 'TASK-ROT', runId: 'run-001' });
  assert.equal(first.generation, 0);
  release({
    forgeDir: fd,
    taskId: 'TASK-ROT',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });

  // Simulate a rotation: the entire history (acquire+release entries) moves to
  // <file>.1 and the current file is gone. This is exactly the post-rotation
  // state where the last generation lives in .1.
  const histPath = claimHistoryFilePath(fd, 'TASK-ROT');
  renameSync(histPath, `${histPath}.1`);
  assert.equal(existsSync(histPath), false, 'current gone after rotation');

  // acquire must continue the generation from .1, NOT reset to 0.
  const second = acquire({ forgeDir: fd, taskId: 'TASK-ROT', runId: 'run-002' });
  assert.equal(
    second.generation,
    first.generation + 1,
    'generation continued from rotated .1, not reset',
  );
});

test('leases: empty current + populated .1 → generation read from .1 (no reset)', () => {
  const fd = forgeDir('rotate-empty-current');
  const first = acquire({ forgeDir: fd, taskId: 'TASK-ROT2', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-ROT2',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });
  const histPath = claimHistoryFilePath(fd, 'TASK-ROT2');
  // Rotation just happened: history in .1, current freshly truncated (0 bytes).
  renameSync(histPath, `${histPath}.1`);
  writeFileSync(histPath, '', 'utf8');

  const second = acquire({ forgeDir: fd, taskId: 'TASK-ROT2', runId: 'run-002' });
  assert.equal(second.generation, first.generation + 1, 'no RESET; .1 consulted');
});

test('leases: tombstone is authoritative for generation; claim history covers the LEGACY absent-file path (no RESET)', () => {
  const fd = forgeDir('rotate-race');
  const first = acquire({ forgeDir: fd, taskId: 'TASK-ROT3', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-ROT3',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });
  // With a tombstone present, re-acquire continues from last_generation —
  // claim history is not consulted (it cannot legitimately diverge: every
  // mutation goes through the lease-file CAS).
  const next = acquire({ forgeDir: fd, taskId: 'TASK-ROT3', runId: 'run-002' });
  assert.equal(next.generation, first.generation + 1);

  // LEGACY path (R8 CRIT-1): pre-FORGE-231 releases UNLINKED lease.json. An
  // absent file with claim history must continue from history — never reset.
  release({
    forgeDir: fd,
    taskId: 'TASK-ROT3',
    caller: { run_id: 'run-002', claim_id: next.claim_id, generation: next.generation },
  });
  unlinkSync(leaseFilePath(fd, 'TASK-ROT3')); // simulate the legacy unlink
  const histPath = claimHistoryFilePath(fd, 'TASK-ROT3');
  renameSync(histPath, `${histPath}.1`);
  writeFileSync(
    histPath,
    JSON.stringify({ event: 'acquired', generation: 5 }) + '\n',
    'utf8',
  );
  const legacy = acquire({ forgeDir: fd, taskId: 'TASK-ROT3', runId: 'run-003' });
  assert.ok(legacy.generation >= 1, 'never a RESET to 0');
  assert.equal(legacy.generation, 6, 'current history entry (gen 5) + 1 wins when present');
});

// ---- steal writes state.json = unclaimed (OQ-6) + updated_by from new owner ----

test('leases: steal writes state.json with state=unclaimed (OQ-6)', () => {
  const fd = forgeDir('steal-state');
  acquire({
    forgeDir: fd,
    taskId: 'TASK-SS1',
    runId: 'run-001',
    leaseTtlMs: 1,
  });
  steal({
    forgeDir: fd,
    taskId: 'TASK-SS1',
    runId: 'run-002',
    now: Date.now() + 10_000_000,
    stealGraceMs: 0,
  });
  const statePath = join(fd, 'orchestrator', 'tasks', 'TASK-SS1', 'state.json');
  assert.equal(existsSync(statePath), true, 'state.json should exist after steal');
  const stateRaw = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(stateRaw.state, 'unclaimed');
});

test('leases: steal writes state.json with updated_by from the new owner identity', () => {
  const fd = forgeDir('steal-updated-by');
  acquire({
    forgeDir: fd,
    taskId: 'TASK-SUB',
    runId: 'run-original',
    leaseTtlMs: 1,
  });
  const newLease = steal({
    forgeDir: fd,
    taskId: 'TASK-SUB',
    runId: 'run-thief',
    now: Date.now() + 10_000_000,
    stealGraceMs: 0,
  });
  const statePath = join(fd, 'orchestrator', 'tasks', 'TASK-SUB', 'state.json');
  const stateRaw = JSON.parse(readFileSync(statePath, 'utf8'));
  // updated_by must reflect the new owner (run-thief), not the original holder.
  assert.equal(stateRaw.updated_by.run_id, newLease.owner_run_id, 'updated_by.run_id should be the new owner');
  assert.equal(stateRaw.updated_by.claim_id, newLease.claim_id, 'updated_by.claim_id should be the new claim');
  assert.equal(stateRaw.updated_by.generation, newLease.generation, 'updated_by.generation should be the new generation');
});

// ---- Fix 1: steal verify-before-write — concurrent heartbeat race ----

test('leases: steal aborts (LEASE_CONTENDED, nothing published) when the lease mutated after eligibility check', () => {
  const fd = forgeDir('steal-vbw-race');

  // Acquire an expiring lease (holder A, gen=0).
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-VBW',
    runId: 'run-holder',
    leaseTtlMs: 1, // expires immediately
  });

  const futureNow = Date.now() + 10_000_000;
  const leasePath = leaseFilePath(fd, 'TASK-VBW');

  // Simulate a heartbeat renewal landing AFTER steal judges the lease
  // stealable: the seam read (steal's eligibility check) returns the STALE
  // expired lease, while the REAL file on disk has been renewed (version
  // bumped). Every lease write bumps lease_version, so the stale judgment is
  // caught by the CAS version pin — the steal aborts having published nothing.
  const renewed = {
    ...original,
    expires_at: new Date(futureNow + 30_000).toISOString(),
    last_heartbeat_at: new Date(futureNow).toISOString(),
    lease_version: original.lease_version + 1,
  };
  writeFileSync(leasePath, JSON.stringify(renewed), 'utf8');

  const staleRaw = JSON.stringify(original);
  const realReadFileSync = __leasesFsForTesting.readFileSync;
  __leasesFsForTesting.readFileSync = (path: unknown, ...args: unknown[]) => {
    if (path === leasePath) {
      return staleRaw; // steal's observation read sees the stale expired lease
    }
    return (realReadFileSync as Function)(path, ...args);
  };

  try {
    assert.throws(
      () =>
        steal({
          forgeDir: fd,
          taskId: 'TASK-VBW',
          runId: 'run-thief',
          now: futureNow,
          stealGraceMs: 0,
        }),
      (err: unknown) =>
        err instanceof OrchestratorError && err.code === 'LEASE_CONTENDED',
    );
  } finally {
    __leasesFsForTesting.readFileSync = realReadFileSync;
  }

  // Nothing was published: the renewed lease is intact and no CAS markers
  // remain (the reserved state marker was released on abort).
  const after = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(after.lease_version, renewed.lease_version);
  assert.equal(after.expires_at, renewed.expires_at);
  const taskDir = dirname(leasePath);
  const leftovers = readdirSync(taskDir).filter((f) => f.includes('.cas-'));
  assert.deepEqual(leftovers, [], 'steal abort must leave no CAS markers');
});

// ---- Fix 2: history corruption throw ----

test('leases: acquire throws CLAIM_HISTORY_CORRUPT on the legacy path (absent file, malformed history)', () => {
  const fd = forgeDir('history-corrupt');

  // Acquire and release, then UNLINK the tombstone to simulate a legacy
  // (pre-FORGE-231) release — the shape where claim history is authoritative.
  const first = acquire({ forgeDir: fd, taskId: 'TASK-CORRUPT', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-CORRUPT',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });
  unlinkSync(leaseFilePath(fd, 'TASK-CORRUPT'));

  const histPath = claimHistoryFilePath(fd, 'TASK-CORRUPT');
  writeFileSync(histPath, 'not-json\nalso-not-json\nstill-not-json\n', 'utf8');

  // acquire must throw CLAIM_HISTORY_CORRUPT, not silently reset generation to 0.
  assert.throws(
    () => acquire({ forgeDir: fd, taskId: 'TASK-CORRUPT', runId: 'run-002' }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'CLAIM_HISTORY_CORRUPT',
  );
});

test('leases: acquire with empty claim history — tombstone wins; legacy absent-file path starts at 0', () => {
  const fd = forgeDir('history-empty');

  const first = acquire({ forgeDir: fd, taskId: 'TASK-HEMPTY', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-HEMPTY',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });

  // Truncate history to 0 bytes. The tombstone (not history) carries the
  // generation now, so continuity survives even an emptied history file —
  // strictly better than the pre-FORGE-231 reset.
  const histPath = claimHistoryFilePath(fd, 'TASK-HEMPTY');
  writeFileSync(histPath, '', 'utf8');
  const second = acquire({ forgeDir: fd, taskId: 'TASK-HEMPTY', runId: 'run-002' });
  assert.equal(second.generation, first.generation + 1, 'tombstone preserves generation despite empty history');

  // LEGACY shape: absent lease file + empty history → genuine generation 0.
  release({
    forgeDir: fd,
    taskId: 'TASK-HEMPTY',
    caller: { run_id: 'run-002', claim_id: second.claim_id, generation: second.generation },
  });
  unlinkSync(leaseFilePath(fd, 'TASK-HEMPTY'));
  writeFileSync(histPath, '', 'utf8');
  try { unlinkSync(`${histPath}.1`); } catch { /* may not exist */ }
  const legacy = acquire({ forgeDir: fd, taskId: 'TASK-HEMPTY', runId: 'run-003' });
  assert.equal(legacy.generation, 0, 'empty history + absent file is a genuine first acquire');
});

// ---- Fix 3: run_id included in heartbeat verify-after-write ----

test('leases: heartbeat post-acquire read detects mismatched run_id and throws LEASE_STOLEN (FORGE-231)', () => {
  const fd = forgeDir('hb-verify-run-id');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HBVR', runId: 'run-real' });

  // The REAL file on disk carries an impostor run_id at the SAME lease_version;
  // the seam read (heartbeat's fast-fail precheck) still sees the caller's own
  // lease. The mandatory post-acquire re-read (real fs) parses the impostor —
  // the identity check inside the guarded mutation must reject it.
  const leasePath = leaseFilePath(fd, 'TASK-HBVR');
  writeFileSync(leasePath, JSON.stringify({ ...lease, owner_run_id: 'run-impostor' }), 'utf8');

  const ownRaw = JSON.stringify(lease);
  const realReadFileSync = __leasesFsForTesting.readFileSync;
  __leasesFsForTesting.readFileSync = (path: unknown, ...args: unknown[]) => {
    if (path === leasePath) return ownRaw;
    return (realReadFileSync as Function)(path, ...args);
  };

  try {
    assert.throws(
      () =>
        heartbeat({
          forgeDir: fd,
          taskId: 'TASK-HBVR',
          caller: { run_id: 'run-real', claim_id: lease.claim_id, generation: lease.generation },
        }),
      (err: unknown) =>
        err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
    );
  } finally {
    __leasesFsForTesting.readFileSync = realReadFileSync;
  }

  // The impostor lease was not modified and no markers were leaked.
  const after = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(after.owner_run_id, 'run-impostor');
  assert.equal(after.lease_version, lease.lease_version);
  const leftovers = readdirSync(dirname(leasePath)).filter((f) => f.includes('.cas-'));
  assert.deepEqual(leftovers, [], 'heartbeat abort must leave no CAS markers');
});

// ---- FORGE-231 §C4: steal reserve-then-publish protocol ----

test('leases: steal aborts entirely (no lease publish) when the state transition marker is held', () => {
  const fd = forgeDir('steal-state-reserved');
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-SRSV',
    runId: 'run-holder',
    leaseTtlMs: 1,
  });
  const futureNow = Date.now() + 10_000_000;

  // A paused writer holds the state transition marker (state.json absent →
  // the create-domain marker). The steal must conflict on its RESERVE step —
  // before any lease mutation — and publish nothing.
  const statePath = stateFilePath(fd, 'TASK-SRSV');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(`${statePath}.cas-create`, JSON.stringify({ pid: 1, token: 'held' }), 'utf8');

  assert.throws(
    () =>
      steal({
        forgeDir: fd,
        taskId: 'TASK-SRSV',
        runId: 'run-thief',
        now: futureNow,
        stealGraceMs: 0,
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_CONTENDED',
  );

  // The lease is untouched — same holder, same version, no successor.
  const after = readLeaseRecord('TASK-SRSV', leaseFilePath(fd, 'TASK-SRSV'));
  assert.equal(after?.kind, 'active');
  if (after?.kind !== 'active') throw new Error('unreachable');
  assert.equal(after.lease.claim_id, original.claim_id);
  assert.equal(after.lease.generation, original.generation);
  assert.equal(after.lease.lease_version, original.lease_version);
  // The held marker is still there (the steal must not remove it).
  assert.equal(existsSync(`${statePath}.cas-create`), true);
});

test('leases: legacy lease file without lease_version defaults to 1 and heartbeats to 2', () => {
  const fd = forgeDir('legacy-lease-version');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-LEGACY', runId: 'run-001' });
  const leasePath = leaseFilePath(fd, 'TASK-LEGACY');
  // Strip lease_version — the shape every pre-FORGE-231 lease file has.
  const legacy = JSON.parse(readFileSync(leasePath, 'utf8'));
  delete legacy.lease_version;
  writeFileSync(leasePath, JSON.stringify(legacy), 'utf8');

  const renewed = heartbeat({
    forgeDir: fd,
    taskId: 'TASK-LEGACY',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  assert.equal(renewed.lease_version, 2, 'legacy default 1 → first guarded mutation writes 2');
});

// ---- spec_revision stamping (FORGE-114 / P2.5-T18) ----

test('leases: acquire stamps the supplied spec_revision', () => {
  const fd = forgeDir('acq-spec-rev');
  const lease = acquire({
    forgeDir: fd,
    taskId: 'TASK-SR1',
    runId: 'run-001',
    specRevision: { revision: 'git:abc1234567890abcdef1234567890abcdef12345', source: 'git' },
  });
  assert.equal(lease.spec_revision, 'git:abc1234567890abcdef1234567890abcdef12345');
});

test('leases: acquire persisted lease.json round-trips with spec_revision', () => {
  const fd = forgeDir('acq-spec-rev-disk');
  acquire({
    forgeDir: fd,
    taskId: 'TASK-SR2',
    runId: 'run-001',
    specRevision: { revision: 'digest:0123456789abcdef', source: 'digest' },
  });
  const raw = readFileSync(leaseFilePath(fd, 'TASK-SR2'), 'utf8');
  const parsed = LeaseSchema.parse(JSON.parse(raw));
  assert.equal(parsed.spec_revision, 'digest:0123456789abcdef');
});

test('leases: acquire without specRevision falls back to computed value', () => {
  const fd = forgeDir('acq-spec-rev-default');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-SR3', runId: 'run-001' });
  // tmpDir is not a git repo and has no spec/ → expect digest:empty
  assert.equal(lease.spec_revision, 'digest:empty');
});

test('leases: heartbeat preserves spec_revision', () => {
  const fd = forgeDir('hb-spec-rev');
  const lease = acquire({
    forgeDir: fd,
    taskId: 'TASK-HBR',
    runId: 'run-001',
    specRevision: { revision: 'git:1111111111111111111111111111111111111111', source: 'git' },
  });
  const after = heartbeat({
    forgeDir: fd,
    taskId: 'TASK-HBR',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  assert.equal(after.spec_revision, 'git:1111111111111111111111111111111111111111');
});

test('leases: steal re-stamps spec_revision (new claim = new revision)', () => {
  const fd = forgeDir('steal-spec-rev');
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-STR',
    runId: 'run-old',
    leaseTtlMs: 1_000,
    specRevision: { revision: 'git:2222222222222222222222222222222222222222', source: 'git' },
  });
  // Force expiry + grace by advancing the clock via the `now` option.
  const future = Date.now() + 1_000 + STEAL_GRACE_MS_DEFAULT + 1_000;
  const stolen = steal({
    forgeDir: fd,
    taskId: 'TASK-STR',
    runId: 'run-new',
    leaseTtlMs: 1_000,
    now: future,
    specRevision: { revision: 'git:3333333333333333333333333333333333333333', source: 'git' },
  });
  assert.equal(original.spec_revision, 'git:2222222222222222222222222222222222222222');
  assert.equal(stolen.spec_revision, 'git:3333333333333333333333333333333333333333');
  assert.equal(stolen.generation, original.generation + 1);
});

// ---- adminReleaseLeaseByIdentity (gc-only, identity-gated) ----

function writeStateJson(
  fd: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = join(fd, 'orchestrator', 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  const base = {
    version: 1,
    task_id: taskId,
    state: 'shipped',
    state_version: 0,
    attempt_count: 1,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: {
      run_id: 'run-X',
      claim_id: 'claim-X',
      generation: 0,
    },
    ...overrides,
  };
  writeFileSync(stateFilePath(fd, taskId), JSON.stringify(base));
}

test('adminReleaseLeaseByIdentity: row-14 happy path — matching identity + terminal state → unlink + history event', () => {
  const fd = forgeDir('admin-release-r14');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-R14', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-R14', { state: 'shipped' });

  adminReleaseLeaseByIdentity({
    forgeDir: fd,
    taskId: 'TASK-R14',
    expectedClaimId: lease.claim_id,
    expectedGeneration: lease.generation,
    expectedOwnerRunId: lease.owner_run_id,
    expectedExpiresAt: lease.expires_at,
    expectedPath: leaseFilePath(fd, 'TASK-R14'),
    requireTerminalState: true,
    reason: 'gc:row-14:terminal-state',
  });

  assert.equal(existsSync(leaseFilePath(fd, 'TASK-R14')), false, 'lease should be unlinked');
  const history = readFileSync(claimHistoryFilePath(fd, 'TASK-R14'), 'utf8');
  const lines = history.trim().split('\n').filter(Boolean);
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEvent.event, 'admin_released');
  assert.equal(lastEvent.reason, 'gc:row-14:terminal-state');
  assert.equal(lastEvent.claim_id, lease.claim_id);
  assert.equal(lastEvent.generation, lease.generation);
});

test('adminReleaseLeaseByIdentity: row-13 happy path — matching identity at non-canonical path → unlinks that path, leaves canonical untouched', () => {
  const fd = forgeDir('admin-release-r13');
  const canonical = acquire({ forgeDir: fd, taskId: 'TASK-R13', runId: 'run-canonical' });
  // Simulate corruption: a duplicate lease file at a non-canonical path with older identity.
  const dupPath = leaseFilePath(fd, 'TASK-R13') + '.bak';
  const dupLease = {
    version: 1,
    claim_id: 'claim-OLD',
    task_id: 'TASK-R13',
    attempt_id: null,
    owner_run_id: 'run-OLD',
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() - 30_000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
    generation: 0,
    spec_revision: 'git:0000000000000000000000000000000000000000',
  };
  writeFileSync(dupPath, JSON.stringify(dupLease));

  adminReleaseLeaseByIdentity({
    forgeDir: fd,
    taskId: 'TASK-R13',
    expectedClaimId: 'claim-OLD',
    expectedGeneration: 0,
    expectedOwnerRunId: 'run-OLD',
    expectedExpiresAt: dupLease.expires_at,
    expectedPath: dupPath,
    requireTerminalState: false, // row 13 doesn't gate on terminal state
    reason: 'gc:row-13:duplicate',
  });

  assert.equal(existsSync(dupPath), false, 'duplicate lease should be unlinked');
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-R13')), true, 'canonical lease must remain untouched');
  // Canonical lease is unchanged
  const canonicalRaw = readFileSync(leaseFilePath(fd, 'TASK-R13'), 'utf8');
  assert.equal(JSON.parse(canonicalRaw).claim_id, canonical.claim_id);
});

test('adminReleaseLeaseByIdentity: LEASE_IDENTITY_MISMATCH on claim_id mismatch — lease file untouched', () => {
  const fd = forgeDir('admin-release-mismatch-claim');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-MM-C', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-MM-C', { state: 'shipped' });

  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-MM-C',
        expectedClaimId: 'claim-wrong',
        expectedGeneration: lease.generation,
        expectedOwnerRunId: lease.owner_run_id,
        expectedExpiresAt: lease.expires_at,
        expectedPath: leaseFilePath(fd, 'TASK-MM-C'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_IDENTITY_MISMATCH',
  );
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-MM-C')), true, 'lease must remain on identity mismatch');
});

test('adminReleaseLeaseByIdentity: LEASE_IDENTITY_MISMATCH on generation mismatch — lease file untouched', () => {
  const fd = forgeDir('admin-release-mismatch-gen');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-MM-G', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-MM-G', { state: 'shipped' });

  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-MM-G',
        expectedClaimId: lease.claim_id,
        expectedGeneration: lease.generation + 1,
        expectedOwnerRunId: lease.owner_run_id,
        expectedExpiresAt: lease.expires_at,
        expectedPath: leaseFilePath(fd, 'TASK-MM-G'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_IDENTITY_MISMATCH',
  );
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-MM-G')), true);
});

test('adminReleaseLeaseByIdentity: LEASE_IDENTITY_MISMATCH on owner_run_id mismatch — lease file untouched', () => {
  const fd = forgeDir('admin-release-mismatch-run');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-MM-R', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-MM-R', { state: 'shipped' });

  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-MM-R',
        expectedClaimId: lease.claim_id,
        expectedGeneration: lease.generation,
        expectedOwnerRunId: 'run-different',
        expectedExpiresAt: lease.expires_at,
        expectedPath: leaseFilePath(fd, 'TASK-MM-R'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_IDENTITY_MISMATCH',
  );
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-MM-R')), true);
});

test('adminReleaseLeaseByIdentity: LEASE_STATE_NOT_TERMINAL when row-14 sees running state — lease file untouched', () => {
  const fd = forgeDir('admin-release-not-terminal');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-NT', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-NT', { state: 'running' });

  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-NT',
        expectedClaimId: lease.claim_id,
        expectedGeneration: lease.generation,
        expectedOwnerRunId: lease.owner_run_id,
        expectedExpiresAt: lease.expires_at,
        expectedPath: leaseFilePath(fd, 'TASK-NT'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_STATE_NOT_TERMINAL',
  );
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-NT')), true);
});

test('adminReleaseLeaseByIdentity: LEASE_STATE_NOT_TERMINAL when state.json absent (cannot confirm)', () => {
  const fd = forgeDir('admin-release-no-state');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-NS', runId: 'run-orig' });
  // No state.json — cannot confirm terminal.

  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-NS',
        expectedClaimId: lease.claim_id,
        expectedGeneration: lease.generation,
        expectedOwnerRunId: lease.owner_run_id,
        expectedExpiresAt: lease.expires_at,
        expectedPath: leaseFilePath(fd, 'TASK-NS'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_STATE_NOT_TERMINAL',
  );
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-NS')), true);
});

test('adminReleaseLeaseByIdentity: idempotent on already-gone lease file — no throw, no spurious history event', () => {
  const fd = forgeDir('admin-release-idempotent');
  // No acquire — file does not exist.
  const fakePath = leaseFilePath(fd, 'TASK-GONE');

  // Returns silently — no throw.
  adminReleaseLeaseByIdentity({
    forgeDir: fd,
    taskId: 'TASK-GONE',
    expectedClaimId: 'claim-X',
    expectedGeneration: 0,
    expectedOwnerRunId: 'run-X',
    expectedExpiresAt: '2026-01-01T00:00:00.000Z',
    expectedPath: fakePath,
    requireTerminalState: false,
    reason: 'gc:row-13:duplicate',
  });

  // No history file should have been created.
  assert.equal(existsSync(claimHistoryFilePath(fd, 'TASK-GONE')), false);
});

test('adminReleaseLeaseByIdentity: expectedExpiresAt catches heartbeat-renewal between snapshot and unlink (Codex 3rd-pass BLOCK 1)', () => {
  const fd = forgeDir('admin-release-heartbeat-race');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HB', runId: 'run-orig' });
  writeStateJson(fd, 'TASK-HB', { state: 'shipped' });
  // Simulate a heartbeat firing between snapshot and admin-release:
  // heartbeat preserves (claim_id, generation, owner_run_id) but advances
  // expires_at. The new identity check MUST detect this and refuse to unlink.
  // Inject an explicitly-later clock so expires_at provably advances — without
  // it, acquire() and heartbeat() can land in the same millisecond on a fast
  // runner, leaving expires_at unchanged and flaking the precondition below.
  const refreshed = heartbeat({
    forgeDir: fd,
    taskId: 'TASK-HB',
    caller: {
      run_id: lease.owner_run_id,
      claim_id: lease.claim_id,
      generation: lease.generation,
    },
    now: Date.parse(lease.acquired_at) + 1000,
  });
  assert.equal(refreshed.claim_id, lease.claim_id);
  assert.equal(refreshed.generation, lease.generation);
  assert.equal(refreshed.owner_run_id, lease.owner_run_id);
  assert.notEqual(refreshed.expires_at, lease.expires_at, 'heartbeat must have changed expires_at');

  // Caller still has the SNAPSHOT-time expires_at (pre-heartbeat). The function
  // MUST refuse via LEASE_IDENTITY_MISMATCH because the on-disk expires_at no
  // longer matches.
  assert.throws(
    () =>
      adminReleaseLeaseByIdentity({
        forgeDir: fd,
        taskId: 'TASK-HB',
        expectedClaimId: lease.claim_id,
        expectedGeneration: lease.generation,
        expectedOwnerRunId: lease.owner_run_id,
        expectedExpiresAt: lease.expires_at, // pre-heartbeat snapshot value
        expectedPath: leaseFilePath(fd, 'TASK-HB'),
        requireTerminalState: true,
        reason: 'gc:row-14:terminal-state',
      }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'LEASE_IDENTITY_MISMATCH',
  );
  // Lease file remains — heartbeat was not collateral damage.
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-HB')), true, 'lease must remain after race detection');
});

test('adminReleaseLeaseByIdentity: row-13 with requireTerminalState=false skips state check entirely', () => {
  const fd = forgeDir('admin-release-r13-no-state-check');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-R13-NS', runId: 'run-orig' });
  // Intentionally write running state — but row 13 path must NOT check it.
  writeStateJson(fd, 'TASK-R13-NS', { state: 'running' });

  // Create a duplicate at a non-canonical path with a distinct identity
  const dupPath = leaseFilePath(fd, 'TASK-R13-NS') + '.dup';
  const dupLease = { ...lease, claim_id: 'claim-DUP', generation: 0, owner_run_id: 'run-DUP' };
  writeFileSync(dupPath, JSON.stringify(dupLease));

  // Should succeed even though state is 'running' — row 13 path bypasses the state guard.
  adminReleaseLeaseByIdentity({
    forgeDir: fd,
    taskId: 'TASK-R13-NS',
    expectedClaimId: 'claim-DUP',
    expectedGeneration: 0,
    expectedOwnerRunId: 'run-DUP',
    expectedExpiresAt: dupLease.expires_at,
    expectedPath: dupPath,
    requireTerminalState: false,
    reason: 'gc:row-13:duplicate',
  });
  assert.equal(existsSync(dupPath), false);
  assert.equal(existsSync(leaseFilePath(fd, 'TASK-R13-NS')), true, 'canonical untouched');
});
