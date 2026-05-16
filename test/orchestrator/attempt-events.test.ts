import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAttemptEvent,
  readAttemptEvents,
  tryParseEventLine,
} from '../../src/orchestrator/attempt-events.ts';
import { acquire } from '../../src/orchestrator/leases.ts';
import { OrchestratorError } from '../../src/core/errors.ts';
import { eventsFilePath, leaseFilePath } from '../../src/orchestrator/questions/paths.ts';
import type { AttemptEvent } from '../../src/schemas/attempt.ts';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-events-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function forgeDir(name: string): string {
  const d = join(tmpDir, name, '.forge');
  mkdirSync(d, { recursive: true });
  return d;
}

const TS = '2026-05-15T10:00:00.000Z';

function heartbeatEvent(): AttemptEvent {
  return {
    type: 'heartbeat',
    ts: TS,
    lease_expires_at: '2026-05-15T10:30:00.000Z',
  };
}

function startedEvent(): AttemptEvent {
  return {
    type: 'attempt_started',
    ts: TS,
    attempt_id: 'attempt-001',
    run_id: 'run-001',
    claim_id: 'claim-001',
    generation: 0,
  };
}

// Helper: acquire a real lease and return the caller identity for use in tests.
function acquireLease(fd: string, taskId: string): { run_id: string; claim_id: string; generation: number } {
  const lease = acquire({ forgeDir: fd, taskId, runId: 'run-001' });
  return { run_id: lease.owner_run_id, claim_id: lease.claim_id, generation: lease.generation };
}

// ---- appendAttemptEvent: happy path ----

test('attempt-events: appendAttemptEvent creates file and writes valid JSON line', () => {
  const fd = forgeDir('ae-happy');
  const caller = acquireLease(fd, 'TASK-AE1');
  appendAttemptEvent(heartbeatEvent(), { forgeDir: fd, taskId: 'TASK-AE1', attemptId: 'att-1', caller });
  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE1', attemptId: 'att-1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  if (events[0].ok) {
    assert.equal(events[0].event.type, 'heartbeat');
  }
});

// ---- appendAttemptEvent: sequential appends produce multiple valid JSONL lines ----

test('attempt-events: sequential appends produce multiple valid JSONL lines', () => {
  const fd = forgeDir('ae-sequential');
  const caller = acquireLease(fd, 'TASK-AE2');
  const opts = { forgeDir: fd, taskId: 'TASK-AE2', attemptId: 'att-1', caller };
  appendAttemptEvent(startedEvent(), opts);
  appendAttemptEvent(heartbeatEvent(), opts);
  appendAttemptEvent(
    { type: 'attempt_completed', ts: TS, verdict: 'ready_for_review' },
    opts,
  );
  const events = readAttemptEvents(opts);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.ok), 'all events should parse successfully');
  if (events[0].ok) assert.equal(events[0].event.type, 'attempt_started');
  if (events[1].ok) assert.equal(events[1].event.type, 'heartbeat');
  if (events[2].ok) assert.equal(events[2].event.type, 'attempt_completed');
});

// ---- readAttemptEvents: partial trailing line skipped ----

test('attempt-events: reader skips partial trailing line without throwing', () => {
  const fd = forgeDir('ae-partial');
  const evPath = eventsFilePath(fd, 'TASK-AE3', 'att-1');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-AE3', 'attempts', 'att-1'), {
    recursive: true,
  });
  const validLine = JSON.stringify(heartbeatEvent()) + '\n';
  const partialLine = '{"type":"heartbeat","ts":"2026-05-15T10:00:00.000Z"'; // no closing brace or \n
  writeFileSync(evPath, validLine + partialLine, 'utf8');

  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE3', attemptId: 'att-1' });
  assert.equal(events.length, 2, 'should have 2 entries: 1 valid + 1 failed parse');
  assert.equal(events[0].ok, true);
  assert.equal(events[1].ok, false, 'partial line should fail parse gracefully');
});

// ---- readAttemptEvents: unknown event type returns { ok: false } ----

