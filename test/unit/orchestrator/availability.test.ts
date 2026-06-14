import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAvailability,
  resolveAvailableModel,
  type AvailabilityDeps,
  type AvailabilitySet,
} from '../../../src/orchestrator/availability.ts';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';
import type { CatalogHost, ModelsCatalog } from '../../../src/schemas/models-catalog.ts';

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

const ALL: readonly CatalogHost[] = ['claude', 'codex', 'gemini', 'cursor'];

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

// ── resolveAvailableModel (pure) ────────────────────────────────────────────

function catalog(): ModelsCatalog {
  return {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-sonnet-4', tier: 'standard', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-haiku-4', tier: 'small', sources: ['https://docs.anthropic.com/models'] },
        ],
      },
      codex: {
        models: [
          { id: 'gpt-5.1', tier: 'standard', sources: ['https://platform.openai.com/docs/models'] },
        ],
      },
    },
  };
}

function availSet(over: Partial<Record<CatalogHost, boolean>>): AvailabilitySet {
  const mk = (available: boolean) => ({ available, reasons: [] as string[] });
  return {
    claude: mk(over.claude ?? false),
    codex: mk(over.codex ?? false),
    gemini: mk(over.gemini ?? false),
    cursor: mk(over.cursor ?? false),
  };
}

test('resolve: exact-tier match (no downgrade, no warning)', () => {
  const r = resolveAvailableModel(catalog(), availSet({ claude: true }), 'standard');
  assert.equal('unavailable' in r, false);
  if ('unavailable' in r) return;
  assert.equal(r.tier, 'standard');
  assert.equal(r.model, 'claude-sonnet-4');
  assert.equal(r.downgraded, false);
  assert.equal(r.warning, undefined);
});

test('resolve: auto-upgrade to higher reachable tier when no exact match', () => {
  // claude available but codex (standard) not; ask for standard — claude has
  // standard too, so to test auto-upgrade ask for a tier where only higher
  // exists: make only the frontier model reachable.
  const cat: ModelsCatalog = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-opus-4', tier: 'frontier', sources: ['https://x.dev/a'] }] },
    },
  };
  const r = resolveAvailableModel(cat, availSet({ claude: true }), 'standard');
  if ('unavailable' in r) return assert.fail('expected a model');
  assert.equal(r.tier, 'frontier');
  assert.equal(r.downgraded, false);
  assert.equal(r.warning, undefined);
});

test('resolve: picks the LOWEST tier at-or-above the floor (cheapest upgrade)', () => {
  // floor small; claude has small/standard/frontier reachable → pick small.
  const r = resolveAvailableModel(catalog(), availSet({ claude: true }), 'small');
  if ('unavailable' in r) return assert.fail('expected a model');
  assert.equal(r.tier, 'small');
  assert.equal(r.model, 'claude-haiku-4');
  assert.equal(r.downgraded, false);
});

test('resolve: downgrade one tier WITH a warning when nothing >= floor', () => {
  // Only codex reachable (its best is standard); ask for frontier → downgrade.
  const r = resolveAvailableModel(catalog(), availSet({ codex: true }), 'frontier');
  if ('unavailable' in r) return assert.fail('expected a model');
  assert.equal(r.tier, 'standard');
  assert.equal(r.model, 'gpt-5.1');
  assert.equal(r.downgraded, true);
  assert.ok(r.warning && r.warning.includes('no model ≥ frontier reachable'));
  assert.ok(r.warning.includes('standard'));
  assert.ok(r.warning.includes('codex'));
});

test('resolve: downgrade picks the HIGHEST reachable tier below the floor', () => {
  // claude reachable with small+standard+frontier, but ask for a floor above
  // all? frontier is the top tier, so construct: only small+standard reachable.
  const cat: ModelsCatalog = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'a-small', tier: 'small', sources: ['https://x.dev/a'] },
          { id: 'b-standard', tier: 'standard', sources: ['https://x.dev/b'] },
        ],
      },
    },
  };
  const r = resolveAvailableModel(cat, availSet({ claude: true }), 'frontier');
  if ('unavailable' in r) return assert.fail('expected a model');
  assert.equal(r.tier, 'standard');
  assert.equal(r.model, 'b-standard');
  assert.equal(r.downgraded, true);
});

test('resolve: nothing reachable → { unavailable: true }', () => {
  const r = resolveAvailableModel(catalog(), availSet({}), 'standard');
  assert.equal('unavailable' in r && r.unavailable, true);
});

test('resolve: deterministic host/model pick (CATALOG_HOSTS order, sorted id)', () => {
  // Both claude and codex available, both carry a `standard` model. claude comes
  // first in CATALOG_HOSTS so it wins.
  const r = resolveAvailableModel(catalog(), availSet({ claude: true, codex: true }), 'standard');
  if ('unavailable' in r) return assert.fail('expected a model');
  assert.equal(r.host, 'claude');
  assert.equal(r.model, 'claude-sonnet-4');
});

test('resolve: throws on unknown desiredTier (defensive)', () => {
  assert.throws(
    () => resolveAvailableModel(catalog(), availSet({ claude: true }), 'mega' as never),
    /unknown desiredTier/,
  );
});

test('resolve: throws on a catalog model with an unknown tier (defensive)', () => {
  const cat = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: { claude: { models: [{ id: 'x', tier: 'mega', sources: ['https://x.dev/a'] }] } },
  } as unknown as ModelsCatalog;
  assert.throws(
    () => resolveAvailableModel(cat, availSet({ claude: true }), 'standard'),
    /unknown tier/,
  );
});

test('resolve: corrupt tier on an UNAVAILABLE host still throws (validate all hosts up front)', () => {
  // codex is UNAVAILABLE here, but its model carries a bogus tier. The resolver
  // must fail loud regardless of availability — not lurk until codex comes up.
  const cat = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-sonnet-4', tier: 'standard', sources: ['https://x'] }] },
      codex: { models: [{ id: 'gpt-x', tier: 'ultra', sources: ['https://y'] }] },
    },
  } as unknown as ModelsCatalog;
  assert.throws(
    () => resolveAvailableModel(cat, availSet({ claude: true, codex: false }), 'standard'),
    /unknown tier 'ultra'/,
  );
});
