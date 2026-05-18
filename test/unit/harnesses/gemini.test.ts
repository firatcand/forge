import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiHarness } from '../../../src/harnesses/gemini.ts';
import { HarnessError, isHarnessError } from '../../../src/harnesses/base.ts';
import type { SpawnResult, SpawnSubprocess } from '../../../src/harnesses/subprocess.ts';

const ENABLED_ENV = { FORGE_GEMINI_EXPERIMENTAL: '1' };
const DISABLED_ENV = { FORGE_GEMINI_EXPERIMENTAL: '0' };

const ok: SpawnResult = { stdout: '0.5.0\n', stderr: '', exitCode: 0, durationMs: 5 };

function recordingSpawn(
  responses: SpawnResult[],
): { spawn: SpawnSubprocess; calls: { cmd: string; args: readonly string[] }[] } {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  let i = 0;
  const spawn: SpawnSubprocess = async (cmd, args) => {
    calls.push({ cmd, args });
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { spawn, calls };
}

function enoentThenOk(okResult: SpawnResult): SpawnSubprocess {
  let first = true;
  return async (cmd) => {
    if (first) {
      first = false;
      if (cmd === 'gemini') {
        throw new HarnessError('BINARY_NOT_FOUND', 'gemini', 'gemini missing');
      }
    }
    return okResult;
  };
}

const dispatchOpts = {
  cwd: '/tmp/wt',
  taskId: 'FORGE-88',
  attemptId: 'a1',
} as const;

test('GeminiHarness ctor throws EXPERIMENTAL_GATE_CLOSED when env var is unset', () => {
  assert.throws(
    () => new GeminiHarness({ env: {} }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'EXPERIMENTAL_GATE_CLOSED' &&
      err.host === 'gemini' &&
      /FORGE_GEMINI_EXPERIMENTAL=1/.test(err.message),
  );
});

test('GeminiHarness ctor throws EXPERIMENTAL_GATE_CLOSED when env var is "0"', () => {
  assert.throws(
    () => new GeminiHarness({ env: DISABLED_ENV }),
    (err: unknown) =>
      isHarnessError(err) && err.code === 'EXPERIMENTAL_GATE_CLOSED',
  );
});

test('GeminiHarness ctor succeeds with FORGE_GEMINI_EXPERIMENTAL=1', () => {
  const h = new GeminiHarness({
    env: ENABLED_ENV,
    spawnSubprocess: async () => ok,
  });
  assert.equal(h.host, 'gemini');
});

test('GeminiHarness resolves binary to "gemini" when on PATH', async () => {
  const { spawn, calls } = recordingSpawn([
    { stdout: '0.5.0', stderr: '', exitCode: 0, durationMs: 1 },
    { stdout: '', stderr: '', exitCode: 0, durationMs: 1 },
  ]);
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const handle = await h.dispatchSubagent('do work', dispatchOpts);
  await handle.wait();
  assert.equal(calls[0].cmd, 'gemini'); // probe
  assert.equal(calls[1].cmd, 'gemini'); // dispatch uses cached binary
  assert.deepEqual(calls[1].args, [
    '-p',
    'do work',
    '--approval-mode=yolo',
  ]);
});

test('GeminiHarness falls back to npx when gemini binary not on PATH', async () => {
  let probeDone = false;
  let dispatchCmd = '';
  let dispatchArgs: readonly string[] = [];
  const spawn: SpawnSubprocess = async (cmd, args) => {
    if (!probeDone) {
      probeDone = true;
      throw new HarnessError('BINARY_NOT_FOUND', 'gemini', 'no gemini');
    }
    dispatchCmd = cmd;
    dispatchArgs = args;
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
  };
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const handle = await h.dispatchSubagent('do work', dispatchOpts);
  await handle.wait();
  assert.equal(dispatchCmd, 'npx');
  assert.deepEqual(dispatchArgs, [
    '@google/gemini-cli',
    '-p',
    'do work',
    '--approval-mode=yolo',
  ]);
});

test('GeminiHarness caches resolved binary across calls', async () => {
  let probes = 0;
  const spawn: SpawnSubprocess = async (cmd, args) => {
    if (args[0] === '--version' && cmd === 'gemini') probes++;
    return { stdout: '0.5.0', stderr: '', exitCode: 0, durationMs: 1 };
  };
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  await h.dispatchSubagent('a', dispatchOpts);
  await h.dispatchSubagent('b', dispatchOpts);
  await h.dispatchSubagent('c', dispatchOpts);
  assert.equal(probes, 1);
});

test('GeminiHarness.runReview parses verdict via shared parser', async () => {
  const verdict = JSON.stringify({
    version: 1,
    verdict: 'changes_requested',
    findings: [{ severity: 'block', path: 'x', message: 'no' }],
    host: 'gemini',
  });
  const { spawn } = recordingSpawn([
    { stdout: '0.5.0', stderr: '', exitCode: 0, durationMs: 1 },
    {
      stdout: `\`\`\`json\n${verdict}\n\`\`\``,
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    },
  ]);
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const r = await h.runReview('diff', 'review', dispatchOpts);
  assert.equal(r.verdict, 'changes_requested');
  assert.equal(r.host, 'gemini');
});
