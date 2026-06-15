import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStatusLineConfig } from '../../../../src/cli/upgrade/host-config.ts';

/** A fake home dir — NEVER the real os.homedir(). All tests inject this. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'forge-hostcfg-home-'));
}

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(home), 'utf8')) as Record<string, unknown>;
}

function writeSettings(home: string, contents: string): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settingsPath(home), contents, 'utf8');
}

const EXPECTED_STATUS_LINE = { type: 'command', command: 'forge statusline' };

test('host-config: absent settings.json → writes statusLine', () => {
  const home = fakeHome();
  try {
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    assert.ok(existsSync(settingsPath(home)));
    assert.deepEqual(readSettings(home).statusLine, EXPECTED_STATUS_LINE);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: existing OTHER keys are deep-merged (preserved)', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify({ theme: 'dark', permissions: { allow: ['x'] } }));
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    const s = readSettings(home);
    assert.equal(s.theme, 'dark');
    assert.deepEqual(s.permissions, { allow: ['x'] });
    assert.deepEqual(s.statusLine, EXPECTED_STATUS_LINE);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: existing statusLine → skipped, not overwritten (non-clobber)', () => {
  const home = fakeHome();
  try {
    const custom = { type: 'command', command: 'my-own-statusline' };
    writeSettings(home, JSON.stringify({ statusLine: custom, theme: 'light' }));
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    const s = readSettings(home);
    assert.deepEqual(s.statusLine, custom);
    assert.equal(s.theme, 'light');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: corrupt JSON → skipped, file not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, '{ this is not json');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    // The original content survives untouched.
    assert.equal(readFileSync(settingsPath(home), 'utf8'), '{ this is not json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: R1 non-object JSON (array) → skipped, not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify([1, 2, 3]));
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(home), 'utf8')), [1, 2, 3]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: R1 non-object JSON (null) → skipped, not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, 'null');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.equal(readFileSync(settingsPath(home), 'utf8'), 'null');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: R1 non-object JSON (string) → skipped, not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, '"hello"');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.equal(readFileSync(settingsPath(home), 'utf8'), '"hello"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: empty file → treated as {} and writes statusLine', () => {
  const home = fakeHome();
  try {
    writeSettings(home, '   \n  ');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    assert.deepEqual(readSettings(home).statusLine, EXPECTED_STATUS_LINE);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: idempotent — second run is skipped (already present)', () => {
  const home = fakeHome();
  try {
    const first = writeStatusLineConfig({ homeDir: home });
    assert.equal(first.outcome, 'written');
    const second = writeStatusLineConfig({ homeDir: home });
    assert.equal(second.outcome, 'skipped');
    assert.deepEqual(readSettings(home).statusLine, EXPECTED_STATUS_LINE);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: dryRun → no write, returns dry-run', () => {
  const home = fakeHome();
  try {
    const res = writeStatusLineConfig({ homeDir: home, dryRun: true });
    assert.equal(res.outcome, 'dry-run');
    assert.ok(!existsSync(settingsPath(home)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config: R2 symlinked .claude DIR → skipped, nothing written through', () => {
  const home = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), 'forge-hostcfg-outside-'));
  try {
    // .claude is a symlink to an OUTSIDE dir. Writing through it would escape home.
    symlinkSync(outside, join(home, '.claude'), 'dir');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    // Nothing was written into the symlink target.
    assert.ok(!existsSync(join(outside, 'settings.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('host-config: R2 symlinked settings.json LEAF → skipped, target untouched', () => {
  const home = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), 'forge-hostcfg-outside-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const target = join(outside, 'real-settings.json');
    writeFileSync(target, JSON.stringify({ theme: 'dark' }), 'utf8');
    symlinkSync(target, settingsPath(home), 'file');
    const res = writeStatusLineConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    // The symlink target is unchanged — no statusLine written through.
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { theme: 'dark' });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// FORGE-209 (B1): isSymlinkAt now fails closed (throws on non-ENOENT). The
// statusLine writer documents a NEVER-THROW skip contract, so a guard throw on
// its symlink-check path must DEGRADE to a `skipped` result, never propagate and
// abort the upgrade. Deterministic ENOTDIR fixture: make `.claude` a regular
// FILE so the leaf isSymlinkAt(.claude/settings.json) lstat fails ENOTDIR.
test('host-config: a guard error (ENOTDIR) is caught → skipped, never throws (B1 never-throw)', () => {
  const home = fakeHome();
  try {
    // `.claude` is a regular file, not a dir → lstat(.claude/settings.json) ENOTDIR.
    writeFileSync(join(home, '.claude'), 'not a directory', 'utf8');
    let res: ReturnType<typeof writeStatusLineConfig> | undefined;
    assert.doesNotThrow(() => {
      res = writeStatusLineConfig({ homeDir: home });
    }, 'writeStatusLineConfig must never throw on its expected-skip paths');
    assert.equal(res?.outcome, 'skipped');
    assert.match(res!.notice, /could not verify|symlink/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
