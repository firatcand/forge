import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAttemptEvent,
  readAttemptEvents,
  tryParseEventLine,
  __eventsFsForTesting,
} from '../../src/orchestrator/attempt-events.ts';
import { acquire } from '../../src/orchestrator/leases.ts';
import { OrchestratorError } from '../../src/core/errors.ts';
import { eventsFilePath } from '../../src/orchestrator/questions/paths.ts';
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

// ---- FORGE-85: soft rotation (events.jsonl) ----

test('attempt-events: rotation triggers at threshold; reader merges .1 + current', () => {
  const fd = forgeDir('ae-rotate');
  const caller = acquireLease(fd, 'TASK-AER');
  // Tiny threshold so the first append's accumulated size triggers rotation
  // on the SECOND append.
  const opts = {
    forgeDir: fd,
    taskId: 'TASK-AER',
    attemptId: 'att-1',
    caller,
    logRotateMaxBytes: 1,
  };
  appendAttemptEvent(startedEvent(), opts); // file now > 1 byte
  const evPath = eventsFilePath(fd, 'TASK-AER', 'att-1');
  assert.equal(existsSync(`${evPath}.1`), false, 'no rotation before threshold check');
  appendAttemptEvent(heartbeatEvent(), opts); // pre-append size >= 1 → rotate
  assert.equal(existsSync(`${evPath}.1`), true, 'rotated: .1 created');

  // Reader merges the rotated (older) + current (newer), in chronological order.
  const events = readAttemptEvents(opts);
  assert.equal(events.length, 2, 'both generations merged');
  assert.ok(events[0].ok && events[0].event.type === 'attempt_started');
  assert.ok(events[1].ok && events[1].event.type === 'heartbeat');
});

test('attempt-events: single generation — second rotation overwrites .1', () => {
  const fd = forgeDir('ae-rotate-single');
  const caller = acquireLease(fd, 'TASK-AES');
  const opts = {
    forgeDir: fd,
    taskId: 'TASK-AES',
    attemptId: 'att-1',
    caller,
    logRotateMaxBytes: 1,
  };
  appendAttemptEvent(startedEvent(), opts);
  appendAttemptEvent(heartbeatEvent(), opts); // rotation #1
  appendAttemptEvent(
    { type: 'attempt_completed', ts: TS, verdict: 'ready_for_review' },
    opts,
  ); // rotation #2 — .1 overwritten
  const evPath = eventsFilePath(fd, 'TASK-AES', 'att-1');
  assert.equal(existsSync(`${evPath}.1`), true);
  // Merge yields exactly the last two events (the first generation is gone).
  const events = readAttemptEvents(opts);
  assert.equal(events.length, 2, 'single generation: oldest dropped');
});

test('attempt-events: large default threshold does not rotate normal traffic', () => {
  const fd = forgeDir('ae-no-rotate');
  const caller = acquireLease(fd, 'TASK-AEN');
  const opts = { forgeDir: fd, taskId: 'TASK-AEN', attemptId: 'att-1', caller };
  appendAttemptEvent(startedEvent(), opts);
  appendAttemptEvent(heartbeatEvent(), opts);
  const evPath = eventsFilePath(fd, 'TASK-AEN', 'att-1');
  assert.equal(existsSync(`${evPath}.1`), false, 'no rotation under 10 MiB default');
  assert.ok(statSync(evPath).size > 0);
});

// ---- FORGE-226: events.jsonl symlink is NEVER followed ----

test('attempt-events: readAttemptEvents returns [] when events.jsonl is a SYMLINK (does not follow)', () => {
  const fd = forgeDir('ae-symlink');
  const evPath = eventsFilePath(fd, 'TASK-AESL', 'att-1');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-AESL', 'attempts', 'att-1'), {
    recursive: true,
  });
  // A real, valid event log placed OUTSIDE the attempt tree; events.jsonl is a
  // symlink to it. A naive reader would follow the link and leak its contents.
  const decoy = join(fd, 'decoy-events.jsonl');
  writeFileSync(decoy, JSON.stringify(heartbeatEvent()) + '\n', 'utf8');
  symlinkSync(decoy, evPath);

  const events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AESL', attemptId: 'att-1' });
  assert.deepEqual(events, [], 'a symlinked events.jsonl is treated as absent');
});

// ---- FORGE-226: an oversized events file is read-bounded ----

