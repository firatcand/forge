import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_DIFF_BYTES,
  MAX_PROMPT_BYTES,
  runOrchestrateSecondOpinion,
  type SecondOpinionHarnessFactory,
} from '../../../../src/cli/orchestrate/second-opinion.ts';
import {
  HarnessError,
  type DispatchOpts,
  type HealthResult,
  type IHarness,
  type ReviewVerdict,
  type SpawnSubprocess,
  type SubagentHandle,
} from '../../../../src/harnesses/index.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────

function freshProject(opts: {
  reviewHostCli?: 'claude' | 'codex' | 'gemini' | null;
  primaryHostCli?: 'claude' | 'codex' | 'gemini';
  diffContent?: string;
  promptContent?: string;
}): { forgeDir: string; cwd: string; diffPath: string; promptPath: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-second-opinion-'));
  const forgeDir = join(cwd, '.forge');
  mkdirSync(forgeDir, { recursive: true });

  const reviewLine =
    opts.reviewHostCli === null
      ? '    review_host_cli: null\n'
      : `    review_host_cli: ${opts.reviewHostCli ?? 'codex'}\n`;
  const primaryLine = `    primary_host_cli: ${opts.primaryHostCli ?? 'claude'}\n`;
  const yaml = `version: 1
project:
  name: test-second-opinion
tracker:
  type: linear
  config:
    team_id: T
secrets:
  manager: env_file
agents:
${primaryLine}${reviewLine}`;
  writeFileSync(join(forgeDir, 'settings.yaml'), yaml, 'utf8');

  const diffPath = join(cwd, 'diff.txt');
  const promptPath = join(cwd, 'prompt.txt');
  writeFileSync(diffPath, opts.diffContent ?? 'diff --git a/x b/x\n+hello\n', 'utf8');
  writeFileSync(promptPath, opts.promptContent ?? 'Review this diff.\n', 'utf8');

  return { forgeDir, cwd, diffPath, promptPath, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function captureStdout(t: { after: (fn: () => void) => void }): { lines: string[] } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return { lines: captured };
}

function lastEnvelope(lines: string[]): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
} {
  const last = lines[lines.length - 1] ?? '';
  return JSON.parse(last);
}

// Minimal fake harness that returns a fixed verdict shape; tests assert the
// envelope ferries it through unchanged.
function fakeHarness(host: 'claude' | 'codex' | 'gemini', verdict?: Partial<ReviewVerdict>): IHarness {
  const base: ReviewVerdict = {
    version: 1,
    host,
    verdict: 'pass',
    findings: [],
    ...verdict,
  };
  return {
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('dispatchSubagent not used in review path');
    },
    async runReview(_diff: string, _prompt: string, _opts: DispatchOpts): Promise<ReviewVerdict> {
      return base;
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: true, version: '0.0.0-test' };
    },
    async detectVersion(): Promise<string> {
      return '0.0.0-test';
    },
  };
}

// ── Arg validation ─────────────────────────────────────────────────────────

test('second-opinion: missing taskId → INVALID_ARGS', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: '',
    diffPath,
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, 'INVALID_ARGS');
});

test('second-opinion: malformed taskId → INVALID_ARGS', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    // FORGE-130: lowercase ids (e.g. `lowercase-1`) are now valid under the
    // unified task-id shape. Use a `#`-prefixed id, which the shape rejects.
    taskId: '#42',
    diffPath,
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'INVALID_ARGS');
});

test('second-opinion: missing diff file → MISSING_INPUT', async (t) => {
  const { forgeDir, cwd, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath: join(cwd, 'nonexistent-diff.txt'),
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'MISSING_INPUT');
  assert.ok(env.error?.message.includes('nonexistent-diff.txt'));
});

test('second-opinion: diff file exceeding MAX_DIFF_BYTES → DIFF_TOO_LARGE', async (t) => {
  // Generate a diff slightly over the cap; assert the verb rejects before spawning.
  const oversize = 'a'.repeat(MAX_DIFF_BYTES + 1);
  const { forgeDir, promptPath, cwd, cleanup } = freshProject({});
  const oversizeDiff = join(cwd, 'huge-diff.txt');
  writeFileSync(oversizeDiff, oversize, 'utf8');
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath: oversizeDiff,
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'DIFF_TOO_LARGE');
  assert.equal(env.error?.details?.size, MAX_DIFF_BYTES + 1);
  assert.equal(env.error?.details?.max, MAX_DIFF_BYTES);
});

test('second-opinion: prompt file exceeding MAX_PROMPT_BYTES → PROMPT_TOO_LARGE', async (t) => {
  const oversize = 'a'.repeat(MAX_PROMPT_BYTES + 1);
  const { forgeDir, diffPath, cwd, cleanup } = freshProject({});
  const oversizePrompt = join(cwd, 'huge-prompt.txt');
  writeFileSync(oversizePrompt, oversize, 'utf8');
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath,
    promptPath: oversizePrompt,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'PROMPT_TOO_LARGE');
});

