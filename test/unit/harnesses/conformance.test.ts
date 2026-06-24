import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaudeHarness,
  CodexHarness,
  CursorHarness,
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
      harness: new ClaudeHarness({
        spawnSubagent: async () => stubHandle,
        // /review N3: ClaudeHarness.healthCheck now requires CLAUDE_CODE in
        // the harness's env to return ok:true. Inject it for conformance.
        env: { CLAUDE_CODE: '1' },
      }),
    },
    { name: 'codex', harness: new CodexHarness({ spawnSubprocess: okSpawn }) },
    {
      name: 'gemini',
      harness: new GeminiHarness({
        env: { FORGE_GEMINI_EXPERIMENTAL: '1' },
        spawnSubprocess: okSpawn,
      }),
    },
    {
      // FORGE-160: cursor is primary-only, beta-gated; opt in for conformance.
      name: 'cursor',
      harness: new CursorHarness({ betaOptIn: true, spawnSubprocess: okSpawn }),
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

  // /review I6: the stubs in makeHarnesses() are all configured to succeed,
  // so the happy-path verdict MUST be 'completed'. Asserting equality (not
  // set membership) catches a harness that miscategorises a successful exit
  // as anything else — set-membership only catches TS-level enum violations.
  test(`${name}: wait() resolves to 'completed' for a successful stubbed dispatch`, async () => {
    const handle = await harness.dispatchSubagent('prompt', dispatchOpts);
    const r = await handle.wait();
    assert.equal(r.verdict, 'completed', `${name} should report completed on stubbed success`);
    assert.equal(typeof r.exitCode, 'number');
    assert.equal(typeof r.durationMs, 'number');
  });

  test(`${name}: healthCheck returns a HealthResult shape with ok=true on stubbed success`, async () => {
    const r = await harness.healthCheck();
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(r.ok, true, `${name} stubs are success-shaped; healthCheck must reflect that`);
  });

  test(`${name}: detectVersion returns a non-empty string`, async () => {
    const v = await harness.detectVersion();
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, 'version must be non-empty');
  });
}

// FORGE-223: claude is now a reviewable host. runReview parses a fenced verdict
// from the `claude -p` subprocess through the same path as codex/gemini.
test('claude: runReview parses a fenced verdict (FORGE-223)', async () => {
  const reviewSpawn: SpawnSubprocess = async () => ({
    stdout:
      '```json\n{"version":1,"verdict":"pass","findings":[],"host":"claude"}\n```',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  });
  const h = new ClaudeHarness({ spawnSubprocess: reviewSpawn });
  const verdict = await h.runReview('d', 'p', dispatchOpts);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.host, 'claude');
});

// FORGE-223: createHarness("claude") with only spawnSubprocess builds a
// review-capable harness (no throw); the dispatch path still requires the
// callback, enforced at call time.
test('createHarness("claude", { spawnSubprocess }) wires the spawner through runReview', async () => {
  // Codex review: assert the injected spawner actually drives runReview, not
  // just that .host is set — proves the review path is wired end-to-end.
  const reviewSpawn: SpawnSubprocess = async () => ({
    stdout:
      '```json\n{"version":1,"verdict":"pass","findings":[],"host":"claude"}\n```',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  });
  const h = createHarness('claude', { spawnSubprocess: reviewSpawn });
  assert.equal(h.host, 'claude');
  const verdict = await h.runReview('d', 'p', dispatchOpts);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.host, 'claude');
});

test('createHarness("claude") dispatch still rejects CALLBACK_MISSING without a callback', async () => {
  const h = createHarness('claude');
  assert.equal(h.host, 'claude');
  await assert.rejects(
    () => h.dispatchSubagent('p', dispatchOpts),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'CALLBACK_MISSING' &&
      err.host === 'claude',
  );
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
