import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAvailability,
  type AvailabilityDeps,
} from '../../../src/orchestrator/availability.ts';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';
import type { Host } from '../../../src/schemas/hosts.ts';

// ── exec fakes — NEVER a real binary ────────────────────────────────────────
// An exec that reports given bins as present (exitCode 0) and everything else as
// ENOENT (exitCode undefined + code 'ENOENT'), mirroring execa@9 reject:false.
function execWithBins(present: readonly string[]): ExecaLike {
  return (async (cmd: string) => {
    if (present.includes(cmd)) {
      return { exitCode: 0, stdout: `${cmd} 1.0.0`, stderr: '' };
    }
    return { exitCode: undefined, stdout: '', stderr: '', code: 'ENOENT' };
  }) as unknown as ExecaLike;
}

// exec that asserts it is NEVER called (used to prove claude is not probed).
function execNeverCalled(): ExecaLike {
  return (async (cmd: string) => {
    throw new Error(`exec must not be called, got: ${cmd}`);
  }) as unknown as ExecaLike;
}

function envFrom(map: Record<string, string | undefined>): (n: string) => string | undefined {
  return (n: string) => map[n];
}

function baseDeps(over: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
  return {
    exec: execWithBins(['codex', 'gemini', 'agent']),
    getEnv: envFrom({}),
    fileExists: () => false,
    homeDir: '/home/test',
    betaOptIn: false,
    timeoutMs: 100,
    ...over,
  };
}

const ALL: readonly Host[] = ['claude', 'codex', 'gemini', 'cursor'];

// ── claude ──────────────────────────────────────────────────────────────────

test('claude available when CLAUDE_CODE set — and claude CLI is NOT probed', async () => {
  const set = await computeAvailability(['claude'], baseDeps({
    exec: execNeverCalled(),
    getEnv: envFrom({ CLAUDE_CODE: '1' }),
  }));
  assert.equal(set.claude.available, true);
  assert.deepEqual(set.claude.reasons, []);
});

test('claude unavailable when CLAUDE_CODE unset (no CLI probe)', async () => {
  const set = await computeAvailability(['claude'], baseDeps({
    exec: execNeverCalled(),
    getEnv: envFrom({}),
  }));
  assert.equal(set.claude.available, false);
  assert.deepEqual(set.claude.reasons, ['not in a Claude Code session (CLAUDE_CODE unset)']);
});

// ── codex ─────────────────────────────────────────────────────────────────

test('codex available when codex bin present AND ~/.codex/auth.json exists', async () => {
  const set = await computeAvailability(['codex'], baseDeps({
    exec: execWithBins(['codex']),
    fileExists: (p) => p === '/home/test/.codex/auth.json',
  }));
  assert.equal(set.codex.available, true);
  assert.deepEqual(set.codex.reasons, []);
});

test('codex unavailable when bin absent', async () => {
  const set = await computeAvailability(['codex'], baseDeps({
    exec: execWithBins([]),
    fileExists: (p) => p === '/home/test/.codex/auth.json',
  }));
  assert.equal(set.codex.available, false);
  assert.ok(set.codex.reasons.includes('codex CLI not found'));
});

test('codex unavailable when auth file missing — and OPENAI_API_KEY does NOT help', async () => {
  const set = await computeAvailability(['codex'], baseDeps({
    exec: execWithBins(['codex']),
    fileExists: () => false,
    getEnv: envFrom({ OPENAI_API_KEY: 'sk-xxx' }),
  }));
  assert.equal(set.codex.available, false);
  assert.deepEqual(set.codex.reasons, ['no codex auth (~/.codex/auth.json)']);
});

test('codex reasons accumulate when bin absent AND auth missing', async () => {
  const set = await computeAvailability(['codex'], baseDeps({
    exec: execWithBins([]),
    fileExists: () => false,
  }));
  assert.equal(set.codex.available, false);
  assert.deepEqual(set.codex.reasons, ['codex CLI not found', 'no codex auth (~/.codex/auth.json)']);
});

