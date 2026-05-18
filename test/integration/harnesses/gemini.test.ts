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
//
// We do NOT run a full dispatch here — costs tokens. The mocked conformance
// suite covers the dispatch lifecycle.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiHarness } from '../../../src/harnesses/gemini.ts';

const E2E_ENABLED = process.env.FORGE_E2E_GEMINI === '1';
const GATE_OPEN = process.env.FORGE_GEMINI_EXPERIMENTAL === '1';

const skipReason = !E2E_ENABLED
  ? 'FORGE_E2E_GEMINI!=1'
  : !GATE_OPEN
    ? 'FORGE_GEMINI_EXPERIMENTAL!=1 (required for any GeminiHarness use)'
    : false;

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
