import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquire,
  heartbeat,
  steal,
  release,
  assertLeaseOwnership,
  __leasesFsForTesting,
} from '../../src/orchestrator/leases.ts';
import { OrchestratorError } from '../../src/core/errors.ts';
import { leaseFilePath, claimHistoryFilePath } from '../../src/orchestrator/questions/paths.ts';
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

test('leases: heartbeat updates expires_at and last_heartbeat_at', async () => {
  const fd = forgeDir('hb-happy');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HB1', runId: 'run-001' });
  const originalExpires = lease.expires_at;
  // Small delay to ensure the timestamps differ
  await new Promise((r) => setTimeout(r, 5));
  const updated = heartbeat({
    forgeDir: fd,
    taskId: 'TASK-HB1',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  assert.notEqual(updated.expires_at, originalExpires, 'expires_at should be updated');
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

test('leases: steal with no existing lease succeeds as a fresh acquire', () => {
  const fd = forgeDir('steal-no-lease');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-SNL'), { recursive: true });
  const lease = steal({
    forgeDir: fd,
    taskId: 'TASK-SNL',
    runId: 'run-001',
    now: Date.now(),
  });
  assert.equal(lease.generation, 0);
  assert.equal(lease.owner_run_id, 'run-001');
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

test('leases: release removes lease.json', () => {
  const fd = forgeDir('rel-happy');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-REL1', runId: 'run-001' });
  const path = leaseFilePath(fd, 'TASK-REL1');
  assert.equal(existsSync(path), true);
  release({
    forgeDir: fd,
    taskId: 'TASK-REL1',
    caller: { run_id: 'run-001', claim_id: lease.claim_id, generation: lease.generation },
  });
  assert.equal(existsSync(path), false, 'lease.json should be removed after release');
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

test('leases: steal throws LEASE_NOT_EXPIRED if heartbeat refreshed the lease after eligibility check (verify-before-write)', () => {
  const fd = forgeDir('steal-vbw-race');

  // Acquire an expiring lease (holder A, gen=0).
  const original = acquire({
    forgeDir: fd,
    taskId: 'TASK-VBW',
    runId: 'run-holder',
    leaseTtlMs: 1, // expires immediately
  });

  // Advance clock past expiry + grace so steal's eligibility check would pass.
  const futureNow = Date.now() + 10_000_000;

  // Simulate a concurrent heartbeat that refreshes the lease AFTER steal has
  // judged it stealable but BEFORE steal writes. We inject a custom readFileSync
  // into the seam: the first call (steal's pre-write verify-read) returns a
  // refreshed lease (new expires_at), causing the verify-before-write to abort.
  //
  // Mechanism: steal calls readLeaseFile once during eligibility (using the real
  // readFileSync), then again immediately before overwrite (the verify-read).
  // We wrap readFileSync so that the second call to the lease path returns a
  // lease with a different expires_at — as if heartbeat ran in between.
  const leasePath = leaseFilePath(fd, 'TASK-VBW');
  const refreshedLease = {
    ...original,
    expires_at: new Date(futureNow + 30_000).toISOString(),
    last_heartbeat_at: new Date(futureNow).toISOString(),
  };

  let readCallCount = 0;
  const realReadFileSync = __leasesFsForTesting.readFileSync;
  __leasesFsForTesting.readFileSync = (path: unknown, ...args: unknown[]) => {
    if (path === leasePath) {
      readCallCount++;
      // First read: eligibility check — return original expired lease.
      // Second read: verify-before-write — return refreshed lease (race injected).
      if (readCallCount >= 2) {
        return JSON.stringify(refreshedLease);
      }
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
        err instanceof OrchestratorError &&
        err.code === 'LEASE_NOT_EXPIRED' &&
        (err.details as Record<string, unknown>)?.reason === 'concurrent_heartbeat_renewed_lease',
    );
  } finally {
    __leasesFsForTesting.readFileSync = realReadFileSync;
  }
});

// ---- Fix 2: history corruption throw ----

test('leases: acquire throws CLAIM_HISTORY_CORRUPT when history file is non-empty but fully malformed', () => {
  const fd = forgeDir('history-corrupt');

  // Acquire and release to create the directory structure.
  const first = acquire({ forgeDir: fd, taskId: 'TASK-CORRUPT', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-CORRUPT',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });

  // Overwrite claim-history.jsonl with 3 lines of non-JSON to corrupt it.
  const histPath = claimHistoryFilePath(fd, 'TASK-CORRUPT');
  writeFileSync(histPath, 'not-json\nalso-not-json\nstill-not-json\n', 'utf8');

  // acquire should throw CLAIM_HISTORY_CORRUPT, not silently reset generation to 0.
  assert.throws(
    () => acquire({ forgeDir: fd, taskId: 'TASK-CORRUPT', runId: 'run-002' }),
    (err: unknown) =>
      err instanceof OrchestratorError && err.code === 'CLAIM_HISTORY_CORRUPT',
  );
});

test('leases: acquire with empty claim-history.jsonl still succeeds (generation 0)', () => {
  const fd = forgeDir('history-empty');

  // Acquire and release to create directory + history file.
  const first = acquire({ forgeDir: fd, taskId: 'TASK-HEMPTY', runId: 'run-001' });
  release({
    forgeDir: fd,
    taskId: 'TASK-HEMPTY',
    caller: { run_id: 'run-001', claim_id: first.claim_id, generation: first.generation },
  });

  // Truncate history to 0 bytes (legitimate edge case).
  const histPath = claimHistoryFilePath(fd, 'TASK-HEMPTY');
  writeFileSync(histPath, '', 'utf8');

  // Should not throw — empty file is treated as "no history".
  const second = acquire({ forgeDir: fd, taskId: 'TASK-HEMPTY', runId: 'run-002' });
  assert.equal(second.generation, 0, 'empty history file treated as no history — generation resets to 0');
});

// ---- Fix 3: run_id included in heartbeat verify-after-write ----

test('leases: heartbeat verify-after-write detects mismatched run_id and throws LEASE_STOLEN (Fix 3)', () => {
  const fd = forgeDir('hb-verify-run-id');
  const lease = acquire({ forgeDir: fd, taskId: 'TASK-HBVR', runId: 'run-real' });

  // Inject a fake re-read result that has the correct claim_id + generation
  // but a different owner_run_id. This simulates the (defense-in-depth) case
  // where the file on disk shows a different run_id than what we wrote.
  const leasePath = leaseFilePath(fd, 'TASK-HBVR');
  const realReadFileSync = __leasesFsForTesting.readFileSync;
  let writeHappened = false;

  __leasesFsForTesting.readFileSync = (path: unknown, ...args: unknown[]) => {
    if (path === leasePath && writeHappened) {
      // Return a lease with the correct claim_id + generation but a different run_id.
      const spoofed = {
        ...lease,
        owner_run_id: 'run-impostor',
      };
      return JSON.stringify(spoofed);
    }
    return (realReadFileSync as Function)(path, ...args);
  };

  // Intercept overwriteAtomicLink completion by wrapping unlinkSync: after the
  // overwrite sequence runs we flip writeHappened so the verify-read returns the
  // spoofed lease.
  const realUnlinkSync = __leasesFsForTesting.unlinkSync;
  let unlinkCount = 0;
  __leasesFsForTesting.unlinkSync = (path: unknown) => {
    (realUnlinkSync as Function)(path);
    // The overwrite path calls unlinkSync twice (unlink target + unlink tmp).
    // After the first unlink (target removed), the link hasn't happened yet.
    // After the second unlink (tmp cleanup), the write is done.
    unlinkCount++;
    if (unlinkCount >= 2) {
      writeHappened = true;
    }
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
    __leasesFsForTesting.unlinkSync = realUnlinkSync;
  }
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
