import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatchSearch } from '../../../src/cli/search/index.ts';
import { SearchError, type SearchOutcome, type SearchProvider } from '../../../src/search/types.ts';
import type { Envelope } from '../../../src/cli/envelope.ts';

// Capture stdout for the duration of fn, returning the parsed JSON envelope.
async function captureJson(fn: () => Promise<unknown>): Promise<Envelope> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = ((chunk: unknown) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(buf) as Envelope;
}

// A provider whose fetch returns a fixed outcome (no network).
function fakeProvider(outcome: SearchOutcome): SearchProvider {
  return {
    fetch: async () => outcome,
    search: async () => outcome,
    healthCheck: async () => ({ ok: true }),
  };
}

const cleanOutcome: SearchOutcome = {
  results: [
    {
      url: 'http://example.com/',
      text: 'hello',
      tripwire: { source: 'search_result', severity: 'clean', findings: [], truncated: false },
    },
  ],
  severity: 'clean',
};

test('search fetch — present-but-invalid settings.yaml fails closed (SETTINGS_INVALID)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-search-'));
  try {
    mkdirSync(path.join(dir, '.forge'), { recursive: true });
    writeFileSync(path.join(dir, '.forge', 'settings.yaml'), 'this: : : not valid yaml\n  - broken');
    const env = await captureJson(() =>
      dispatchSearch(['fetch', '--url', 'http://example.com/', '--json'], { cwd: dir }),
    );
    assert.equal(env.ok, false);
    assert.equal((env as { error: { code: string } }).error.code, 'SETTINGS_INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search fetch --url --json → ok envelope with scanned outcome', async () => {
  const env = await captureJson(() =>
    dispatchSearch(['fetch', '--url', 'http://example.com/', '--json'], {
      cwd: '/nonexistent',
      createProvider: () => fakeProvider(cleanOutcome),
    }),
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  const data = env.data as SearchOutcome;
  assert.equal(data.severity, 'clean');
  assert.equal(data.results[0]!.url, 'http://example.com/');
  assert.ok(data.results[0]!.tripwire);
});

test('search fetch — missing --url → INVALID_ARGS', async () => {
  const env = await captureJson(() =>
    dispatchSearch(['fetch', '--json'], { cwd: '/nonexistent', createProvider: () => fakeProvider(cleanOutcome) }),
  );
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, 'INVALID_ARGS');
});

test('search query (native) → UNSUPPORTED_OPERATION envelope with guidance', async () => {
  const provider: SearchProvider = {
    fetch: async () => cleanOutcome,
    search: async () => {
      throw new SearchError(
        'UNSUPPORTED_OPERATION',
        'native supports URL fetch; configure `search.provider = exa|parallel|perplexity` for query search',
      );
    },
    healthCheck: async () => ({ ok: true }),
  };
  const env = await captureJson(() =>
    dispatchSearch(['query', '--q', 'anything', '--json'], {
      cwd: '/nonexistent',
      createProvider: () => provider,
    }),
  );
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, 'UNSUPPORTED_OPERATION');
  assert.match(env.error.message, /search\.provider = exa\|parallel\|perplexity/);
});

test('search query — missing --q → INVALID_ARGS', async () => {
  const env = await captureJson(() =>
    dispatchSearch(['query', '--json'], { cwd: '/nonexistent', createProvider: () => fakeProvider(cleanOutcome) }),
  );
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, 'INVALID_ARGS');
});

test('search — unknown verb → UNKNOWN_VERB', async () => {
  const env = await captureJson(() =>
    dispatchSearch(['bogus', '--json'], { cwd: '/nonexistent' }),
  );
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, 'UNKNOWN_VERB');
});

test('search fetch — a thrown SearchError surfaces as a typed envelope (no raw error)', async () => {
  const provider: SearchProvider = {
    fetch: async () => {
      throw new SearchError('SSRF_BLOCKED', 'blocked address');
    },
    search: async () => cleanOutcome,
    healthCheck: async () => ({ ok: true }),
  };
  const env = await captureJson(() =>
    dispatchSearch(['fetch', '--url', 'http://169.254.169.254/', '--json'], {
      cwd: '/nonexistent',
      createProvider: () => provider,
    }),
  );
  assert.equal(env.ok, false);
  if (env.ok) return;
  assert.equal(env.error.code, 'SSRF_BLOCKED');
});

test('search --help → exit 0', async () => {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let result;
  try {
    result = await dispatchSearch(['--help'], { cwd: '/nonexistent' });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(result.exitCode, 0);
});
