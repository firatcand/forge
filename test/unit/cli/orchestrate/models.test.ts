import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runOrchestrateModels,
  applyPins,
  diffCatalogs,
  type ModelsReadData,
  type ModelsRefreshData,
} from '../../../../src/cli/orchestrate/models.ts';
import type { ModelsCatalog } from '../../../../src/schemas/models-catalog.ts';
import { ok } from '../../../../src/cli/envelope.ts';

function forgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-models-'));
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (c: unknown) => {
      chunks.push(String(c));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => chunks.join('') };
}

function sampleCatalog(refreshedAt = '2026-06-14T12:00:00Z'): ModelsCatalog {
  return {
    version: 1,
    refreshed_at: refreshedAt,
    hosts: {
      claude: {
        models: [
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-sonnet-4', tier: 'standard', sources: ['https://docs.anthropic.com/models'] },
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

function writeCache(fd: string, cat: ModelsCatalog): void {
  mkdirSync(fd, { recursive: true });
  writeFileSync(join(fd, 'models-catalog.json'), JSON.stringify(cat), 'utf8');
}

function parseEnvelope<T>(text: string): { ok: boolean; data?: T; error?: { code: string } } {
  // The verb may emit a stderr nudge before the stdout envelope; here stdout is
  // captured separately, so text is the envelope alone.
  return JSON.parse(text.trim());
}

// ── read ──────────────────────────────────────────────────────────────────────

test('read returns cache (source: cache)', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog());
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, stdout: out.stream });
  assert.equal(r.exitCode, 0);
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data?.source, 'cache');
  assert.equal(env.data?.catalog.hosts.claude?.models.length, 2);
});

test('cold-start falls back to the bundled seed when no cache', () => {
  const fd = forgeDir(); // empty — no models-catalog.json
  const out = capture();
  const err = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, stdout: out.stream, stderr: err.stream });
  assert.equal(r.exitCode, 0);
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data?.source, 'seed');
  // seed lists all four hosts.
  assert.ok(env.data?.catalog.hosts.claude);
  assert.ok(env.data?.catalog.hosts.cursor);
});

test('R6 — staleness flagged + stderr nudge when refreshed_at old; never on JSON stdout', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog('2026-01-01T00:00:00Z'));
  const out = capture();
  const err = capture();
  const now = new Date('2026-06-14T00:00:00Z');
  const r = runOrchestrateModels({ forgeDir: fd, json: true, now, stdout: out.stream, stderr: err.stream });
  assert.equal(r.exitCode, 0);
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.equal(env.data?.stale, true);
  // Nudge on stderr only.
  assert.match(err.text(), /stale/);
  // stdout is pure JSON (no nudge text leaked).
  assert.doesNotMatch(out.text(), /run \/models to refresh/);
});

test('R6 — not stale within ttl; no nudge', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog('2026-06-10T00:00:00Z'));
  const out = capture();
  const err = capture();
  const now = new Date('2026-06-14T00:00:00Z'); // 4 days < 14
  runOrchestrateModels({ forgeDir: fd, json: true, now, stdout: out.stream, stderr: err.stream });
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.equal(env.data?.stale, false);
  assert.equal(err.text(), '');
});

test('R6 — FORGE_QUIET suppresses the stderr nudge', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog('2026-01-01T00:00:00Z'));
  const out = capture();
  const err = capture();
  const prev = process.env.FORGE_QUIET;
  process.env.FORGE_QUIET = '1';
  try {
    runOrchestrateModels({
      forgeDir: fd,
      json: true,
      now: new Date('2026-06-14T00:00:00Z'),
      stdout: out.stream,
      stderr: err.stream,
    });
  } finally {
    if (prev === undefined) delete process.env.FORGE_QUIET;
    else process.env.FORGE_QUIET = prev;
  }
  assert.equal(err.text(), '');
});

test('R1 — settings.pinned filters to subset; tiers/sources preserved', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog());
  writeFileSync(
    join(fd, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: t',
      'tracker:',
      '  type: linear',
      '  config:',
      '    team_id: T',
      'secrets:',
      '  manager: env_file',
      'models:',
      '  pinned:',
      '    claude: [claude-opus-4]',
    ].join('\n'),
    'utf8',
  );
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, stdout: out.stream });
  assert.equal(r.exitCode, 0);
  const env = parseEnvelope<ModelsReadData>(out.text());
  // claude filtered to just opus; codex unpinned → unchanged.
  assert.deepEqual(env.data?.catalog.hosts.claude?.models.map((m) => m.id), ['claude-opus-4']);
  assert.equal(env.data?.catalog.hosts.claude?.models[0]?.tier, 'frontier');
  assert.equal(env.data?.catalog.hosts.codex?.models.length, 1);
});

