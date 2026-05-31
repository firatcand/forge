import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadForgeEnv, TRACKER_ENV_ALLOWLIST } from '../../../src/core/forge-env.ts';

function tmpRepo(envContent?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-env-'));
  if (envContent !== undefined) {
    mkdirSync(resolve(cwd, '.forge'), { recursive: true });
    writeFileSync(resolve(cwd, '.forge', '.env'), envContent, 'utf8');
  }
  return cwd;
}

// loadForgeEnv mutates the real process.env; snapshot + restore the keys each
// test touches so cases don't bleed into each other or the rest of the suite.
const TOUCHED = ['LINEAR_API_KEY', 'NOTION_TOKEN', 'NODE_OPTIONS', 'FORGE_NOOP_TRACKER'];
function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of TOUCHED) s[k] = process.env[k];
  return s;
}
function restore(s: Record<string, string | undefined>): void {
  for (const k of TOUCHED) {
    const v = s[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('loadForgeEnv seeds an allowlisted key from .forge/.env', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    const cwd = tmpRepo('LINEAR_API_KEY=lin_from_file\n');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.LINEAR_API_KEY, 'lin_from_file');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv ignores non-allowlisted keys (no control-var injection)', () => {
  const snap = snapshot();
  try {
    delete process.env.NODE_OPTIONS;
    delete process.env.FORGE_NOOP_TRACKER;
    delete process.env.LINEAR_API_KEY;
    const cwd = tmpRepo('NODE_OPTIONS=--inspect\nFORGE_NOOP_TRACKER=1\nLINEAR_API_KEY=ok\n');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must not be set from the file');
    assert.equal(process.env.FORGE_NOOP_TRACKER, undefined, 'FORGE_NOOP_TRACKER must not be set from the file');
    assert.equal(process.env.LINEAR_API_KEY, 'ok', 'allowlisted key still loads');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv does not override an already-set var', () => {
  const snap = snapshot();
  try {
    process.env.LINEAR_API_KEY = 'from_shell';
    const cwd = tmpRepo('LINEAR_API_KEY=from_file\n');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.LINEAR_API_KEY, 'from_shell', 'shell/CI value wins over .forge/.env');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv is a silent no-op when .forge/.env is absent', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    const cwd = tmpRepo(); // no .forge/.env written
    let warned = false;
    loadForgeEnv(cwd, () => {
      warned = true;
    });
    assert.equal(warned, false, 'absent file must not warn');
    assert.equal(process.env.LINEAR_API_KEY, undefined);
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv warns and skips on a malformed .forge/.env (no throw, sets nothing)', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    const cwd = tmpRepo('this line has no equals sign\n');
    const warnings: string[] = [];
    assert.doesNotThrow(() => loadForgeEnv(cwd, (m) => warnings.push(m)));
    assert.equal(warnings.length, 1, 'exactly one warning');
    assert.match(warnings[0], /malformed \.forge\/\.env/);
    assert.equal(process.env.LINEAR_API_KEY, undefined, 'nothing loaded from a malformed file');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv warns (not throws) when .forge/.env is unreadable (non-ENOENT)', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    // .forge/.env is a *directory* → readFileSync throws EISDIR, not ENOENT.
    const cwd = mkdtempSync(join(tmpdir(), 'forge-env-'));
    mkdirSync(resolve(cwd, '.forge', '.env'), { recursive: true });
    const warnings: string[] = [];
    assert.doesNotThrow(() => loadForgeEnv(cwd, (m) => warnings.push(m)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not read/);
    assert.equal(process.env.LINEAR_API_KEY, undefined);
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv loads allowlisted keys from a JSON .forge/.env and still filters', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    delete process.env.NODE_OPTIONS;
    const cwd = tmpRepo('{"LINEAR_API_KEY":"json_val","NODE_OPTIONS":"--inspect"}');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.LINEAR_API_KEY, 'json_val');
    assert.equal(process.env.NODE_OPTIONS, undefined, 'non-allowlisted key ignored in JSON form too');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv treats an empty-string env var as set (no-override preserves it)', () => {
  const snap = snapshot();
  try {
    process.env.LINEAR_API_KEY = '';
    const cwd = tmpRepo('LINEAR_API_KEY=from_file\n');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.LINEAR_API_KEY, '', 'an explicitly empty var is still "set" and wins');
  } finally {
    restore(snap);
  }
});

test('loadForgeEnv applies last-wins for a duplicated allowlisted key', () => {
  const snap = snapshot();
  try {
    delete process.env.LINEAR_API_KEY;
    const cwd = tmpRepo('LINEAR_API_KEY=first\nLINEAR_API_KEY=second\n');
    loadForgeEnv(cwd, () => {});
    assert.equal(process.env.LINEAR_API_KEY, 'second');
  } finally {
    restore(snap);
  }
});

test('TRACKER_ENV_ALLOWLIST covers the known tracker auth keys', () => {
  for (const k of ['LINEAR_API_KEY', 'NOTION_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'FORGE_NOTION_PARENT_PAGE_ID']) {
    assert.ok(TRACKER_ENV_ALLOWLIST.includes(k), `allowlist should include ${k}`);
  }
});