test('second-opinion: missing prompt file → MISSING_INPUT', async (t) => {
  const { forgeDir, cwd, diffPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath,
    promptPath: join(cwd, 'nonexistent-prompt.txt'),
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'MISSING_INPUT');
  assert.ok(env.error?.message.includes('nonexistent-prompt.txt'));
});

// ── Settings paths ─────────────────────────────────────────────────────────

test('second-opinion: missing settings.yaml → SETTINGS_NOT_FOUND', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-no-settings-'));
  const forgeDir = join(cwd, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  const diffPath = join(cwd, 'd.txt');
  const promptPath = join(cwd, 'p.txt');
  writeFileSync(diffPath, 'd', 'utf8');
  writeFileSync(promptPath, 'p', 'utf8');
  const { lines } = captureStdout(t);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath,
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'SETTINGS_NOT_FOUND');
});

test('second-opinion: review_host_cli=null → REVIEW_DISABLED', async (t) => {
  // Setting review_host_cli=null requires primary_host_cli to also not collide.
  // Default primary=claude works since null ≠ claude.
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({ reviewHostCli: null });
  const { lines } = captureStdout(t);
  t.after(cleanup);
  const result = await runOrchestrateSecondOpinion({
    taskId: 'FORGE-1',
    diffPath,
    promptPath,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'REVIEW_DISABLED');
  assert.ok(env.error?.message.includes('review_host_cli is null'));
});

// ── Happy path (mocked harness) ────────────────────────────────────────────

test('second-opinion: codex variant returns verdict envelope', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({ reviewHostCli: 'codex' });
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => fakeHarness(host as 'codex' | 'gemini');
  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-99',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data?.host, 'codex');
  assert.equal(env.data?.task_id, 'FORGE-99');
  assert.ok(typeof env.data?.attempt_id === 'string');
  const verdict = env.data?.verdict as ReviewVerdict;
  assert.equal(verdict.host, 'codex');
  assert.equal(verdict.verdict, 'pass');
});

test('second-opinion: gemini variant returns equivalent verdict shape (different host)', async (t) => {
  // Gemini requires FORGE_GEMINI_EXPERIMENTAL=1 — set on process.env for parse-time refinement.
  const prior = process.env.FORGE_GEMINI_EXPERIMENTAL;
  process.env.FORGE_GEMINI_EXPERIMENTAL = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GEMINI_EXPERIMENTAL;
    else process.env.FORGE_GEMINI_EXPERIMENTAL = prior;
  });
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({ reviewHostCli: 'gemini' });
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => fakeHarness(host as 'codex' | 'gemini');
  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-99',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data?.host, 'gemini');
  const verdict = env.data?.verdict as ReviewVerdict;
  assert.equal(verdict.host, 'gemini');
  // Shape parity with the codex case: same verdict/findings keys.
  assert.equal(verdict.verdict, 'pass');
  assert.deepEqual(verdict.findings, []);
});

// ── FORGE-224: claude as review host ─────────────────────────────────────────

test('second-opinion: claude reviewer happy-path (binary reachable) returns verdict envelope', async (t) => {
  // primary must differ from review (settings refine): primary=codex, review=claude.
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({
    primaryHostCli: 'codex',
    reviewHostCli: 'claude',
  });
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) =>
    fakeHarness(host as 'claude' | 'codex' | 'gemini');
  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-99',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    {
      factory,
      // Inject a reachable probe so the test never touches the real claude binary.
      probeReviewBin: async () => true,
    },
  );

  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data?.host, 'claude');
  const verdict = env.data?.verdict as ReviewVerdict;
  assert.equal(verdict.host, 'claude');
  assert.equal(verdict.verdict, 'pass');
});

test('second-opinion: claude reviewer with claude binary UNREACHABLE → BINARY_NOT_FOUND (no throw, no dispatch)', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({
    primaryHostCli: 'codex',
    reviewHostCli: 'claude',
  });
  const { lines } = captureStdout(t);
  t.after(cleanup);

  // The factory must NOT be invoked when the probe fails — assert via a throwing
  // factory that would surface as HARNESS_INIT_FAILED if reached.
  const factory: SecondOpinionHarnessFactory = () => {
    throw new Error('factory must not be called when claude binary is unreachable');
  };
  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-99',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    {
      factory,
      probeReviewBin: async () => false,
    },
  );

  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, 'BINARY_NOT_FOUND');
  assert.ok(env.error?.message.includes("claude' CLI on PATH"));
  assert.equal(env.error?.details?.reviewHost, 'claude');
});

