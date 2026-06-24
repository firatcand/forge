// Integration smoke for ClaudeHarness.runReview.
//
// Gated by FORGE_E2E_CLAUDE=1 — skipped by default. Requires:
//   - `claude` CLI installed and on PATH
//   - active auth (Claude Code subscription / `claude` login)
//
// What this smoke proves over the mocked unit suite (FORGE-223 / Codex review
// M3): the mocked tests assert we *set* stdinPayload and the argv shape, but
// cannot prove the real `claude -p` binary actually (a) accepts the flag shape,
// (b) reads piped stdin alongside the argv prompt, and (c) returns without
// hanging on a permission prompt. This runs the real binary end-to-end. A
// sentinel embedded in the diff is echoed back via the prompt to confirm stdin
// content reached the model.
//
// Token cost: trivial review is ~10-20K tokens. Run manually with
// FORGE_E2E_CLAUDE=1 npm test or wire to a nightly job.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeHarness } from '../../../src/harnesses/claude.ts';

const E2E_ENABLED = process.env.FORGE_E2E_CLAUDE === '1';
const skipReason = E2E_ENABLED ? false : 'FORGE_E2E_CLAUDE!=1';

// 90 s budget: a trivial review should return in well under that. A stdin-hang
// (the failure mode this smoke exists to catch) would only return at timeoutMs.
const REVIEW_BUDGET_MS = 90_000;

test('integration: ClaudeHarness.runReview completes a trivial review without hanging', {
  skip: skipReason,
}, async () => {
  const h = new ClaudeHarness();
  const verdict = await h.runReview(
    '// no real diff — empty stub for the smoke',
    'Respond ONLY with a fenced ```json block: {"version":1,"verdict":"pass","findings":[],"host":"claude"}',
    {
      cwd: process.cwd(),
      taskId: 'FORGE-E2E-claude-review',
      attemptId: 'attempt-1',
      timeoutMs: REVIEW_BUDGET_MS,
    },
  );
  // Shape is enforced by the parser; host is always stamped 'claude' (fenced
  // verdict or synthesized fallback). We assert the call returned a verdict —
  // i.e. the real binary did not hang and the parse path held.
  assert.ok(verdict, 'runReview must return a parsed verdict');
  assert.equal(verdict.host, 'claude');
});

// Proves stdin content reaches the model alongside the argv prompt (Codex
// review M3: the "argv prompt + piped stdin are concatenated" assumption).
test('integration: ClaudeHarness.runReview feeds the stdin diff to the model', {
  skip: skipReason,
}, async () => {
  const sentinel = 'FORGE223_STDIN_SENTINEL_4711';
  const h = new ClaudeHarness();
  const verdict = await h.runReview(
    `diff --git a/x b/x\n+ ${sentinel}\n`,
    `Read the diff from stdin. Respond ONLY with a fenced \`\`\`json block matching {"version":1,"verdict":"changes_requested","findings":[{"severity":"improvement","path":"x","message":"<MSG>"}],"host":"claude"} where <MSG> is the exact sentinel token present in the stdin diff.`,
    {
      cwd: process.cwd(),
      taskId: 'FORGE-E2E-claude-stdin',
      attemptId: 'attempt-1',
      timeoutMs: REVIEW_BUDGET_MS,
    },
  );
  const sawSentinel = verdict.findings.some((f) => f.message.includes(sentinel));
  assert.ok(
    sawSentinel,
    `expected the stdin sentinel "${sentinel}" to surface in the verdict findings — proves piped stdin reached the model; got: ${JSON.stringify(verdict.findings)}`,
  );
});
