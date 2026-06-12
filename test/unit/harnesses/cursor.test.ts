import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorHarness, createHarness } from '../../../src/harnesses/index.ts';
import { isHarnessError } from '../../../src/harnesses/base.ts';
import type { SpawnOpts, SpawnResult, SpawnSubprocess } from '../../../src/harnesses/subprocess.ts';

const okSpawn: SpawnSubprocess = async (): Promise<SpawnResult> => ({
  stdout: '1.2.3',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
});

const dispatchOpts = {
  cwd: '/tmp/wt',
  taskId: 'FORGE-160',
  attemptId: 'a1',
} as const;

// ── Beta gate (defense in depth with the schema refine) ──

test('FORGE-160 — CursorHarness ctor throws EXPERIMENTAL_GATE_CLOSED without betaOptIn', () => {
  assert.throws(
    () => new CursorHarness({ spawnSubprocess: okSpawn }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'EXPERIMENTAL_GATE_CLOSED' &&
      err.host === 'cursor' &&
      /cursor_host_beta_opt_in/.test(err.message),
  );
});

test('FORGE-160 — createHarness("cursor") throws gate error without cursorBetaOptIn', () => {
  assert.throws(
    () => createHarness('cursor', { spawnSubprocess: okSpawn }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'EXPERIMENTAL_GATE_CLOSED' &&
      err.host === 'cursor' &&
      /cursor_host_beta_opt_in/.test(err.message),
  );
});

test('FORGE-160 — createHarness("cursor", { cursorBetaOptIn: true }) returns a CursorHarness', async () => {
  const h = createHarness('cursor', { cursorBetaOptIn: true, spawnSubprocess: okSpawn });
  assert.equal(h.host, 'cursor');
  assert.equal(await h.detectVersion(), '1.2.3');
});

// ── Subprocess arg shape (mock-driven — no live CLI) ──

test('FORGE-160 — dispatchSubagent spawns `agent -p --force --output-format json <prompt>`', async () => {
  let captured: { bin?: string; args?: readonly string[]; opts?: SpawnOpts } = {};
  const spy: SpawnSubprocess = async (bin, args, opts) => {
    captured = { bin, args, opts };
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
  };
  const h = new CursorHarness({ betaOptIn: true, spawnSubprocess: spy });
  const handle = await h.dispatchSubagent('DO THE THING', dispatchOpts);
  await handle.wait();

  assert.equal(captured.bin, 'agent');
  assert.deepEqual(captured.args, ['-p', '--force', '--output-format', 'json', 'DO THE THING']);
  assert.equal(captured.opts?.cwd, '/tmp/wt');
  assert.equal(captured.opts?.host, 'cursor');
});

test('FORGE-160 — dispatchSubagent passes CURSOR_API_KEY through from harness env', async () => {
  let captured: SpawnOpts | undefined;
  const spy: SpawnSubprocess = async (_bin, _args, opts) => {
    captured = opts;
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
  };
  const h = new CursorHarness({
    betaOptIn: true,
    spawnSubprocess: spy,
    env: { CURSOR_API_KEY: 'sk-test-123' },
  });
  const handle = await h.dispatchSubagent('p', dispatchOpts);
  await handle.wait();
  assert.equal(captured?.env?.CURSOR_API_KEY, 'sk-test-123');
});

// ── Primary-only profile (mirrors claude) ──

test('FORGE-160 — runReview throws NOT_SUPPORTED (review hosts stay codex|gemini)', async () => {
  const h = new CursorHarness({ betaOptIn: true, spawnSubprocess: okSpawn });
  await assert.rejects(
    () => h.runReview('d', 'p', dispatchOpts),
    (err: unknown) => isHarnessError(err) && err.code === 'NOT_SUPPORTED' && err.host === 'cursor',
  );
});

test('FORGE-160 — detectVersion probes `agent --version`', async () => {
  let captured: { bin?: string; args?: readonly string[] } = {};
  const spy: SpawnSubprocess = async (bin, args) => {
    captured = { bin, args };
    return { stdout: 'cursor-agent 9.9.9', stderr: '', exitCode: 0, durationMs: 1 };
  };
  const h = new CursorHarness({ betaOptIn: true, spawnSubprocess: spy });
  const v = await h.detectVersion();
  assert.equal(captured.bin, 'agent');
  assert.deepEqual(captured.args, ['--version']);
  assert.equal(v, 'cursor-agent 9.9.9');
});
