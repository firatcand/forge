// Integration smoke for GeminiHarness.
//
// Gated by FORGE_E2E_GEMINI=1 AND FORGE_GEMINI_EXPERIMENTAL=1 — skipped by
// default. Requires:
//   - `gemini` on PATH OR `npx @google/gemini-cli` resolvable
//   - active auth (gemini-cli login)
//
// What this smoke proves over the mocked conformance suite:
//   - binary auto-detection (gemini → npx fallback) works against real
//     install layouts
//   - the `-p` / `--approval-mode=yolo` flag shape matches the installed CLI
//   - our subprocess wrapper handles real gemini stdout/stderr
//   - healthCheck round-trips a real version string
//   - dispatchSubagent + runReview actually complete against the real binary
//     (FORGE-135 symmetric guard: codex 0.130.0 hung on stdin; gemini's
//     stdin behaviour is unverified across versions, so we apply the same
//     real-CLI dispatch assertion to catch any regression there too.)
//
// Token cost: ~10-20K tokens per dispatch (~$0.01-0.05). Run manually.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiHarness } from '../../../src/harnesses/gemini.ts';

// Real-CLI dispatch is invoked from process.cwd() (the worktree) for parity
// with the codex symmetric test — gemini doesn't enforce a "trusted dir"
// gate today, but if a future version does, this test stays correct.

const E2E_ENABLED = process.env.FORGE_E2E_GEMINI === '1';
const GATE_OPEN = process.env.FORGE_GEMINI_EXPERIMENTAL === '1';

const skipReason = !E2E_ENABLED
  ? 'FORGE_E2E_GEMINI!=1'
  : !GATE_OPEN
    ? 'FORGE_GEMINI_EXPERIMENTAL!=1 (required for any GeminiHarness use)'
    : false;

const DISPATCH_BUDGET_MS = 60_000;

test('integration: GeminiHarness.healthCheck returns ok against real gemini CLI', {
  skip: skipReason,
}, async () => {
  const h = new GeminiHarness();
  const r = await h.healthCheck();
  assert.equal(r.ok, true, `expected ok=true; got: ${JSON.stringify(r)}`);
  assert.ok(r.version && r.version.length > 0, 'version must be a non-empty string');
});

test('integration: GeminiHarness.detectVersion returns non-empty version', {
  skip: skipReason,
}, async () => {
  const h = new GeminiHarness();
  const v = await h.detectVersion();
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
});

// FORGE-135 symmetric regression guard for gemini.
test('integration: GeminiHarness.dispatchSubagent completes a trivial prompt without hanging', {
  skip: skipReason,
}, async () => {
  const h = new GeminiHarness();
  const handle = await h.dispatchSubagent('Say only the literal word OK and nothing else.', {
    cwd: process.cwd(),
    taskId: 'FORGE-E2E-gemini-dispatch',
    attemptId: 'attempt-1',
    timeoutMs: DISPATCH_BUDGET_MS,
  });
  const result = await handle.wait();
  assert.equal(
    result.verdict,
    'completed',
    `expected completed; got ${result.verdict} (exit=${result.exitCode}, duration=${result.durationMs}ms)`,
  );
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.durationMs < DISPATCH_BUDGET_MS,
    `dispatch must finish well under the timeout budget; took ${result.durationMs}ms`,
  );
});

test('integration: GeminiHarness.runReview completes a trivial review without hanging', {
  skip: skipReason,
}, async () => {
  const h = new GeminiHarness();
  const verdict = await h.runReview(
    '// no real diff — empty stub for the smoke',
    'Respond only with the literal word OK.',
    {
      cwd: process.cwd(),
      taskId: 'FORGE-E2E-gemini-review',
      attemptId: 'attempt-1',
      timeoutMs: DISPATCH_BUDGET_MS,
    },
  );
  assert.ok(verdict, 'runReview must return a parsed verdict');
});
