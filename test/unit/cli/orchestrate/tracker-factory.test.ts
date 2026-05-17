import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveTrackerForCLI,
  NoopTracker,
} from '../../../../src/cli/orchestrate/tracker-factory.ts';

function captureStderr(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = orig;
  });
  return buf;
}

test('resolveTrackerForCLI: FORGE_NOOP_TRACKER=1 takes priority, no warning', async (t) => {
  const stderr = captureStderr(t);
  const original = process.env.FORGE_NOOP_TRACKER;
  process.env.FORGE_NOOP_TRACKER = '1';
  t.after(() => {
    if (original === undefined) delete process.env.FORGE_NOOP_TRACKER;
    else process.env.FORGE_NOOP_TRACKER = original;
  });
  const result = resolveTrackerForCLI('/nonexistent/.forge');
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.tracker instanceof NoopTracker);
  assert.equal(stderr.join(''), '', 'no warning when FORGE_NOOP_TRACKER=1');
});

test('resolveTrackerForCLI: missing settings.yaml warns to stderr (Codex 2nd-pass)', async (t) => {
  // Make sure FORGE_NOOP_TRACKER is unset for this test.
  const original = process.env.FORGE_NOOP_TRACKER;
  delete process.env.FORGE_NOOP_TRACKER;
  t.after(() => {
    if (original !== undefined) process.env.FORGE_NOOP_TRACKER = original;
  });
  const stderr = captureStderr(t);
  const dir = mkdtempSync(join(tmpdir(), 'forge-noop-warn-'));
  const result = resolveTrackerForCLI(join(dir, '.forge'));
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.tracker instanceof NoopTracker);
  const combined = stderr.join('');
  assert.match(combined, /NoopTracker/);
  assert.match(combined, /settings\.yaml/);
});

test('resolveTrackerForCLI: malformed settings.yaml surfaces TRACKER_INIT_FAILED', async (t) => {
  const original = process.env.FORGE_NOOP_TRACKER;
  delete process.env.FORGE_NOOP_TRACKER;
  t.after(() => {
    if (original !== undefined) process.env.FORGE_NOOP_TRACKER = original;
  });
  const dir = mkdtempSync(join(tmpdir(), 'forge-bad-tracker-'));
  const forgeDir = join(dir, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  // Settings file exists but doesn't validate. Factory takes the non-noop branch.
  writeFileSync(join(forgeDir, 'settings.yaml'), '{not valid yaml: [\n', 'utf8');
  const result = resolveTrackerForCLI(forgeDir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TRACKER_INIT_FAILED');
});
