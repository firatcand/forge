import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiHarness } from '../../../src/harnesses/gemini.ts';
import { HarnessError, isHarnessError } from '../../../src/harnesses/base.ts';
import type {
  SpawnOpts,
  SpawnResult,
  SpawnSubprocess,
} from '../../../src/harnesses/subprocess.ts';

const ENABLED_ENV = { FORGE_GEMINI_EXPERIMENTAL: '1' };
const DISABLED_ENV = { FORGE_GEMINI_EXPERIMENTAL: '0' };

const ok: SpawnResult = { stdout: '0.5.0\n', stderr: '', exitCode: 0, durationMs: 5 };

function recordingSpawn(
  responses: SpawnResult[],
): {
  spawn: SpawnSubprocess;
  calls: { cmd: string; args: readonly string[]; opts: SpawnOpts }[];
} {
  const calls: { cmd: string; args: readonly string[]; opts: SpawnOpts }[] = [];
  let i = 0;
  const spawn: SpawnSubprocess = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { spawn, calls };
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

// /review I4: GeminiHarness no longer falls back to `npx @google/gemini-cli`.
// `gemini` is invoked directly; BINARY_NOT_FOUND from spawnSubprocess
// surfaces with an actionable install hint.
test('GeminiHarness.dispatchSubagent spawns `gemini -p <prompt> --approval-mode=yolo`', async () => {
  const { spawn, calls } = recordingSpawn([ok]);
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const handle = await h.dispatchSubagent('do work', dispatchOpts);
  await handle.wait();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gemini');
  assert.deepEqual(calls[0].args, [
    '-p',
    'do work',
    '--approval-mode=yolo',
  ]);
});

test('GeminiHarness surfaces BINARY_NOT_FOUND fail-fast when gemini missing', async () => {
  const spawn: SpawnSubprocess = async () => {
    throw new HarnessError(
      'BINARY_NOT_FOUND',
      'gemini',
      'gemini not found on PATH. Install the gemini CLI or remove gemini from .forge/settings.yaml.',
    );
  };
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const handle = await h.dispatchSubagent('p', dispatchOpts);
  const result = await handle.wait();
  // dispatchSubagent classifies BINARY_NOT_FOUND as spawn_error verdict.
  assert.equal(result.verdict, 'spawn_error');
});

test('GeminiHarness.runReview parses verdict via shared parser', async () => {
  const verdict = JSON.stringify({
    version: 1,
    verdict: 'changes_requested',
    findings: [{ severity: 'block', path: 'x', message: 'no' }],
    host: 'gemini',
  });
  const { spawn } = recordingSpawn([
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

test('GeminiHarness.runReview passes the diff via stdin, not argv (FORGE-166)', async () => {
  const verdict = JSON.stringify({
    version: 1,
    verdict: 'pass',
    findings: [],
    host: 'gemini',
  });
  const { spawn, calls } = recordingSpawn([
    { stdout: `\`\`\`json\n${verdict}\n\`\`\``, stderr: '', exitCode: 0, durationMs: 5 },
  ]);
  const h = new GeminiHarness({ env: ENABLED_ENV, spawnSubprocess: spawn });
  const bigDiff = 'G'.repeat(5000);
  await h.runReview(bigDiff, 'review', dispatchOpts);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.every((a) => !a.includes(bigDiff)),
    'diff must not be embedded in argv',
  );
  assert.equal(calls[0].opts.stdinPayload, bigDiff);
});