test('codex auth path is built from injected homeDir, never a literal ~', async () => {
  let checkedPath = '';
  const set = await computeAvailability(['codex'], baseDeps({
    exec: execWithBins(['codex']),
    homeDir: '/custom/home',
    fileExists: (p) => {
      checkedPath = p;
      return true;
    },
  }));
  assert.equal(set.codex.available, true);
  assert.equal(checkedPath, '/custom/home/.codex/auth.json');
});

// ── gemini ────────────────────────────────────────────────────────────────

test('gemini available when bin present AND FORGE_GEMINI_EXPERIMENTAL=1', async () => {
  const set = await computeAvailability(['gemini'], baseDeps({
    exec: execWithBins(['gemini']),
    getEnv: envFrom({ FORGE_GEMINI_EXPERIMENTAL: '1' }),
  }));
  assert.equal(set.gemini.available, true);
  assert.deepEqual(set.gemini.reasons, []);
});

test('gemini unavailable when experimental gate closed', async () => {
  const set = await computeAvailability(['gemini'], baseDeps({
    exec: execWithBins(['gemini']),
    getEnv: envFrom({}),
  }));
  assert.equal(set.gemini.available, false);
  assert.deepEqual(set.gemini.reasons, [
    'gemini experimental gate closed (FORGE_GEMINI_EXPERIMENTAL=1)',
  ]);
});

test('gemini reasons accumulate when bin absent and gate closed', async () => {
  const set = await computeAvailability(['gemini'], baseDeps({
    exec: execWithBins([]),
    getEnv: envFrom({}),
  }));
  assert.equal(set.gemini.available, false);
  assert.deepEqual(set.gemini.reasons, [
    'gemini CLI not found',
    'gemini experimental gate closed (FORGE_GEMINI_EXPERIMENTAL=1)',
  ]);
});

// ── cursor ────────────────────────────────────────────────────────────────

test('cursor available when betaOptIn AND agent bin present AND CURSOR_API_KEY set', async () => {
  const set = await computeAvailability(['cursor'], baseDeps({
    betaOptIn: true,
    exec: execWithBins(['agent']),
    getEnv: envFrom({ CURSOR_API_KEY: 'k' }),
  }));
  assert.equal(set.cursor.available, true);
  assert.deepEqual(set.cursor.reasons, []);
});

test('cursor unavailable when beta gate closed (not an error)', async () => {
  const set = await computeAvailability(['cursor'], baseDeps({
    betaOptIn: false,
    exec: execWithBins(['agent']),
    getEnv: envFrom({ CURSOR_API_KEY: 'k' }),
  }));
  assert.equal(set.cursor.available, false);
  assert.deepEqual(set.cursor.reasons, ['beta gate closed (agents.cursor_host_beta_opt_in)']);
});

test('cursor reasons accumulate: beta closed + bin absent + key unset', async () => {
  const set = await computeAvailability(['cursor'], baseDeps({
    betaOptIn: false,
    exec: execWithBins([]),
    getEnv: envFrom({}),
  }));
  assert.equal(set.cursor.available, false);
  assert.deepEqual(set.cursor.reasons, [
    'beta gate closed (agents.cursor_host_beta_opt_in)',
    'agent CLI not found',
    'CURSOR_API_KEY unset',
  ]);
});

test('cursor unavailable when CURSOR_API_KEY is empty string', async () => {
  const set = await computeAvailability(['cursor'], baseDeps({
    betaOptIn: true,
    exec: execWithBins(['agent']),
    getEnv: envFrom({ CURSOR_API_KEY: '' }),
  }));
  assert.equal(set.cursor.available, false);
  assert.deepEqual(set.cursor.reasons, ['CURSOR_API_KEY unset']);
});

// ── full set ──────────────────────────────────────────────────────────────

test('computeAvailability returns an entry for every requested host', async () => {
  const set = await computeAvailability(ALL, baseDeps({
    exec: execWithBins(['codex', 'gemini', 'agent']),
    getEnv: envFrom({}),
    fileExists: () => false,
  }));
  assert.deepEqual(Object.keys(set).sort(), [...ALL].sort());
  // None configured → all unavailable, none errored.
  for (const h of ALL) assert.equal(set[h].available, false);
});
