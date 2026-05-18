import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexHarness } from '../../../src/harnesses/codex.ts';
import { HarnessError } from '../../../src/harnesses/base.ts';
import type { SpawnResult, SpawnSubprocess } from '../../../src/harnesses/subprocess.ts';

function recordingSpawn(
  result: SpawnResult,
): { spawn: SpawnSubprocess; calls: { cmd: string; args: readonly string[] }[] } {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const spawn: SpawnSubprocess = async (cmd, args) => {
    calls.push({ cmd, args });
    return result;
  };
  return { spawn, calls };
}

function failingSpawn(err: unknown): SpawnSubprocess {
  return async () => {
    throw err;
  };
}

const ok: SpawnResult = { stdout: '', stderr: '', exitCode: 0, durationMs: 12 };

const dispatchOpts = {
  cwd: '/tmp/wt',
  taskId: 'FORGE-88',
  attemptId: 'a1',
} as const;

test('CodexHarness.host = "codex"', () => {
  assert.equal(new CodexHarness().host, 'codex');
});

test('CodexHarness.dispatchSubagent spawns codex exec with rendered prompt', async () => {
  const { spawn, calls } = recordingSpawn(ok);
  const h = new CodexHarness({ spawnSubprocess: spawn });
  const handle = await h.dispatchSubagent('do work', dispatchOpts);
  const result = await handle.wait();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
  assert.deepEqual(calls[0].args, ['exec', '--color', 'never', 'do work']);
  assert.equal(result.verdict, 'completed');
  assert.equal(result.exitCode, 0);
});

test('CodexHarness.dispatchSubagent classifies TIMEOUT into timeout verdict', async () => {
  const err = new HarnessError('TIMEOUT', 'codex', 'too slow');
  const h = new CodexHarness({ spawnSubprocess: failingSpawn(err) });
  const handle = await h.dispatchSubagent('p', dispatchOpts);
  const result = await handle.wait();
  assert.equal(result.verdict, 'timeout');
});

test('CodexHarness.dispatchSubagent classifies BINARY_NOT_FOUND into spawn_error', async () => {
  const err = new HarnessError('BINARY_NOT_FOUND', 'codex', 'missing');
  const h = new CodexHarness({ spawnSubprocess: failingSpawn(err) });
  const handle = await h.dispatchSubagent('p', dispatchOpts);
  const result = await handle.wait();
  assert.equal(result.verdict, 'spawn_error');
});

test('CodexHarness.runReview parses a fenced JSON block from stdout', async () => {
  const verdict = JSON.stringify({
    version: 1,
    verdict: 'pass',
    findings: [{ severity: 'improvement', path: 'x', message: 'ok' }],
    host: 'codex',
  });
  const { spawn } = recordingSpawn({
    stdout: `\`\`\`json\n${verdict}\n\`\`\``,
    stderr: '',
    exitCode: 0,
    durationMs: 5,
  });
  const h = new CodexHarness({ spawnSubprocess: spawn });
  const result = await h.runReview('diff', 'review please', dispatchOpts);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.host, 'codex');
});

test('CodexHarness.runReview synthesizes a verdict when stdout is free-form', async () => {
  const { spawn } = recordingSpawn({
    stdout: 'looks fine to me',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
  });
  const h = new CodexHarness({ spawnSubprocess: spawn });
  const result = await h.runReview('diff', 'review', dispatchOpts);
  assert.equal(result.verdict, 'changes_requested');
  assert.equal(result.findings[0].severity, 'improvement');
  assert.match(result.findings[0].message, /looks fine/);
});

test('CodexHarness.healthCheck returns ok:true with version string when codex --version succeeds', async () => {
  const { spawn } = recordingSpawn({
    stdout: '0.1.5\n',
    stderr: '',
    exitCode: 0,
    durationMs: 3,
  });
  const h = new CodexHarness({ spawnSubprocess: spawn });
  const r = await h.healthCheck();
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.1.5');
});

test('CodexHarness.healthCheck returns ok:false when codex binary missing', async () => {
  const err = new HarnessError(
    'BINARY_NOT_FOUND',
    'codex',
    'codex not found on PATH',
  );
  const h = new CodexHarness({ spawnSubprocess: failingSpawn(err) });
  const r = await h.healthCheck();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /not found on PATH/);
});

test('CodexHarness.detectVersion trims stdout', async () => {
  const { spawn } = recordingSpawn({
    stdout: '  1.2.3  \n',
    stderr: '',
    exitCode: 0,
    durationMs: 3,
  });
  const h = new CodexHarness({ spawnSubprocess: spawn });
  assert.equal(await h.detectVersion(), '1.2.3');
});
