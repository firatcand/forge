// FORGE-204 (Search adapter I1): the search adapter seam.
//
// Two interfaces, deliberately split:
//   - RawSearchBackend (INTERNAL) returns UNSCANNED RawSearchResult[]. Backends
//     (native, future exa/parallel/perplexity) implement ONLY this.
//   - SearchProvider (PUBLIC) returns SearchOutcome — results carrying a
//     TripwireReport. This is produced ONLY by ScanningSearchProvider in
//     base.ts, so a backend physically cannot hand raw text to an agent without
//     passing through the boundary scan (scanText(text,'search_result')).
//
// Trust boundary: `forge search fetch` is the FIRST path carrying externally-
// authorable free-form text toward an agent. It lands WITH its Tripwire scan at
// the adapter base — see spec/THREAT-MODEL.md.

import type { TripwireReport, TripwireSeverity } from '../security/tripwire/scan.ts';

export type SearchProviderType = 'native' | 'exa' | 'parallel' | 'perplexity';

export const SEARCH_PROVIDER_TYPES: readonly SearchProviderType[] = [
  'native',
  'exa',
  'parallel',
  'perplexity',
];

// UNSCANNED, internal. Produced by a RawSearchBackend; never returned to a
// caller without first passing through ScanningSearchProvider.
export interface RawSearchResult {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  // The free-form body that gets Tripwire-scanned. For native fetch this is the
  // extracted page text; the backend also surfaces the bounded raw HTML so the
  // wrapper can run a defense-in-depth scan over it.
  readonly text: string;
  // Optional raw HTML (bounded) for the wrapper's defense-in-depth scan. Not
  // echoed to callers.
  readonly rawHtml?: string;
  // Provider-synthesized answer (Perplexity-shaped). Carried in the TYPE now;
  // normalization lands with that provider.
  readonly answer?: string;
}

// A scanned result: a raw result with its boundary scan attached. `rawHtml` is
// intentionally dropped — callers never receive the raw page.
export interface ScannedResult {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly text: string;
  readonly answer?: string;
  readonly tripwire: TripwireReport;
}

export interface SearchOutcome {
  readonly results: readonly ScannedResult[];
  // Max severity across all result scans (and their defense-in-depth raw scans).
  readonly severity: TripwireSeverity;
}

export interface SearchHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SearchFetchOptions {
  // SSRF opt-out: allow private/loopback/metadata targets. Default-deny.
  readonly allowPrivate?: boolean;
}

export type SearchQueryOptions = Record<never, never>;

// INTERNAL. Backends return RAW results only.
export interface RawSearchBackend {
  fetchRaw(url: string, opts?: SearchFetchOptions): Promise<RawSearchResult[]>;
  searchRaw(query: string, opts?: SearchQueryOptions): Promise<RawSearchResult[]>;
  healthCheck(): Promise<SearchHealth>;
}

// PUBLIC. Produced ONLY by ScanningSearchProvider (base.ts) via the factory
// (index.ts). Every result has already been Tripwire-scanned.
export interface SearchProvider {
  fetch(url: string, opts?: SearchFetchOptions): Promise<SearchOutcome>;
  search(query: string, opts?: SearchQueryOptions): Promise<SearchOutcome>;
  healthCheck(): Promise<SearchHealth>;
}

// Typed error codes — NEVER echo raw network errors/headers to a caller.
export type SearchErrorCode =
  | 'SSRF_BLOCKED'
  | 'INVALID_URL'
  | 'SCHEME_REJECTED'
  | 'CONTENT_TYPE_REJECTED'
  | 'BODY_TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'FETCH_FAILED'
  | 'UNSUPPORTED_OPERATION'
  | 'NOT_IMPLEMENTED'
  | 'SETTINGS_INVALID';

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: SearchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    if (details) this.details = details;
  }
}
