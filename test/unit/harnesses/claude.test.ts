import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHarness } from '../../../src/harnesses/claude.ts';
import { isHarnessError, type SubagentHandle } from '../../../src/harnesses/base.ts';

const stubHandle: SubagentHandle = {
  taskId: 'FORGE-88',
  attemptId: 'attempt-1',
  wait: async () => ({ verdict: 'completed', exitCode: 0, durationMs: 1 }),
};

test('ClaudeHarness exposes host = "claude"', () => {
  const h = new ClaudeHarness({ spawnSubagent: async () => stubHandle });
  assert.equal(h.host, 'claude');
});

test('ClaudeHarness ctor throws CALLBACK_MISSING when no callback provided', () => {
  assert.throws(
    () => new ClaudeHarness({} as never),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'CALLBACK_MISSING' &&
      err.host === 'claude',
  );
});

test('ClaudeHarness ctor throws CALLBACK_MISSING when callback is not a function', () => {
  assert.throws(
    () => new ClaudeHarness({ spawnSubagent: 'not-a-fn' as never }),
    (err: unknown) =>
      isHarnessError(err) && err.code === 'CALLBACK_MISSING',
  );
});

test('ClaudeHarness.dispatchSubagent forwards prompt + opts to callback', async () => {
  const seen: { prompt?: string; cwd?: string } = {};
  const h = new ClaudeHarness({
    spawnSubagent: async (prompt, opts) => {
      seen.prompt = prompt;
      seen.cwd = opts.cwd;
      return stubHandle;
    },
  });
  const handle = await h.dispatchSubagent('do work', {
    cwd: '/tmp/wt',
    taskId: 'FORGE-88',
    attemptId: 'a1',
  });
  assert.equal(seen.prompt, 'do work');
  assert.equal(seen.cwd, '/tmp/wt');
  assert.equal(handle.taskId, 'FORGE-88');
});

test('ClaudeHarness.runReview throws NOT_SUPPORTED with actionable message', async () => {
  const h = new ClaudeHarness({ spawnSubagent: async () => stubHandle });
  await assert.rejects(
    () =>
      h.runReview('diff', 'prompt', {
        cwd: '/tmp',
        taskId: 'FORGE-88',
        attemptId: 'a1',
      }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'NOT_SUPPORTED' &&
      err.host === 'claude' &&
      /review_host_cli/.test(err.message),
  );
});

// /review N3: healthCheck reports CC-session status via env detection.
test('ClaudeHarness.healthCheck returns ok:true when CLAUDE_CODE env is set', async () => {
  const h = new ClaudeHarness({
    spawnSubagent: async () => stubHandle,
    env: { CLAUDE_CODE: '1' },
  });
  const r = await h.healthCheck();
  assert.equal(r.ok, true);
  assert.equal(r.version, 'in-session');
});

test('ClaudeHarness.healthCheck returns ok:false with hint when CLAUDE_CODE env is unset', async () => {
  const h = new ClaudeHarness({
    spawnSubagent: async () => stubHandle,
    env: {},
  });
  const r = await h.healthCheck();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /Claude Code session/);
  assert.match(r.message ?? '', /primary_host_cli/);
});

test('ClaudeHarness.detectVersion returns in-session', async () => {
  const h = new ClaudeHarness({
    spawnSubagent: async () => stubHandle,
    env: { CLAUDE_CODE: '1' },
  });
  assert.equal(await h.detectVersion(), 'in-session');
});
