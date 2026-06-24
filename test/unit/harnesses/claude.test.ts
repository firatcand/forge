import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHarness } from '../../../src/harnesses/claude.ts';
import { isHarnessError, type SubagentHandle } from '../../../src/harnesses/base.ts';
import type {
  SpawnOpts,
  SpawnResult,
  SpawnSubprocess,
} from '../../../src/harnesses/subprocess.ts';

const stubHandle: SubagentHandle = {
  taskId: 'FORGE-88',
  attemptId: 'attempt-1',
  wait: async () => ({ verdict: 'completed', exitCode: 0, durationMs: 1 }),
};

function recordingSpawn(result: SpawnResult): {
  spawn: SpawnSubprocess;
  calls: { cmd: string; args: readonly string[]; opts: SpawnOpts }[];
} {
  const calls: { cmd: string; args: readonly string[]; opts: SpawnOpts }[] = [];
  const spawn: SpawnSubprocess = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { spawn, calls };
}

function fenced(verdict: unknown): SpawnResult {
  return {
    stdout: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
    stderr: '',
    exitCode: 0,
    durationMs: 5,
  };
}

const dispatchOpts = {
  cwd: '/tmp/wt',
  taskId: 'FORGE-88',
  attemptId: 'a1',
} as const;

test('ClaudeHarness exposes host = "claude" (review-only construction needs no callback)', () => {
  const h = new ClaudeHarness();
  assert.equal(h.host, 'claude');
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

// FORGE-223: the callback requirement moved from the ctor to dispatch time so a
// review-only harness can be built. dispatchSubagent must still reject without it.
test('ClaudeHarness.dispatchSubagent throws CALLBACK_MISSING when no callback was provided', async () => {
  const h = new ClaudeHarness();
  await assert.rejects(
    () => h.dispatchSubagent('do work', dispatchOpts),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'CALLBACK_MISSING' &&
      err.host === 'claude',
  );
});

test('ClaudeHarness.dispatchSubagent throws CALLBACK_MISSING when callback is not a function', async () => {
  const h = new ClaudeHarness({ spawnSubagent: 'not-a-fn' as never });
  await assert.rejects(
    () => h.dispatchSubagent('do work', dispatchOpts),
    (err: unknown) => isHarnessError(err) && err.code === 'CALLBACK_MISSING',
  );
});

test('ClaudeHarness.runReview parses a fenced JSON verdict with host="claude"', async () => {
  const { spawn } = recordingSpawn(
    fenced({
      version: 1,
      verdict: 'pass',
      findings: [{ severity: 'improvement', path: 'x', message: 'ok' }],
      host: 'claude',
    }),
  );
  const h = new ClaudeHarness({ spawnSubprocess: spawn });
  const result = await h.runReview('diff', 'review please', dispatchOpts);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.host, 'claude');
});

test('ClaudeHarness.runReview synthesizes a verdict when stdout is free-form', async () => {
  const { spawn } = recordingSpawn({
    stdout: 'looks fine to me',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
  });
  const h = new ClaudeHarness({ spawnSubprocess: spawn });
  const result = await h.runReview('diff', 'review', dispatchOpts);
  assert.equal(result.verdict, 'changes_requested');
  assert.equal(result.host, 'claude');
  assert.match(result.findings[0].message, /looks fine/);
});

test('ClaudeHarness.runReview invokes `claude -p` with the EXACT argv (no permission/tool flags), prompt last', async () => {
  const { spawn, calls } = recordingSpawn(
    fenced({ version: 1, verdict: 'pass', findings: [], host: 'claude' }),
  );
  const h = new ClaudeHarness({ spawnSubprocess: spawn });
  await h.runReview('diff', 'review please', dispatchOpts);
  assert.equal(calls[0].cmd, 'claude');
  // Codex review: assert the EXACT argv. FORGE-223 AC mandates
  // `claude -p --output-format text --no-session-persistence` with the prompt
  // as the final positional and NO permission/tool flags — deepEqual fails the
  // moment any flag is added or removed, unlike a loose includes() check.
  assert.deepEqual(calls[0].args, [
    '-p',
    '--output-format',
    'text',
    '--no-session-persistence',
    'review please\n\nThe diff under review is provided via stdin.',
  ]);
});

test('ClaudeHarness.runReview passes the diff via stdin, not argv (FORGE-166)', async () => {
  const { spawn, calls } = recordingSpawn(
    fenced({ version: 1, verdict: 'pass', findings: [], host: 'claude' }),
  );
  const h = new ClaudeHarness({ spawnSubprocess: spawn });
  const bigDiff = 'D'.repeat(5000);
  await h.runReview(bigDiff, 'review please', dispatchOpts);
  assert.ok(
    calls[0].args.every((a) => !a.includes(bigDiff)),
    'diff must not be embedded in argv',
  );
  assert.equal(calls[0].opts.stdinPayload, bigDiff);
});

// Codex review H1: runReview must forward DispatchOpts.env ONLY — never the
// ctor env (which defaults to process.env). Forwarding process.env would
// re-leak secrets into the review subprocess past the SAFE_ENV_KEYS allowlist.
test('ClaudeHarness.runReview never forwards the ctor env to the subprocess', async () => {
  const { spawn, calls } = recordingSpawn(
    fenced({ version: 1, verdict: 'pass', findings: [], host: 'claude' }),
  );
  const h = new ClaudeHarness({
    spawnSubprocess: spawn,
    env: { SECRET_TOKEN: 'leak-me' },
  });
  // DispatchOpts carries no env here, so the spawn must receive env=undefined
  // (→ subprocess.ts applies its SAFE_ENV_KEYS allowlist), not the ctor env.
  await h.runReview('diff', 'review please', dispatchOpts);
  assert.equal(calls[0].opts.env, undefined);
});

test('ClaudeHarness.runReview rejects a verdict claiming a different host', async () => {
  const { spawn } = recordingSpawn(
    fenced({ version: 1, verdict: 'pass', findings: [], host: 'codex' }),
  );
  const h = new ClaudeHarness({ spawnSubprocess: spawn });
  await assert.rejects(
    () => h.runReview('diff', 'review', dispatchOpts),
    (err: unknown) => isHarnessError(err) && err.code === 'INVALID_STDOUT',
  );
});

// /review N3: healthCheck reports CC-session status via env detection.
test('ClaudeHarness.healthCheck returns ok:true when CLAUDE_CODE env is set', async () => {
  const h = new ClaudeHarness({ env: { CLAUDE_CODE: '1' } });
  const r = await h.healthCheck();
  assert.equal(r.ok, true);
  assert.equal(r.version, 'in-session');
});

test('ClaudeHarness.healthCheck returns ok:false with hint when CLAUDE_CODE env is unset', async () => {
  const h = new ClaudeHarness({ env: {} });
  const r = await h.healthCheck();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /Claude Code session/);
  assert.match(r.message ?? '', /primary_host_cli/);
});

test('ClaudeHarness.detectVersion returns in-session', async () => {
  const h = new ClaudeHarness({ env: { CLAUDE_CODE: '1' } });
  assert.equal(await h.detectVersion(), 'in-session');
});
