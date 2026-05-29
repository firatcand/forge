import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveTrackerForCLI,
  createTracker,
  NoopTracker,
} from '../../../../src/cli/orchestrate/tracker-factory.ts';
import { SettingsSchema, type TrackerConfig } from '../../../../src/schemas/settings.ts';
import { LinearTracker } from '../../../../src/trackers/linear.ts';
import { GitHubTracker } from '../../../../src/trackers/github.ts';
import type { Logger } from '../../../../src/trackers/base.ts';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function settingsFor(tracker: TrackerConfig) {
  return SettingsSchema.parse({
    version: 1,
    project: { name: 'test' },
    tracker,
    secrets: { manager: 'env_file' },
  });
}

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

// ─── createTracker (lifted from reconcile.ts, FORGE-167) ─────────────────────

test('createTracker: linear config → LinearTracker, no close', () => {
  const handle = createTracker(
    settingsFor({ type: 'linear', config: { team_id: 'team-1' } }),
    silentLogger,
  );
  assert.ok(handle.tracker instanceof LinearTracker);
  assert.equal(handle.tracker.type, 'linear');
  assert.equal(handle.close, undefined, 'linear needs no teardown');
});

test('createTracker: github config → GitHubTracker, no close', () => {
  const handle = createTracker(
    settingsFor({ type: 'github', config: { repo: 'firatcand/forge' } }),
    silentLogger,
  );
  assert.ok(handle.tracker instanceof GitHubTracker);
  assert.equal(handle.tracker.type, 'github');
  assert.equal(handle.close, undefined, 'github needs no teardown');
});

test('createTracker: notion config → tracker + close handle (lazy, not spawned)', () => {
  // createStdioMcpCall is lazy — constructing the handle does NOT spawn the MCP
  // child, so this is safe in a unit test. We assert the close hook exists
  // without invoking it.
  const handle = createTracker(
    settingsFor({
      type: 'notion',
      config: {
        database_id: 'db-1',
        mcp_command: ['npx', '-y', '@notionhq/notion-mcp-server'],
        mcp_env: {},
      },
    }),
    silentLogger,
  );
  assert.equal(handle.tracker.type, 'notion');
  assert.equal(typeof handle.close, 'function', 'notion must expose a close hook');
});

// ─── resolveTrackerForCLI un-stub (FORGE-167) ────────────────────────────────

test('resolveTrackerForCLI: valid github settings constructs a real adapter (no longer NO_TRACKER_CONFIGURED)', async (t) => {
  const original = process.env.FORGE_NOOP_TRACKER;
  delete process.env.FORGE_NOOP_TRACKER;
  t.after(() => {
    if (original !== undefined) process.env.FORGE_NOOP_TRACKER = original;
  });
  const dir = mkdtempSync(join(tmpdir(), 'forge-real-tracker-'));
  const forgeDir = join(dir, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: test',
      'tracker:',
      '  type: github',
      '  config:',
      '    repo: firatcand/forge',
      'secrets:',
      '  manager: env_file',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = resolveTrackerForCLI(forgeDir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.tracker.type, 'github');
    assert.equal(result.close, undefined);
  }
});