test('second-opinion: codex reviewer does NOT run the claude binary probe', async (t) => {
  // The probe is claude-only; a codex review must not invoke it even if injected.
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({ reviewHostCli: 'codex' });
  // Suppress stdout for this run; this test asserts probe behaviour, not output.
  captureStdout(t);
  t.after(cleanup);

  let probed = false;
  const factory: SecondOpinionHarnessFactory = (host) =>
    fakeHarness(host as 'claude' | 'codex' | 'gemini');
  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    {
      factory,
      probeReviewBin: async () => {
        probed = true;
        return false;
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(probed, false, 'claude probe must not run for a codex review host');
});

test('second-opinion: claude via the PRODUCTION factory + injected spawnSubprocess parses a claude -p verdict', async (t) => {
  // Codex review gap: the happy-path above injects a fake factory. This test
  // uses NO factory, so defaultFactory → createHarness('claude', { spawnSubprocess })
  // builds a real review-only ClaudeHarness; we only stub the subprocess. This
  // proves the production bridge (ClaudeHarness.runReview → claude -p → verdict
  // parser) end to end.
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({
    primaryHostCli: 'codex',
    reviewHostCli: 'claude',
  });
  const { lines } = captureStdout(t);
  t.after(cleanup);

  // Fake `claude -p` stdout: a fenced ReviewVerdict JSON with host:claude.
  const spawnSubprocess: SpawnSubprocess = async (_cmd, _args, _opts) => ({
    stdout: '```json\n{"version":1,"host":"claude","verdict":"pass","findings":[]}\n```',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  });

  const result = await runOrchestrateSecondOpinion(
    { taskId: 'FORGE-99', diffPath, promptPath, forgeDir, json: true },
    {
      // No factory → exercises defaultFactory + the real createHarness('claude').
      spawnSubprocess,
      probeReviewBin: async () => true,
    },
  );

  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data?.host, 'claude');
  assert.equal((env.data?.verdict as ReviewVerdict).verdict, 'pass');
});

// ── Harness error pass-through ─────────────────────────────────────────────

test('second-opinion: HarnessError BINARY_NOT_FOUND → envelope code BINARY_NOT_FOUND', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => ({
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('not used');
    },
    async runReview(): Promise<ReviewVerdict> {
      throw new HarnessError('BINARY_NOT_FOUND', host as 'codex' | 'gemini', 'codex binary not found on PATH');
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: false };
    },
    async detectVersion(): Promise<string> {
      return '';
    },
  });

  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'BINARY_NOT_FOUND');
  assert.equal(env.error?.details?.host, 'codex');
});

test('second-opinion: HarnessError SPAWN_FAILED marked retriable', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => ({
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('not used');
    },
    async runReview(): Promise<ReviewVerdict> {
      throw new HarnessError('SPAWN_FAILED', host as 'codex' | 'gemini', 'execa rejected with ENOENT');
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: false };
    },
    async detectVersion(): Promise<string> {
      return '';
    },
  });

  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'SPAWN_FAILED');
  // Read the envelope's retriable bit directly from the raw stdout, since
  // captureStdout flattens through lastEnvelope().
  const raw = JSON.parse(lines[lines.length - 1] ?? '{}');
  assert.equal(raw.error.retriable, true, 'SPAWN_FAILED must be marked retriable');
});

test('second-opinion: HarnessError TIMEOUT marked retriable', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => ({
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('not used');
    },
    async runReview(): Promise<ReviewVerdict> {
      throw new HarnessError('TIMEOUT', host as 'codex' | 'gemini', 'subprocess timed out');
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: false };
    },
    async detectVersion(): Promise<string> {
      return '';
    },
  });

  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'TIMEOUT');
  const raw = JSON.parse(lines[lines.length - 1] ?? '{}');
  assert.equal(raw.error.retriable, true, 'TIMEOUT must be marked retriable');
});

test('second-opinion: HarnessError NON_ZERO_EXIT NOT marked retriable', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => ({
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('not used');
    },
    async runReview(): Promise<ReviewVerdict> {
      throw new HarnessError('NON_ZERO_EXIT', host as 'codex' | 'gemini', 'codex exited 2');
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: false };
    },
    async detectVersion(): Promise<string> {
      return '';
    },
  });

  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 1);
  const raw = JSON.parse(lines[lines.length - 1] ?? '{}');
  assert.equal(raw.error.code, 'NON_ZERO_EXIT');
  assert.equal(raw.error.retriable, false, 'NON_ZERO_EXIT must NOT be marked retriable');
});

test('second-opinion: non-HarnessError thrown by runReview → REVIEW_FAILED', async (t) => {
  const { forgeDir, diffPath, promptPath, cleanup } = freshProject({});
  const { lines } = captureStdout(t);
  t.after(cleanup);

  const factory: SecondOpinionHarnessFactory = (host) => ({
    host,
    async dispatchSubagent(): Promise<SubagentHandle> {
      throw new Error('not used');
    },
    async runReview(): Promise<ReviewVerdict> {
      throw new Error('unexpected crash');
    },
    async healthCheck(): Promise<HealthResult> {
      return { ok: false };
    },
    async detectVersion(): Promise<string> {
      return '';
    },
  });

  const result = await runOrchestrateSecondOpinion(
    {
      taskId: 'FORGE-1',
      diffPath,
      promptPath,
      forgeDir,
      json: true,
    },
    { factory },
  );

  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error?.code, 'REVIEW_FAILED');
  assert.ok(env.error?.message.includes('unexpected crash'));
});
