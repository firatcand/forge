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
//
// We do NOT run a full dispatch here — that would spend tokens on every CI
// run. The conformance suite (test/unit/harnesses/conformance.test.ts)
// covers the dispatch lifecycle with a DI-injected stub.
//
// See test/integration/README.md for setup.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexHarness } from '../../../src/harnesses/codex.ts';

const E2E_ENABLED = process.env.FORGE_E2E_CODEX === '1';
const skipReason = E2E_ENABLED ? false : 'FORGE_E2E_CODEX!=1';

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
