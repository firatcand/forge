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
import {
  TRIPWIRE_HOOK_COMMANDS,
  removeTripwireHookConfig,
  writeTripwireHookConfig,
} from '../../../../src/cli/upgrade/host-config.ts';

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'forge-twcfg-home-'));
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

function postToolUse(home: string): unknown[] {
  const hooks = readSettings(home).hooks as Record<string, unknown> | undefined;
  return (hooks?.PostToolUse as unknown[]) ?? [];
}

function tripwireEntries(home: string): unknown[] {
  return postToolUse(home).filter((e) => {
    const nested = (e as { hooks?: unknown }).hooks;
    if (!Array.isArray(nested)) return false;
    return nested.some(
      (h) => typeof (h as { command?: unknown }).command === 'string' && TRIPWIRE_HOOK_COMMANDS.includes((h as { command: string }).command),
    );
  });
}

test('host-config tripwire: absent settings.json → writes the PostToolUse entry', () => {
  const home = fakeHome();
  try {
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    assert.equal(tripwireEntries(home).length, 1);
    const entry = postToolUse(home)[0] as { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> };
    assert.equal(entry.matcher, 'WebFetch|WebSearch|mcp__.*');
    assert.deepEqual(entry.hooks[0], { type: 'command', command: 'forge tripwire-hook', timeout: 10 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: idempotent — second run does not duplicate', () => {
  const home = fakeHome();
  try {
    const first = writeTripwireHookConfig({ homeDir: home });
    assert.equal(first.outcome, 'written');
    const second = writeTripwireHookConfig({ homeDir: home });
    assert.equal(second.outcome, 'skipped');
    assert.equal(tripwireEntries(home).length, 1);
    assert.equal(postToolUse(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: preserves existing user PostToolUse + other hooks', () => {
  const home = fakeHome();
  try {
    writeSettings(
      home,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'user-pre' }] }],
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] }],
        },
      }),
    );
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    const s = readSettings(home);
    assert.equal(s.theme, 'dark');
    const hooks = s.hooks as Record<string, unknown>;
    assert.deepEqual(hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: 'user-pre' }] }]);
    const post = hooks.PostToolUse as unknown[];
    assert.equal(post.length, 2);
    assert.deepEqual(post[0], { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] });
    assert.equal(tripwireEntries(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: user kept our command under a custom matcher → idempotent skip (preserve edit)', () => {
  const home = fakeHome();
  try {
    writeSettings(
      home,
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: 'mcp__custom', hooks: [{ type: 'command', command: 'forge tripwire-hook', timeout: 30 }] }] },
      }),
    );
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    const entry = postToolUse(home)[0] as { matcher: string; hooks: Array<{ timeout: number }> };
    assert.equal(entry.matcher, 'mcp__custom');
    assert.equal(entry.hooks[0].timeout, 30);
    assert.equal(postToolUse(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: SKIP-not-clobber when hooks is not an object', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify({ hooks: 'oops' }));
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.equal(readSettings(home).hooks, 'oops');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: SKIP-not-clobber when hooks.PostToolUse is not an array', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify({ hooks: { PostToolUse: { not: 'an array' } } }));
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.deepEqual((readSettings(home).hooks as Record<string, unknown>).PostToolUse, { not: 'an array' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: corrupt JSON → skipped, file not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, '{ not json');
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.equal(readFileSync(settingsPath(home), 'utf8'), '{ not json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: non-object JSON (array) → skipped, not clobbered', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify([1, 2]));
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(home), 'utf8')), [1, 2]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: dryRun → no write, returns dry-run', () => {
  const home = fakeHome();
  try {
    const res = writeTripwireHookConfig({ homeDir: home, dryRun: true });
    assert.equal(res.outcome, 'dry-run');
    assert.ok(!existsSync(settingsPath(home)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire: symlinked .claude DIR → skipped, nothing written through', () => {
  const home = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), 'forge-twcfg-outside-'));
  try {
    symlinkSync(outside, join(home, '.claude'), 'dir');
    const res = writeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.ok(!existsSync(join(outside, 'settings.json')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('host-config tripwire: guard error (ENOTDIR) caught → skipped, never throws', () => {
  const home = fakeHome();
  try {
    writeFileSync(join(home, '.claude'), 'not a dir', 'utf8');
    let res: ReturnType<typeof writeTripwireHookConfig> | undefined;
    assert.doesNotThrow(() => {
      res = writeTripwireHookConfig({ homeDir: home });
    });
    assert.equal(res?.outcome, 'skipped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── removeTripwireHookConfig ────────────────────────────────────────────────

test('host-config tripwire remove: removes only our entry, preserves siblings', () => {
  const home = fakeHome();
  try {
    writeSettings(
      home,
      JSON.stringify({
        theme: 'x',
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'user-pre' }] }],
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] },
            { matcher: 'WebFetch|WebSearch|mcp__.*', hooks: [{ type: 'command', command: 'forge tripwire-hook', timeout: 10 }] },
          ],
        },
      }),
    );
    const res = removeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    const hooks = readSettings(home).hooks as Record<string, unknown>;
    assert.deepEqual(hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: 'user-pre' }] }]);
    const post = hooks.PostToolUse as unknown[];
    assert.equal(post.length, 1);
    assert.deepEqual(post[0], { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] });
    assert.equal(tripwireEntries(home).length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire remove: drops now-empty PostToolUse and hooks cleanly', () => {
  const home = fakeHome();
  try {
    writeTripwireHookConfig({ homeDir: home });
    const res = removeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    assert.ok(!Object.prototype.hasOwnProperty.call(readSettings(home), 'hooks'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire remove: nothing ours present → skipped, untouched', () => {
  const home = fakeHome();
  try {
    writeSettings(home, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-post' }] }] } }));
    const res = removeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
    assert.equal(postToolUse(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire remove: absent settings.json → skipped', () => {
  const home = fakeHome();
  try {
    const res = removeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'skipped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host-config tripwire remove: shared entry keeps the user hook, removes ours', () => {
  const home = fakeHome();
  try {
    writeSettings(
      home,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'm', hooks: [{ type: 'command', command: 'forge tripwire-hook' }, { type: 'command', command: 'user-other' }] },
          ],
        },
      }),
    );
    const res = removeTripwireHookConfig({ homeDir: home });
    assert.equal(res.outcome, 'written');
    const post = postToolUse(home);
    assert.equal(post.length, 1);
    const entry = post[0] as { hooks: Array<{ command: string }> };
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].command, 'user-other');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
