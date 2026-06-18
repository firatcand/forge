// FORGE-204 (Search adapter I1): the search provider factory.
//
// createSearchProvider is the ONLY public constructor of a SearchProvider. It
// wires the requested backend behind ScanningSearchProvider, so every public
// provider Tripwire-scans its results at the base. `native` is keyless and wired
// now; exa/parallel/perplexity throw NOT_IMPLEMENTED with guidance (mirrors
// src/core/secrets.ts) — their backends + secrets-manager key resolution land in
// follow-up increments.

import type { Search } from '../schemas/settings.ts';
import { ScanningSearchProvider, type FetchDeps } from './base.ts';
import { NativeBackend } from './native.ts';
import { SearchError, type SearchProvider } from './types.ts';

export function createSearchProvider(config: Search, deps?: FetchDeps): SearchProvider {
  switch (config.provider) {
    case 'native':
      return new ScanningSearchProvider(new NativeBackend(deps));
    case 'exa':
    case 'parallel':
    case 'perplexity':
      throw new SearchError(
        'NOT_IMPLEMENTED',
        `search.provider '${config.provider}' is configured but the backend is not yet implemented. ` +
          `Currently available: native (URL fetch, keyless). ` +
          `Provider-backed query search (exa | parallel | perplexity) lands in a follow-up increment.`,
        { provider: config.provider },
      );
    default: {
      const _exhaustive: never = config;
      void _exhaustive;
      throw new SearchError(
        'NOT_IMPLEMENTED',
        `unhandled search.provider value: ${String((config as { provider: string }).provider)}`,
      );
    }
  }
}

export { ScanningSearchProvider } from './base.ts';
// NativeBackend is deliberately NOT re-exported here: the chokepoint guarantee is
// "only the factory constructs a (scanned) SearchProvider". The raw backend stays
// importable from './native.ts' for tests, but is not part of the public surface.
export * from './types.ts';
