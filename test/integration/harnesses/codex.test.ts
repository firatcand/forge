// Integration smoke for CodexHarness.
//
// Gated by FORGE_E2E_CODEX=1 — skipped by default. Requires:
//   - `codex` CLI installed and on PATH
//   - active auth (`codex login` or equivalent)
//
// What this smoke proves over the mocked conformance suite:
//   - the binary name + flag shape actually match the installed CLI
//   - our subprocess wrapper handles real codex stdout/stderr
//   - healthCheck round-trips a real version string
//   - dispatchSubagent + runReview actually complete against the real binary
//     (FORGE-135: caught a regression where codex 0.130.0 hangs on stdin
//     read; the mocked conformance suite missed it because the mock never
//     blocked. Real-CLI dispatch must stay in this file.)
//
// Token cost: trivial-prompt dispatch is ~15-20K tokens (~$0.02-0.05). Run
// manually with FORGE_E2E_CODEX=1 npm test or wire to a nightly job.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexHarness } from '../../../src/harnesses/codex.ts';

// Real-CLI dispatch must run from a trusted git repo (codex 0.130.0 enforces
// a "trusted directory" check at startup). The repo root / worktree path is
// trusted in the developer's codex config; tmpdir() is not. Tests assume
// they're invoked from a forge worktree — same precondition as production
// dispatch.

const E2E_ENABLED = process.env.FORGE_E2E_CODEX === '1';
const skipReason = E2E_ENABLED ? false : 'FORGE_E2E_CODEX!=1';

// 60 s is conservative: the trivial-prompt baseline measured 5-12 s on the
// machine that reproduced FORGE-135. A 60 s budget catches a stdin-hang
// (which would only return at timeoutMs) without producing flakes from
// occasional cold-start latency.
const DISPATCH_BUDGET_MS = 60_000;

test('integration: CodexHarness.healthCheck returns ok against real codex CLI', {
  skip: skipReason,
}, async () => {
  const h = new CodexHarness();
  const r = await h.healthCheck();
  assert.equal(r.ok, true, `expected ok=true; got: ${JSON.stringify(r)}`);
  assert.ok(r.version && r.version.length > 0, 'version must be a non-empty string');
});

test('integration: CodexHarness.detectVersion returns non-empty version', {
  skip: skipReason,
}, async () => {
  const h = new CodexHarness();
  const v = await h.detectVersion();
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
});

// FORGE-135 regression guard. Would have caught the codex-0.130.0 stdin-hang
// at PR-review time. Asserts a real dispatchSubagent call completes (i.e. the
// subprocess does not hang on stdin) and reports a 'completed' verdict.
test('integration: CodexHarness.dispatchSubagent completes a trivial prompt without hanging', {
  skip: skipReason,
}, async () => {
  const h = new CodexHarness();
  const handle = await h.dispatchSubagent('Say only the literal word OK and nothing else.', {
    cwd: process.cwd(),
    taskId: 'FORGE-E2E-codex-dispatch',
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

// Symmetric guard for runReview. Same code path through spawnSubprocess; would
// also hang without FORGE-135's stdin: 'ignore' fix.
test('integration: CodexHarness.runReview completes a trivial review without hanging', {
  skip: skipReason,
}, async () => {
  const h = new CodexHarness();
  const verdict = await h.runReview(
    '// no real diff — empty stub for the smoke',
    'Respond only with the literal word OK.',
    {
      cwd: process.cwd(),
      taskId: 'FORGE-E2E-codex-review',
      attemptId: 'attempt-1',
      timeoutMs: DISPATCH_BUDGET_MS,
    },
  );
  // The verdict shape is enforced by the parser; we just assert the call returned.
  assert.ok(verdict, 'runReview must return a parsed verdict');
});