test('R1 — unknown pin warned (stderr) + ignored', () => {
  const fd = forgeDir();
  writeCache(fd, sampleCatalog());
  writeFileSync(
    join(fd, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: t',
      'tracker:',
      '  type: linear',
      '  config:',
      '    team_id: T',
      'secrets:',
      '  manager: env_file',
      'models:',
      '  pinned:',
      '    claude: [claude-opus-4, does-not-exist]',
    ].join('\n'),
    'utf8',
  );
  const out = capture();
  const err = capture();
  runOrchestrateModels({ forgeDir: fd, json: true, stdout: out.stream, stderr: err.stream });
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.deepEqual(env.data?.unknown_pins, [{ host: 'claude', id: 'does-not-exist' }]);
  assert.match(err.text(), /does-not-exist/);
  // Known pin still applied.
  assert.deepEqual(env.data?.catalog.hosts.claude?.models.map((m) => m.id), ['claude-opus-4']);
});

// ── refresh ─────────────────────────────────────────────────────────────────

test('--refresh --file validates + writes (read back)', () => {
  const fd = forgeDir();
  mkdirSync(fd, { recursive: true });
  const filePath = join(fd, 'agent.json');
  writeFileSync(filePath, JSON.stringify(sampleCatalog()), 'utf8');
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
  assert.equal(r.exitCode, 0);
  const env = parseEnvelope<ModelsRefreshData>(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data?.written, true);
  // Read back the written cache.
  const written = JSON.parse(readFileSync(join(fd, 'models-catalog.json'), 'utf8'));
  assert.equal(written.hosts.claude.models[0].id, 'claude-opus-4');
});

test('--refresh suppresses the staleness nudge (just wrote it)', () => {
  const fd = forgeDir();
  mkdirSync(fd, { recursive: true });
  const filePath = join(fd, 'agent.json');
  writeFileSync(filePath, JSON.stringify(sampleCatalog('2026-01-01T00:00:00Z')), 'utf8');
  const out = capture();
  const err = capture();
  runOrchestrateModels({
    forgeDir: fd,
    json: true,
    refresh: true,
    file: filePath,
    now: new Date('2026-06-14T00:00:00Z'),
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(err.text(), '');
});

test('--refresh bad file → INVALID_CATALOG, no write', () => {
  const fd = forgeDir();
  mkdirSync(fd, { recursive: true });
  const filePath = join(fd, 'bad.json');
  writeFileSync(filePath, JSON.stringify({ version: 1, hosts: {} }), 'utf8');
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
  assert.equal(r.exitCode, 1);
  const env = parseEnvelope(out.text());
  assert.equal(env.ok, false);
  assert.equal(env.error?.code, 'INVALID_CATALOG');
  // No cache written.
  assert.throws(() => readFileSync(join(fd, 'models-catalog.json'), 'utf8'));
});

test('--refresh non-JSON file → INVALID_CATALOG', () => {
  const fd = forgeDir();
  mkdirSync(fd, { recursive: true });
  const filePath = join(fd, 'junk.json');
  writeFileSync(filePath, 'not json {', 'utf8');
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
  assert.equal(r.exitCode, 1);
  assert.equal(parseEnvelope(out.text()).error?.code, 'INVALID_CATALOG');
});

test('--refresh missing --file → MISSING_INPUT', () => {
  const fd = forgeDir();
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, stdout: out.stream });
  assert.equal(r.exitCode, 1);
  assert.equal(parseEnvelope(out.text()).error?.code, 'MISSING_INPUT');
});

test('R2 — --refresh oversized file → INPUT_TOO_LARGE before parse', () => {
  const fd = forgeDir();
  mkdirSync(fd, { recursive: true });
  const filePath = join(fd, 'huge.json');
  // > 1 MiB of bytes.
  writeFileSync(filePath, 'x'.repeat(1024 * 1024 + 10), 'utf8');
  const out = capture();
  const r = runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
  assert.equal(r.exitCode, 1);
  assert.equal(parseEnvelope(out.text()).error?.code, 'INPUT_TOO_LARGE');
});

test('--refresh computes a diff (added/removed/retiered)', () => {
  const fd = forgeDir();
  // prior cache
  writeCache(fd, sampleCatalog());
  // new catalog: drop claude-sonnet-4, add gemini-pro, retier gpt-5.1.
  const next: ModelsCatalog = {
    version: 1,
    refreshed_at: '2026-06-14T13:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] }] },
      codex: { models: [{ id: 'gpt-5.1', tier: 'frontier', sources: ['https://platform.openai.com/docs/models'] }] },
      gemini: { models: [{ id: 'gemini-2.5-pro', tier: 'frontier', sources: ['https://ai.google.dev/models'] }] },
    },
  };
  const filePath = join(fd, 'next.json');
  writeFileSync(filePath, JSON.stringify(next), 'utf8');
  const out = capture();
  runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
  const env = parseEnvelope<ModelsRefreshData>(out.text());
  const diff = env.data!.diff;
  assert.ok(diff.added.some((a) => a.id === 'gemini-2.5-pro'));
  assert.ok(diff.removed.some((r) => r.id === 'claude-sonnet-4'));
  assert.ok(diff.retiered.some((t) => t.id === 'gpt-5.1' && t.from === 'standard' && t.to === 'frontier'));
});

