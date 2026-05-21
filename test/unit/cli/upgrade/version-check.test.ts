import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVersionDrift,
  formatDriftWarning,
  compareVersions,
  formatCliTooOldRefusal,
} from '../../../../src/cli/upgrade/version-check.ts';

function bootstrap(version?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-vc-'));
  if (version !== undefined) {
    mkdirSync(join(cwd, '.forge'));
    writeFileSync(join(cwd, '.forge/.version'), `${version}\n`);
  }
  return cwd;
}

test('checkVersionDrift: returns null when versions match', () => {
  const cwd = bootstrap('0.5.0');
  try {
    assert.equal(checkVersionDrift({ cwd, currentVersion: '0.5.0' }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkVersionDrift: returns drift info when versions differ', () => {
  const cwd = bootstrap('0.5.0');
  try {
    assert.deepEqual(checkVersionDrift({ cwd, currentVersion: '0.5.4' }), {
      onDisk: '0.5.0',
      current: '0.5.4',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkVersionDrift: returns null when .version file is missing', () => {
  const cwd = bootstrap();
  try {
    assert.equal(checkVersionDrift({ cwd, currentVersion: '0.5.0' }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkVersionDrift: trims surrounding whitespace from on-disk version', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-vc-'));
  try {
    mkdirSync(join(cwd, '.forge'));
    writeFileSync(join(cwd, '.forge/.version'), '   0.5.0\n\n');
    assert.equal(checkVersionDrift({ cwd, currentVersion: '0.5.0' }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('formatDriftWarning: produces a single-line stderr message with both versions and remedy', () => {
  const msg = formatDriftWarning({ onDisk: '0.5.0', current: '0.5.4' });
  assert.match(msg, /v0\.5\.0/);
  assert.match(msg, /v0\.5\.4/);
  assert.match(msg, /forge upgrade/);
  assert.equal(msg.split('\n').length, 1, 'drift warning must be a single line');
});

test('compareVersions: directional cases', () => {
  assert.equal(compareVersions('0.5.0', '0.5.4'), 'older');
  assert.equal(compareVersions('0.5.4', '0.5.0'), 'newer');
  assert.equal(compareVersions('0.5.0', '0.5.0'), 'match');
});

test('compareVersions: major and minor precedence', () => {
  assert.equal(compareVersions('1.0.0', '0.99.99'), 'newer');
  assert.equal(compareVersions('0.99.99', '1.0.0'), 'older');
  assert.equal(compareVersions('0.6.0', '0.5.99'), 'newer');
  assert.equal(compareVersions('0.5.99', '0.6.0'), 'older');
});

test('compareVersions: throws on invalid semver', () => {
  assert.throws(() => compareVersions('0.5', '0.5.0'), /invalid semver/);
  assert.throws(() => compareVersions('0.5.0', '0.5'), /invalid semver/);
  assert.throws(() => compareVersions('0.5.0-beta', '0.5.0'), /invalid semver/);
  assert.throws(() => compareVersions('abc', '0.5.0'), /invalid semver/);
  assert.throws(() => compareVersions('', '0.5.0'), /invalid semver/);
});

test('formatCliTooOldRefusal: names both versions, calls out DOWNGRADE, recommends npm install', () => {
  const msg = formatCliTooOldRefusal({ onDisk: '0.5.3', current: '0.5.1' });
  assert.match(msg, /v0\.5\.3/);
  assert.match(msg, /v0\.5\.1/);
  assert.match(msg, /DOWNGRADE/);
  assert.match(msg, /npm install -g/);
});
