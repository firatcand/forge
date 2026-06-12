import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOrchestrateStatus } from '../../../../src/cli/orchestrate/status.ts';

function captureStreams(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on('data', (c: Buffer) => outChunks.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-cli-status-'));
}

function writeState(
  forgeDir: string,
  runId: string,
  body: Record<string, unknown>,
): void {
  const runDir = join(forgeDir, 'orchestrator', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(body));
}

test('orchestrate status exits 1 when the orchestrator dir does not exist', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const result = runOrchestrateStatus({ forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /no runs found/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status with --run-id reads state.json and prints a summary', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    writeState(forgeDir, '0190run1', {
      started_at: '2026-05-13T13:00:00.000Z',
      pid: 12345,
      workers: [
        { task_id: 'FORGE-20', status: 'running' },
        { task_id: 'FORGE-21', status: 'paused_for_question' },
        { task_id: 'FORGE-22', status: 'running' },
      ],
    });
    const result = runOrchestrateStatus({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 0, `stderr: ${err()}`);
    const output = out();
    assert.match(output, /Run: 0190run1/);
    assert.match(output, /Started: 2026-05-13T13:00:00\.000Z/);
    assert.match(output, /PID: 12345/);
    assert.match(output, /Workers: 3/);
    assert.match(output, /running: 2/);
    assert.match(output, /paused_for_question: 1/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status auto-detects the latest run when none provided', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    writeState(forgeDir, '0190run-a', { started_at: '2026-05-13T13:00:00.000Z' });
    writeState(forgeDir, '0190run-b', { started_at: '2026-05-13T13:10:00.000Z' });
    const result = runOrchestrateStatus({ forgeDir, stdout, stderr });
    assert.equal(result.exitCode, 0, `stderr: ${err()}`);
    assert.match(out(), /Run: 0190run-b/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status exits 1 on corrupt state.json', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    const runDir = join(forgeDir, 'orchestrator', '0190run1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), 'not json at all');
    const result = runOrchestrateStatus({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /not valid JSON/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status exits 1 when state.json is missing', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, err } = captureStreams();
  try {
    mkdirSync(join(forgeDir, 'orchestrator', '0190run1'), { recursive: true });
    const result = runOrchestrateStatus({
      runId: '0190run1',
      forgeDir,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 1);
    assert.match(err(), /state file not found/);
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

// ── FORGE-149: status --json envelope ────────────────────────────────────────

test('orchestrate status --json emits an ok envelope mirroring the text fields', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    writeState(forgeDir, '0190run1', {
      started_at: '2026-05-13T13:00:00.000Z',
      pid: 12345,
      workers: [
        { task_id: 'FORGE-20', status: 'running' },
        { task_id: 'FORGE-21', status: 'paused_for_question' },
        { task_id: 'FORGE-22', status: 'running' },
      ],
    });
    const result = runOrchestrateStatus({
      runId: '0190run1',
      forgeDir,
      json: true,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 0, `stderr: ${err()}`);
    const parsed = JSON.parse(out());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.run_id, '0190run1');
    assert.equal(parsed.data.started_at, '2026-05-13T13:00:00.000Z');
    assert.equal(parsed.data.pid, 12345);
    assert.equal(parsed.data.worker_count, 3);
    assert.deepEqual(parsed.data.worker_status_counts, {
      running: 2,
      paused_for_question: 1,
    });
    // No warnings key without --include-warnings.
    assert.ok(!('warnings' in parsed.data));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status --json mirrors text sparseness: omits started_at/pid/worker_status_counts when absent', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out, err } = captureStreams();
  try {
    // Sparse state: no started_at, no pid, and workers OBJECT-shaped (uncountable
    // per-status). The text formatter would print neither "Started:"/"PID:" nor a
    // per-status breakdown — so the JSON must omit those keys ENTIRELY (no null).
    writeState(forgeDir, '0190sparse', {
      workers: { 'FORGE-1': { status: 'running' } },
    });
    const result = runOrchestrateStatus({
      runId: '0190sparse',
      forgeDir,
      json: true,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 0, `stderr: ${err()}`);
    const parsed = JSON.parse(out());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.run_id, '0190sparse');
    assert.equal(parsed.data.worker_count, 1);
    // Key ABSENCE (not null) — mirrors the omitted text lines.
    assert.ok(!('started_at' in parsed.data), 'started_at must be omitted, not null');
    assert.ok(!('pid' in parsed.data), 'pid must be omitted, not null');
    assert.ok(
      !('worker_status_counts' in parsed.data),
      'worker_status_counts must be omitted for object-shaped (uncountable) workers',
    );
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status --json --include-warnings carries the warnings array', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    // Seed a cheap divergence (row 14: lease + terminal state).
    const taskDir = join(forgeDir, 'orchestrator', 'tasks', 'TASK-Z');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'state.json'),
      JSON.stringify({
        version: 1,
        task_id: 'TASK-Z',
        state: 'shipped',
        state_version: 0,
        attempt_count: 0,
        current_attempt_id: null,
        updated_at: '2026-05-19T10:00:00.000Z',
        updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
      }),
    );
    writeFileSync(
      join(taskDir, 'lease.json'),
      JSON.stringify({
        version: 1,
        claim_id: 'claim-X',
        task_id: 'TASK-Z',
        attempt_id: null,
        owner_run_id: 'run-X',
        acquired_at: '2026-05-19T09:00:00.000Z',
        expires_at: '2026-05-19T09:30:00.000Z',
        last_heartbeat_at: '2026-05-19T09:00:00.000Z',
        generation: 0,
        spec_revision: 'git:0000000000000000000000000000000000000000',
      }),
    );
    writeState(forgeDir, '0190run1', { started_at: '2026-05-13T13:00:00.000Z' });
    const result = runOrchestrateStatus({
      runId: '0190run1',
      forgeDir,
      json: true,
      includeWarnings: true,
      stdout,
      stderr,
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(out());
    assert.ok(Array.isArray(parsed.data.warnings));
    assert.ok(parsed.data.warnings.some((w: { task_id: string }) => w.task_id === 'TASK-Z'));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});

test('orchestrate status without --json keeps the text summary unchanged', () => {
  const forgeDir = freshForgeDir();
  const { stdout, stderr, out } = captureStreams();
  try {
    writeState(forgeDir, '0190run1', { started_at: '2026-05-13T13:00:00.000Z', pid: 9 });
    runOrchestrateStatus({ runId: '0190run1', forgeDir, stdout, stderr });
    assert.match(out(), /Run: 0190run1/);
    assert.match(out(), /PID: 9/);
    // Not JSON.
    assert.throws(() => JSON.parse(out()));
  } finally {
    rmSync(forgeDir, { recursive: true, force: true });
  }
});
