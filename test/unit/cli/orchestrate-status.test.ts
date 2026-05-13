import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOrchestrateStatus } from '../../../src/cli/orchestrate-status.ts';

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
