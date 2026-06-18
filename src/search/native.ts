// FORGE-204 (Search adapter I1): the keyless native backend.
//
// `fetchRaw(url)` is the WebFetch equivalent: hardenedFetch (SSRF-safe) → on an
// HTML page, extractText → return RAW result (text + bounded raw HTML for the
// wrapper's defense-in-depth scan). text/plain and JSON bodies pass through as
// text. `searchRaw` is UNSUPPORTED: native has no keyless query backend — the
// caller must configure a provider. `healthCheck` is always ok (no external dep).
//
// This backend returns RAW only; ScanningSearchProvider (base.ts) attaches the
// Tripwire boundary scan. The factory (index.ts) is the only construction path.

import {
  extractText,
  hardenedFetch,
  MAX_RAW_HTML_SCAN_BYTES,
  type FetchDeps,
} from './base.ts';
import {
  SearchError,
  type RawSearchBackend,
  type RawSearchResult,
  type SearchFetchOptions,
  type SearchHealth,
} from './types.ts';

export class NativeBackend implements RawSearchBackend {
  readonly #deps: FetchDeps | undefined;

  constructor(deps?: FetchDeps) {
    this.#deps = deps;
  }

  async fetchRaw(url: string, opts?: SearchFetchOptions): Promise<RawSearchResult[]> {
    const res = await hardenedFetch(url, opts, this.#deps);
    const isHtml = res.contentType.split(';')[0]?.trim().toLowerCase() === 'text/html';
    const text = isHtml ? extractText(res.body) : res.body;
    const result: RawSearchResult = {
      url: res.finalUrl,
      text,
      // Carry bounded raw HTML so the wrapper can run a defense-in-depth scan
      // over content an extraction mistake might have stripped. Only for HTML.
      ...(isHtml ? { rawHtml: res.body.slice(0, MAX_RAW_HTML_SCAN_BYTES) } : {}),
    };
    return [result];
  }

  searchRaw(_query: string): Promise<RawSearchResult[]> {
    throw new SearchError(
      'UNSUPPORTED_OPERATION',
      'native supports URL fetch; configure `search.provider = exa|parallel|perplexity` for query search',
    );
  }

  healthCheck(): Promise<SearchHealth> {
    return Promise.resolve({ ok: true });
  }
}
