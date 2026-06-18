// FORGE-204 (Search adapter I1): the `forge search <verb>` dispatcher.
//
// Mirrors the loom dispatcher SHAPE (envelope, --json, --help usage, unknown
// verb → fail envelope). Two verbs:
//   forge search fetch --url <url> [--json] [--allow-private]
//   forge search query --q <query> [--json]   (native → UNSUPPORTED + guidance)
//
// The provider is selected from settings (default native). The factory is the
// only construction path, so every result is Tripwire-scanned at the base. The
// provider constructor is injectable (deps.createProvider) so CLI tests run with
// a stubbed transport and hit NO real network.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import type { Search } from '../../schemas/settings.ts';
import { createSearchProvider } from '../../search/index.ts';
import { SearchError, type SearchProvider } from '../../search/types.ts';
import { emit, fail, ok, type Envelope } from '../envelope.ts';
import { hasFlag, parseFlag } from '../orchestrate/flags.ts';

export interface SearchDispatcherOpts {
  readonly cwd: string;
  // Injectable provider constructor for tests (no real network). Defaults to the
  // real factory bound to the resolved settings provider.
  readonly createProvider?: (config: Search) => SearchProvider;
}

export const SEARCH_VERB_NAMES = ['fetch', 'query'] as const;

const DEFAULT_SEARCH: Search = { provider: 'native' };

function resolveSearchConfig(cwd: string): Search {
  const settingsPath = path.join(cwd, '.forge', 'settings.yaml');
  // No settings file at all → the schema default (native). But a PRESENT-but-
  // invalid settings.yaml fails CLOSED (typed error surfaced) rather than
  // silently degrading to native, so a misconfigured provider is visible.
  if (!existsSync(settingsPath)) return DEFAULT_SEARCH;
  try {
    return loadSettings(settingsPath).search;
  } catch (err) {
    throw new SearchError(
      'SETTINGS_INVALID',
      `.forge/settings.yaml is present but invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function dispatchSearch(
  rest: readonly string[],
  opts: SearchDispatcherOpts,
): Promise<{ exitCode: number }> {
  const sub = rest[0];
  if (!sub) {
    process.stderr.write(usage());
    return { exitCode: 1 };
  }
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return { exitCode: 0 };
  }

  const json = hasFlag(rest, 'json');
  const verbArgs = rest.slice(1);

  switch (sub) {
    case 'fetch':
      return runFetch(verbArgs, json, opts);
    case 'query':
      return runQuery(verbArgs, json, opts);
    default:
      return {
        exitCode: emit(
          fail(
            'UNKNOWN_VERB',
            `forge search: unknown verb '${sub}'. Run \`forge search --help\` for the list.`,
            false,
          ),
          { json },
        ),
      };
  }
}

function makeProvider(opts: SearchDispatcherOpts): SearchProvider | Envelope {
  try {
    const config = resolveSearchConfig(opts.cwd);
    const factory = opts.createProvider ?? ((c: Search) => createSearchProvider(c));
    return factory(config);
  } catch (err) {
    if (err instanceof SearchError) {
      return fail(err.code, err.message, false, err.details);
    }
    return fail('FETCH_FAILED', 'failed to construct search provider', false);
  }
}

async function runFetch(
  verbArgs: readonly string[],
  json: boolean,
  opts: SearchDispatcherOpts,
): Promise<{ exitCode: number }> {
  const url = parseFlag(verbArgs, 'url');
  if (!url || url.length === 0) {
    return { exitCode: emit(fail('INVALID_ARGS', 'search fetch: --url <url> is required.', false), { json }) };
  }
  const allowPrivate = hasFlag(verbArgs, 'allow-private');

  const provider = makeProvider(opts);
  if (!('fetch' in provider)) return { exitCode: emit(provider, { json }) };

  try {
    const outcome = await provider.fetch(url, { allowPrivate });
    return { exitCode: emit(ok(outcome), { json }) };
  } catch (err) {
    return { exitCode: emit(toFailEnvelope(err), { json }) };
  }
}

async function runQuery(
  verbArgs: readonly string[],
  json: boolean,
  opts: SearchDispatcherOpts,
): Promise<{ exitCode: number }> {
  const q = parseFlag(verbArgs, 'q');
  if (!q || q.length === 0) {
    return { exitCode: emit(fail('INVALID_ARGS', 'search query: --q <query> is required.', false), { json }) };
  }

  const provider = makeProvider(opts);
  if (!('search' in provider)) return { exitCode: emit(provider, { json }) };

  try {
    const outcome = await provider.search(q, {});
    return { exitCode: emit(ok(outcome), { json }) };
  } catch (err) {
    return { exitCode: emit(toFailEnvelope(err), { json }) };
  }
}

// Map a thrown error to a typed fail envelope. NEVER echo a raw network error —
// SearchError carries a typed code; anything else collapses to FETCH_FAILED.
function toFailEnvelope(err: unknown): Envelope {
  if (err instanceof SearchError) {
    return fail(err.code, err.message, false, err.details);
  }
  return fail('FETCH_FAILED', 'search failed', false);
}

function usage(): string {
  return [
    'Usage: forge search <verb> [options]',
    '',
    'Verbs:',
    '  fetch   Fetch a single URL (keyless, SSRF-guarded, Tripwire-scanned). --url <url> [--allow-private].',
    '  query   Query search via the configured provider. --q <query>.',
    '          (native has no keyless query backend → configure search.provider = exa|parallel|perplexity.)',
    '',
    'Flags:',
    '  --json           Emit a stable JSON envelope on stdout.',
    '  --url            (fetch) URL to fetch.',
    '  --allow-private  (fetch) Opt out of the SSRF guard (allow private/loopback/metadata targets).',
    '  --q              (query) Query string.',
    '',
  ].join('\n') + '\n';
}