// ── F3: canonical ordering (determinism) ──────────────────────────────────────

test('F3 — shuffled host/model order → byte-identical cache + stable diff', () => {
  // Two semantically-identical catalogs that differ ONLY in key/array order.
  const ordered: ModelsCatalog = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-sonnet-4', tier: 'standard', sources: ['https://docs.anthropic.com/models'] },
        ],
      },
      codex: {
        models: [
          { id: 'gpt-5.1', tier: 'standard', sources: ['https://platform.openai.com/docs/models'] },
        ],
      },
    },
  };
  const shuffled: ModelsCatalog = {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      // codex listed first; claude models in reverse id order.
      codex: {
        models: [
          { id: 'gpt-5.1', tier: 'standard', sources: ['https://platform.openai.com/docs/models'] },
        ],
      },
      claude: {
        models: [
          { id: 'claude-sonnet-4', tier: 'standard', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] },
        ],
      },
    },
  };

  function refreshAndRead(cat: ModelsCatalog): { cache: string; diff: unknown } {
    const fd = forgeDir();
    mkdirSync(fd, { recursive: true });
    const filePath = join(fd, 'agent.json');
    writeFileSync(filePath, JSON.stringify(cat), 'utf8');
    const out = capture();
    runOrchestrateModels({ forgeDir: fd, json: true, refresh: true, file: filePath, stdout: out.stream });
    const env = parseEnvelope<ModelsRefreshData>(out.text());
    return {
      cache: readFileSync(join(fd, 'models-catalog.json'), 'utf8'),
      diff: env.data!.diff,
    };
  }

  const a = refreshAndRead(ordered);
  const b = refreshAndRead(shuffled);
  // (a) byte-identical written cache.
  assert.equal(a.cache, b.cache);
  // (b) stable diff (both vs no prior cache → identical added set in identical order).
  assert.deepEqual(a.diff, b.diff);
  // Sanity: the canonical cache orders hosts (claude before codex) and ids.
  const parsed = JSON.parse(a.cache);
  assert.deepEqual(Object.keys(parsed.hosts), ['claude', 'codex']);
  assert.deepEqual(parsed.hosts.claude.models.map((m: { id: string }) => m.id), [
    'claude-opus-4',
    'claude-sonnet-4',
  ]);
});

test('F3 — read mode emits canonical (sorted) host + id order', () => {
  const fd = forgeDir();
  // Write a cache with reversed claude id order; read must re-sort.
  writeCache(fd, {
    version: 1,
    refreshed_at: '2026-06-14T12:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'claude-sonnet-4', tier: 'standard', sources: ['https://docs.anthropic.com/models'] },
          { id: 'claude-opus-4', tier: 'frontier', sources: ['https://docs.anthropic.com/models'] },
        ],
      },
    },
  });
  const out = capture();
  runOrchestrateModels({ forgeDir: fd, json: true, stdout: out.stream });
  const env = parseEnvelope<ModelsReadData>(out.text());
  assert.deepEqual(env.data?.catalog.hosts.claude?.models.map((m) => m.id), [
    'claude-opus-4',
    'claude-sonnet-4',
  ]);
});

// ── pure helpers ──────────────────────────────────────────────────────────────

test('applyPins — unpinned host unchanged; pin selects subset; unknown recorded', () => {
  const cat = sampleCatalog();
  const { catalog, unknownPins } = applyPins(cat, {
    claude: ['claude-opus-4', 'ghost'],
  });
  assert.deepEqual(catalog.hosts.claude?.models.map((m) => m.id), ['claude-opus-4']);
  assert.equal(catalog.hosts.codex?.models.length, 1); // unpinned → unchanged
  assert.deepEqual(unknownPins, [{ host: 'claude', id: 'ghost' }]);
});

test('applyPins — no pinned config → identity', () => {
  const cat = sampleCatalog();
  const { catalog, unknownPins } = applyPins(cat, undefined);
  assert.deepEqual(catalog, cat);
  assert.equal(unknownPins.length, 0);
});

test('applyPins — pin matching zero known models drops the host', () => {
  const cat = sampleCatalog();
  const { catalog, unknownPins } = applyPins(cat, { claude: ['only-ghosts'] });
  assert.equal(catalog.hosts.claude, undefined);
  assert.deepEqual(unknownPins, [{ host: 'claude', id: 'only-ghosts' }]);
});

test('diffCatalogs — no prior cache → everything added', () => {
  const next = sampleCatalog();
  const diff = diffCatalogs(undefined, next);
  assert.equal(diff.added.length, 3);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.retiered.length, 0);
});

// Default-stream sanity: ok() shape is consumed.
test('envelope ok shape sanity', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, data: { a: 1 } });
});