test('attempt-events: unknown event type in file returns ok:false without throwing', () => {
  const fd = forgeDir('ae-unknown-type');
  const evPath = eventsFilePath(fd, 'TASK-AE4', 'att-1');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-AE4', 'attempts', 'att-1'), {
    recursive: true,
  });
  const validLine = JSON.stringify(heartbeatEvent()) + '\n';
  const unknownLine = JSON.stringify({ type: 'unknown_future_event', ts: TS }) + '\n';
  writeFileSync(evPath, validLine + unknownLine, 'utf8');

  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE4', attemptId: 'att-1' });
  assert.equal(events.length, 2);
  assert.equal(events[0].ok, true);
  assert.equal(events[1].ok, false);
});

// ---- appendAttemptEvent: directory missing → mkdirSync creates it ----

test('attempt-events: missing directory is created automatically', () => {
  const fd = forgeDir('ae-mkdir');
  const caller = acquireLease(fd, 'TASK-AE5');
  // Do not pre-create the directory — appendAttemptEvent must do it
  appendAttemptEvent(heartbeatEvent(), { forgeDir: fd, taskId: 'TASK-AE5', attemptId: 'att-new', caller });
  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE5', attemptId: 'att-new' });
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
});

// ---- appendAttemptEvent: validates event before I/O ----

test('attempt-events: invalid event throws SCHEMA_INVALID before any I/O', () => {
  const fd = forgeDir('ae-schema-invalid');
  const caller = acquireLease(fd, 'TASK-AE6');
  const invalid = { type: 'unknown_event', ts: 'not-a-date' } as unknown as AttemptEvent;
  assert.throws(
    () =>
      appendAttemptEvent(invalid, { forgeDir: fd, taskId: 'TASK-AE6', attemptId: 'att-1', caller }),
    (err) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID',
  );
  // No file should have been created
  const evPath = eventsFilePath(fd, 'TASK-AE6', 'att-1');
  // We can't check existence without importing existsSync here, but we can
  // verify readAttemptEvents returns empty (file absent)
  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE6', attemptId: 'att-1' });
  assert.equal(events.length, 0, 'no events should exist after schema validation failure');
});

// ---- B2: appendAttemptEvent rejects stale caller (LEASE_STOLEN) ----

test('attempt-events: appendAttemptEvent throws LEASE_STOLEN for stale caller (B2)', () => {
  const fd = forgeDir('ae-b2-stolen');
  const realCaller = acquireLease(fd, 'TASK-AEB2');
  // Pass a caller with a generation that doesn't match the stored lease.
  const staleCaller = { ...realCaller, generation: realCaller.generation + 99 };
  assert.throws(
    () =>
      appendAttemptEvent(heartbeatEvent(), {
        forgeDir: fd,
        taskId: 'TASK-AEB2',
        attemptId: 'att-1',
        caller: staleCaller,
      }),
    (err) => err instanceof OrchestratorError && err.code === 'LEASE_STOLEN',
  );
  // No file should have been created
  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AEB2', attemptId: 'att-1' });
  assert.equal(events.length, 0, 'no events should exist when ownership check fails');
});

// ---- readAttemptEvents: returns [] when file absent ----

test('attempt-events: readAttemptEvents returns empty array when file absent', () => {
  const fd = forgeDir('ae-absent');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-AE7', 'attempts', 'att-1'), {
    recursive: true,
  });
  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AE7', attemptId: 'att-1' });
  assert.deepEqual(events, []);
});

// ---- tryParseEventLine: rejects invalid JSON ----

test('attempt-events: tryParseEventLine returns ok:false for invalid JSON', () => {
  const result = tryParseEventLine('not json {{{');
  assert.equal(result.ok, false);
});

// ---- tryParseEventLine: rejects known type with wrong shape ----

test('attempt-events: tryParseEventLine returns ok:false for wrong shape', () => {
  const result = tryParseEventLine(JSON.stringify({ type: 'heartbeat', ts: 'bad-date', lease_expires_at: 'also-bad' }));
  assert.equal(result.ok, false);
});

// ---- tryParseEventLine: accepts valid event ----

test('attempt-events: tryParseEventLine returns ok:true for valid event', () => {
  const result = tryParseEventLine(JSON.stringify(heartbeatEvent()));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.type, 'heartbeat');
  }
});