test('attempt-events: an events file larger than the cap is bounded (only the capped prefix parses)', () => {
  const fd = forgeDir('ae-oversize');
  const evPath = eventsFilePath(fd, 'TASK-AEOV', 'att-1');
  mkdirSync(join(fd, 'orchestrator', 'tasks', 'TASK-AEOV', 'attempts', 'att-1'), {
    recursive: true,
  });
  // Use the real cap via a small monkeypatch would be brittle; instead build a
  // file whose VALID prefix is followed by enough junk to exceed the 32 MiB cap.
  // The bounded read truncates mid-junk; the junk tail parses as ok:false (a
  // partial/garbage line), and the real heartbeat at the head parses ok:true.
  const head = JSON.stringify(heartbeatEvent()) + '\n';
  // 33 MiB of non-newline filler (> MAX_EVENTS_FILE_BYTES = 32 MiB). A single
  // huge line — the reader must not load it whole, and must not crash.
  const filler = 'x'.repeat(33 * 1024 * 1024);
  writeFileSync(evPath, head + filler, 'utf8');

  let events!: ReturnType<typeof readAttemptEvents>;
  assert.doesNotThrow(() => {
    events = readAttemptEvents({ forgeDir: fd, taskId: 'TASK-AEOV', attemptId: 'att-1' });
  });
  // The valid head event still parsed.
  assert.ok(events.some((e) => e.ok), 'the valid head event must survive the bounded read');
  // The read was bounded: we never materialized the full (32 MiB + head) of text.
  // Sum of raw line lengths across failed entries must be < the on-disk filler size.
  const failedRawBytes = events
    .filter((e) => !e.ok)
    .reduce((n, e) => n + (e as { raw: string }).raw.length, 0);
  assert.ok(
    failedRawBytes < filler.length,
    `bounded read: junk seen (${failedRawBytes}) must be under the on-disk filler (${filler.length})`,
  );
});

// FORGE-226 (security): the leaf O_NOFOLLOW protects only events.jsonl itself.
// A symlinked PARENT dir (attempts/<id> → external) must NOT be followed —
// readAttemptEvents' realpath parent-containment refuses to read outside .forge.
test('attempt-events: readAttemptEvents refuses a symlinked parent dir escaping .forge', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-events-sym-'));
  try {
    const forgeDir = join(root, '.forge');
    const taskDir = join(forgeDir, 'orchestrator', 'tasks', 'TASK-SYM');
    mkdirSync(taskDir, { recursive: true });
    // External attempt tree with a real, valid events.jsonl.
    const ext = join(root, 'outside');
    mkdirSync(join(ext, 'att-1'), { recursive: true });
    writeFileSync(
      join(ext, 'att-1', 'events.jsonl'),
      JSON.stringify({ type: 'files_modified', ts: '2026-06-17T00:00:00.000Z', files: ['src/leak.ts'] }) + '\n',
    );
    // attempts → external dir; the leaf events.jsonl is itself a regular file.
    symlinkSync(ext, join(taskDir, 'attempts'));

    const events = readAttemptEvents({ forgeDir, taskId: 'TASK-SYM', attemptId: 'att-1' });
    assert.deepEqual(events, [], 'external events must not be read through a symlinked parent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FORGE-226 (security, TOCTOU): even if a parent dir is swapped to an external
// symlink AFTER the pre-open containment check, the POST-open re-check (mirror
// symbols.ts) must refuse to return the external events. Simulated via the fs
// seam: realpathSync resolves the LEAF (post-open) outside .forge while forgeDir
// + parent (pre-open) resolve normally — exactly the parent-swap race.
test('attempt-events: readAttemptEvents post-open re-check blocks a parent-swap TOCTOU', async () => {
  const { realpathSync: realRealpath } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'forge-events-toctou-'));
  const orig = { ...__eventsFsForTesting };
  try {
    const forgeDir = join(root, '.forge');
    const attemptDir = join(forgeDir, 'orchestrator', 'tasks', 'TASK-TT', 'attempts', 'att-1');
    mkdirSync(attemptDir, { recursive: true });
    const leaf = join(attemptDir, 'events.jsonl');
    writeFileSync(
      leaf,
      JSON.stringify({ type: 'files_modified', ts: '2026-06-17T00:00:00.000Z', files: ['src/race-leak.ts'] }) + '\n',
    );
    // Override ONLY realpathSync: the leaf resolves to an "external" path (as if a
    // parent was swapped post-check); everything else resolves for real.
    __eventsFsForTesting.realpathSync = ((p: string) => {
      if (p === leaf) return join(root, 'outside', 'events.jsonl');
      return realRealpath(p);
    }) as typeof realRealpath;

    const events = readAttemptEvents({ forgeDir, taskId: 'TASK-TT', attemptId: 'att-1' });
    assert.deepEqual(events, [], 'post-open containment must reject a leaf resolving outside .forge');
  } finally {
    Object.assign(__eventsFsForTesting, orig);
    rmSync(root, { recursive: true, force: true });
  }
});
