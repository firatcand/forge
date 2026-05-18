import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudeHarness,
  CodexHarness,
  GeminiHarness,
  createHarness,
} from '../../../src/harnesses/index.ts';
import {
  isHarnessError,
  type IHarness,
  type SubagentHandle,
} from '../../../src/harnesses/base.ts';
import type { SpawnResult, SpawnSubprocess } from '../../../src/harnesses/subprocess.ts';

const stubHandle: SubagentHandle = {
  taskId: 'FORGE-88',
  attemptId: 'a1',
  wait: async () => ({ verdict: 'completed', exitCode: 0, durationMs: 1 }),
};

const okSpawn: SpawnSubprocess = async (): Promise<SpawnResult> => ({
  stdout: '0.0.0',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
});

function makeHarnesses(): { name: string; harness: IHarness }[] {
  return [
    {
      name: 'claude',
      harness: new ClaudeHarness({ spawnSubagent: async () => stubHandle }),
    },
    { name: 'codex', harness: new CodexHarness({ spawnSubprocess: okSpawn }) },
    {
      name: 'gemini',
      harness: new GeminiHarness({
        env: { FORGE_GEMINI_EXPERIMENTAL: '1' },
        spawnSubprocess: okSpawn,
      }),
    },
  ];
}

const dispatchOpts = {
  cwd: '/tmp/wt',
  taskId: 'FORGE-88',
  attemptId: 'a1',
} as const;

for (const { name, harness } of makeHarnesses()) {
  test(`${name}: exposes IHarness.host matching its name`, () => {
    assert.equal(harness.host, name);
  });

  test(`${name}: dispatchSubagent returns a SubagentHandle with task/attempt IDs`, async () => {
    const handle = await harness.dispatchSubagent('prompt', dispatchOpts);
    assert.equal(handle.taskId, 'FORGE-88');
    assert.equal(handle.attemptId, 'a1');
    assert.equal(typeof handle.wait, 'function');
  });

  test(`${name}: wait() resolves to a SubagentResult shape`, async () => {
    const handle = await harness.dispatchSubagent('prompt', dispatchOpts);
    const r = await handle.wait();
    assert.ok(
      ['completed', 'blocked', 'stolen', 'timeout', 'spawn_error'].includes(
        r.verdict,
      ),
      `unexpected verdict: ${r.verdict}`,
    );
    assert.equal(typeof r.exitCode, 'number');
    assert.equal(typeof r.durationMs, 'number');
  });

  test(`${name}: healthCheck returns a HealthResult shape`, async () => {
    const r = await harness.healthCheck();
    assert.equal(typeof r.ok, 'boolean');
  });

  test(`${name}: detectVersion returns a non-empty string`, async () => {
    const v = await harness.detectVersion();
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, 'version must be non-empty');
  });
}

test('claude: runReview throws NOT_SUPPORTED (conformance rule)', async () => {
  const h = new ClaudeHarness({ spawnSubagent: async () => stubHandle });
  await assert.rejects(
    () => h.runReview('d', 'p', dispatchOpts),
    (err: unknown) =>
      isHarnessError(err) && err.code === 'NOT_SUPPORTED',
  );
});

test('createHarness("claude") throws without spawnSubagent', () => {
  assert.throws(() => createHarness('claude'));
});

test('createHarness("codex") returns CodexHarness wired with custom spawn', async () => {
  const h = createHarness('codex', { spawnSubprocess: okSpawn });
  assert.equal(h.host, 'codex');
  assert.equal(await h.detectVersion(), '0.0.0');
});

test('createHarness("gemini") respects env gate', () => {
  assert.throws(
    () => createHarness('gemini', { env: {}, spawnSubprocess: okSpawn }),
    (err: unknown) =>
      isHarnessError(err) && err.code === 'EXPERIMENTAL_GATE_CLOSED',
  );
  const h = createHarness('gemini', {
    env: { FORGE_GEMINI_EXPERIMENTAL: '1' },
    spawnSubprocess: okSpawn,
  });
  assert.equal(h.host, 'gemini');
});
