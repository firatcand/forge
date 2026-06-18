// FORGE-204 (Search adapter I1): the structural Tripwire chokepoint + the
// SSRF-hardened fetch helper + a bounded HTML→text extractor.
//
// ScanningSearchProvider is the ONLY exported public SearchProvider. It wraps a
// RawSearchBackend and runs scanText(text,'search_result') on EVERY result
// before returning. A backend therefore cannot return text to an agent without
// the boundary scan (factory-only construction + module boundary).
//
// hardenedFetch is the shared SSRF-safe HTTP helper used by native (and future
// providers). It connects ONLY to a validated public IP via a custom DNS lookup
// (defeats DNS-rebind/TOCTOU), streams with a hard byte cap (never trusts
// Content-Length / .text()), follows redirects manually re-running the FULL
// guard on each hop, and surfaces ONLY typed error codes (never raw network
// errors/headers).
//
// SAFE_ENV_KEYS invariant (documented, not exercised here): future provider API
// keys resolve in THIS process via SecretsManager (src/core/secrets.ts) and are
// NEVER injected into a worker subprocess env. The native backend is keyless.

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';

import { scanText, type TripwireReport, type TripwireSeverity } from '../security/tripwire/scan.ts';
import {
  SearchError,
  type RawSearchBackend,
  type RawSearchResult,
  type ScannedResult,
  type SearchFetchOptions,
  type SearchHealth,
  type SearchOutcome,
  type SearchProvider,
  type SearchQueryOptions,
} from './types.ts';

// ── Field/length caps ───────────────────────────────────────────────────────
export const MAX_TITLE_LEN = 512;
export const MAX_SNIPPET_LEN = 2048;
export const MAX_TEXT_LEN = 256 * 1024; // 256 KiB of extracted/decoded text.
export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB streaming cap.
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_RAW_HTML_SCAN_BYTES = 1 * 1024 * 1024; // bounded raw-HTML scan input.

const ALLOWED_CONTENT_TYPES: readonly string[] = [
  'text/html',
  'text/plain',
  'application/json',
];

// ── Severity helper ─────────────────────────────────────────────────────────
const SEVERITY_RANK: Record<TripwireSeverity, number> = {
  clean: 0,
  suspicious: 1,
  hostile: 2,
};
function maxSeverity(a: TripwireSeverity, b: TripwireSeverity): TripwireSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function capStr(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max);
}

// ────────────────────────────────────────────────────────────────────────────
// ScanningSearchProvider — the structural chokepoint.
// ────────────────────────────────────────────────────────────────────────────
export class ScanningSearchProvider implements SearchProvider {
  readonly #backend: RawSearchBackend;

  constructor(backend: RawSearchBackend) {
    this.#backend = backend;
  }

  async fetch(url: string, opts?: SearchFetchOptions): Promise<SearchOutcome> {
    const raw = await this.#backend.fetchRaw(url, opts);
    return scanAll(raw);
  }

  async search(query: string, opts?: SearchQueryOptions): Promise<SearchOutcome> {
    const raw = await this.#backend.searchRaw(query, opts);
    return scanAll(raw);
  }

  healthCheck(): Promise<SearchHealth> {
    return this.#backend.healthCheck();
  }
}

// Scan every raw result. The PRIMARY scan is on `text`. DEFENSE-IN-DEPTH: when a
// result carries bounded raw HTML, scan it too and fold its severity in — so an
// injection that an extraction mistake stripped out is still caught. The raw
// HTML is NOT echoed to the caller (it is dropped from ScannedResult).
function scanAll(raw: readonly RawSearchResult[]): SearchOutcome {
  const results: ScannedResult[] = [];
  let severity: TripwireSeverity = 'clean';

  for (const r of raw) {
    const text = capStr(r.text, MAX_TEXT_LEN) ?? '';
    const title = capStr(r.title, MAX_TITLE_LEN);
    const snippet = capStr(r.snippet, MAX_SNIPPET_LEN);
    const answer = capStr(r.answer, MAX_TEXT_LEN);

    // Scan EVERY untrusted text field that reaches the agent — text, title,
    // snippet, answer — NOT just `text`. A provider (e.g. an answer-shaped
    // backend) must not be able to smuggle a hostile string through an unscanned
    // field. DEFENSE-IN-DEPTH: also scan bounded raw HTML so an injection an
    // extraction mistake stripped out is still caught. Raw HTML is NOT echoed.
    let report: TripwireReport = scanText(text, 'search_result');
    for (const extra of [title, snippet, answer]) {
      if (extra !== undefined && extra.length > 0) {
        report = mergeReports(report, scanText(extra, 'search_result'));
      }
    }
    if (r.rawHtml !== undefined && r.rawHtml.length > 0) {
      report = mergeReports(report, scanText(r.rawHtml.slice(0, MAX_RAW_HTML_SCAN_BYTES), 'search_result'));
    }

    const scanned: ScannedResult = {
      url: r.url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      text,
      ...(answer !== undefined ? { answer } : {}),
      tripwire: report,
    };
    results.push(scanned);
    severity = maxSeverity(severity, report.severity);
  }

  return { results, severity };
}

// Fold a defense-in-depth raw-HTML report into the primary text report. The text
// report stays authoritative for spans/source; we only union the findings and
// take the max severity.
function mergeReports(primary: TripwireReport, secondary: TripwireReport): TripwireReport {
  if (secondary.severity === 'clean' && secondary.findings.length === 0) return primary;
  return {
    source: primary.source,
    severity: maxSeverity(primary.severity, secondary.severity),
    findings: [...primary.findings, ...secondary.findings],
    truncated: primary.truncated || secondary.truncated,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// SSRF guard.
// ────────────────────────────────────────────────────────────────────────────

// Metadata / loopback hostnames blocked regardless of resolution (belt-and-
// suspenders alongside the IP guard).
const BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  'metadata.google.internal',
  'metadata',
];

// Normalize a hostname: lowercase, strip a single trailing dot (FQDN root).
function normalizeHostname(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

// Reject hosts that LOOK like a bare integer / octal / hex IP encoding (e.g.
// `0x7f000001`, `2130706433`, `0177.0.0.1`). These bypass naive dotted-quad
// parsing. We only allow: a real IP literal (isIP) OR a DNS hostname containing
// at least one non-digit, non-hex-prefix label.
function looksLikeNumericHostEncoding(host: string): boolean {
  // Pure decimal integer (e.g. 2130706433).
  if (/^\d+$/.test(host)) return true;
  // 0x / 0X hex (whole host or any dotted segment).
  const parts = host.split('.');
  for (const p of parts) {
    if (/^0x[0-9a-f]+$/i.test(p)) return true;
    // Octal: leading 0 followed by more octal digits (e.g. 0177). A lone "0" is
    // fine (it's a valid dotted-quad octet only as part of an IP literal, which
    // isIP handles separately).
    if (/^0[0-7]+$/.test(p)) return true;
  }
  return false;
}

// Is an IP (v4 or v6) public/global? Returns false for loopback, private,
// link-local, CGNAT, benchmarking, multicast, reserved, IPv4-mapped IPv6 of a
// blocked v4, etc.
export function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return isPublicV4(addr);
  if (fam === 6) return isPublicV6(addr);
  return false;
}

function isPublicV4(addr: string): boolean {
  const octets = addr.split('.').map((o) => Number(o));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8
  if (a === 0) return false;
  // 10.0.0.0/8
  if (a === 10) return false;
  // 127.0.0.0/8 loopback
  if (a === 127) return false;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return false;
  // 240.0.0.0/4 reserved (incl. 255.255.255.255 broadcast)
  if (a >= 240) return false;
  return true;
}

function expandV6(addr: string): number[] | null {
  // Strip zone id (fe80::1%eth0).
  const noZone = addr.split('%')[0] ?? addr;
  // Handle IPv4-mapped/embedded tail (::ffff:127.0.0.1).
  const v4Match = noZone.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  let head = noZone;
  let tailGroups: number[] = [];
  if (v4Match) {
    head = v4Match[1]!;
    const v4 = v4Match[2]!.split('.').map((o) => Number(o));
    if (v4.length !== 4 || v4.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    tailGroups = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    // head now ends with ':' — drop one trailing ':' so the join logic below
    // doesn't see an empty final group (keep '::' semantics intact).
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }

  const parts = head.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter((s) => s.length > 0) : [];
  const right =
    parts.length === 2 && parts[1] ? parts[1].split(':').filter((s) => s.length > 0) : [];

  const leftNums = left.map((g) => parseInt(g, 16));
  const rightNums = right.map((g) => parseInt(g, 16));
  if ([...leftNums, ...rightNums].some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;

  const explicit = leftNums.length + rightNums.length + tailGroups.length;
  let groups: number[];
  if (parts.length === 2) {
    const fill = 8 - explicit;
    if (fill < 0) return null;
    groups = [...leftNums, ...new Array(fill).fill(0), ...rightNums, ...tailGroups];
  } else {
    groups = [...leftNums, ...tailGroups];
  }
  if (groups.length !== 8) return null;
  return groups;
}

// Public-IPv6 classification by ALLOWLIST, not denylist: only global unicast
// (2000::/3) is treated as public, and embedded-IPv4 forms are judged by their
// v4. This rejects-by-default everything else (::, ::1, fc00::/7, fe80::/10,
// ff00::/8, 100::/64, the deprecated IPv4-compatible ::a.b.c.d incl. ::7f00:1,
// 2001:db8::/32 docs, etc.) — closing the narrow-denylist gaps.
function v4Str(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
function isPublicV6(addr: string): boolean {
  const g = expandV6(addr);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number, number, number, number, number, number, number, number,
  ];
  const highZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // IPv4-mapped ::ffff:a.b.c.d/96 — judge by the embedded v4.
  if (highZero && g5 === 0xffff) return isPublicV4(v4Str(g6, g7));
  // ::/96 low block: :: (unspecified), ::1 (loopback), and the DEPRECATED
  // IPv4-compatible ::a.b.c.d (e.g. ::7f00:1 == ::127.0.0.1) — all non-public.
  if (highZero && g5 === 0) return false;
  // 6to4 2002::/16 embeds a v4 in the next two groups — judge by it (a private
  // v4 must not tunnel through).
  if (g0 === 0x2002) return isPublicV4(v4Str(g1, g2));
  // 2001:db8::/32 documentation range — not routable.
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  // 100::/64 discard-only.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
  // ALLOWLIST: only global unicast 2000::/3 is public. Everything else
  // (fc00::/7, fe80::/10, ff00::/8, and any non-global prefix) is rejected.
  return (g0 & 0xe000) === 0x2000;
}

// Validate a URL string: scheme, hostname shape, blocked literal hostnames.
// Returns the parsed URL or throws a typed SearchError. Does NOT resolve DNS —
// the custom lookup enforces the per-address public check at connect time.
function guardUrl(rawUrl: string, allowPrivate: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SearchError('INVALID_URL', 'invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SearchError('SCHEME_REJECTED', `only http/https are allowed (got ${parsed.protocol})`);
  }
  if (allowPrivate) return parsed;

  const host = normalizeHostname(parsed.hostname);
  if (host.length === 0) throw new SearchError('INVALID_URL', 'empty host');
  if (BLOCKED_HOSTNAMES.includes(host)) {
    throw new SearchError('SSRF_BLOCKED', 'blocked hostname');
  }
  if (host.endsWith('.localhost')) {
    throw new SearchError('SSRF_BLOCKED', 'blocked hostname');
  }
  // If the host is an IP literal, validate it directly.
  const fam = isIP(host) || isIP(stripV6Brackets(host));
  if (fam !== 0) {
    if (!isPublicAddress(stripV6Brackets(host))) {
      throw new SearchError('SSRF_BLOCKED', 'blocked address');
    }
    return parsed;
  }
  // Not an IP literal — reject numeric/octal/hex encodings that bypass parsing.
  if (looksLikeNumericHostEncoding(host)) {
    throw new SearchError('SSRF_BLOCKED', 'numeric host encoding rejected');
  }
  return parsed;
}

function stripV6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

// ────────────────────────────────────────────────────────────────────────────
// hardenedFetch — SSRF-safe streaming HTTP with manual redirects + byte cap.
// ────────────────────────────────────────────────────────────────────────────

export type LookupFn = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

export interface RequestLike {
  on(event: string, listener: (...args: unknown[]) => void): RequestLike;
  setTimeout(ms: number, cb: () => void): RequestLike;
  destroy(err?: Error): void;
  end(): void;
}

export type RequestFn = (
  url: string,
  options: https.RequestOptions,
  callback: (res: ResponseLike) => void,
) => RequestLike;

export interface ResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): ResponseLike;
  destroy(err?: Error): void;
}

export interface FetchDeps {
  // Custom DNS resolver — injected in tests. Defaults to node:dns.lookup with
  // { all: true } so EVERY resolved address is checked.
  readonly lookup?: LookupFn;
  // Transport — injected in tests. Defaults to node:https/node:http request.
  readonly request?: RequestFn;
}

export interface HardenedResponse {
  readonly body: string;
  readonly contentType: string;
  readonly finalUrl: string;
}

// A lookup that resolves ALL addresses and REJECTS unless EVERY one is public.
// This is what binds the socket to a validated IP (defeats DNS-rebind): the
// returned address is one we have personally checked.
function makePublicOnlyLookup(base: LookupFn): LookupFn {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, addresses);
      if (!addresses || addresses.length === 0) {
        return callback(new Error('NO_ADDRESS') as NodeJS.ErrnoException, []);
      }
      for (const a of addresses) {
        if (!isPublicAddress(a.address)) {
          // Surface as a typed-ish error; hardenedFetch maps connect errors to
          // SSRF_BLOCKED for this path.
          const e = new Error('SSRF_BLOCKED') as NodeJS.ErrnoException;
          e.code = 'SSRF_BLOCKED';
          return callback(e, []);
        }
      }
      callback(null, addresses);
    });
  };
}

const defaultLookup: LookupFn = (hostname, options, callback) =>
  dns.lookup(hostname, options, callback as never);

const defaultRequest: RequestFn = (url, options, callback) => {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return mod.request(url, options, callback as never) as unknown as RequestLike;
};

export async function hardenedFetch(
  rawUrl: string,
  opts?: SearchFetchOptions,
  deps?: FetchDeps,
): Promise<HardenedResponse> {
  const allowPrivate = opts?.allowPrivate === true;
  const baseLookup = deps?.lookup ?? defaultLookup;
  const lookup = allowPrivate ? baseLookup : makePublicOnlyLookup(baseLookup);
  const request = deps?.request ?? defaultRequest;

  let currentUrl = guardUrl(rawUrl, allowPrivate).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-run the FULL guard on every hop (including the initial URL above).
    const parsed = guardUrl(currentUrl, allowPrivate);

    const result = await doRequest(parsed.toString(), lookup, request);
    if (result.kind === 'redirect') {
      if (hop === MAX_REDIRECTS) {
        throw new SearchError('TOO_MANY_REDIRECTS', 'too many redirects');
      }
      // Resolve relative Location against the current URL, then loop — the guard
      // re-runs at the top, re-checking scheme/host AND (via the lookup) the IP.
      let next: URL;
      try {
        next = new URL(result.location, parsed);
      } catch {
        throw new SearchError('INVALID_URL', 'invalid redirect target');
      }
      currentUrl = next.toString();
      continue;
    }
    return result.response;
  }
  // Unreachable (loop returns/throws), but satisfies the type checker.
  throw new SearchError('TOO_MANY_REDIRECTS', 'too many redirects');
}

type RequestResult =
  | { kind: 'response'; response: HardenedResponse }
  | { kind: 'redirect'; location: string };

function doRequest(url: string, lookup: LookupFn, request: RequestFn): Promise<RequestResult> {
  return new Promise<RequestResult>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn();
    };

    let req: RequestLike;
    try {
      req = request(
        url,
        {
          method: 'GET',
          lookup: lookup as never,
          headers: { accept: ALLOWED_CONTENT_TYPES.join(', '), 'user-agent': 'forge-search/1' },
        },
        (res: ResponseLike) => {
          const status = res.statusCode ?? 0;

          // Redirects: surface the Location for the caller to re-guard.
          if (status >= 300 && status < 400) {
            const loc = headerStr(res.headers['location']);
            res.destroy();
            if (!loc) {
              return done(() => reject(new SearchError('FETCH_FAILED', 'redirect without location')));
            }
            return done(() => resolve({ kind: 'redirect', location: loc }));
          }

          if (status < 200 || status >= 300) {
            res.destroy();
            return done(() =>
              reject(new SearchError('FETCH_FAILED', `unexpected status ${status}`, { status })),
            );
          }

          const ctype = headerStr(res.headers['content-type']) ?? '';
          if (!isAllowedContentType(ctype)) {
            res.destroy();
            return done(() =>
              reject(new SearchError('CONTENT_TYPE_REJECTED', 'disallowed content-type')),
            );
          }

          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: unknown) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            total += buf.byteLength;
            if (total > MAX_BODY_BYTES) {
              res.destroy();
              return done(() => reject(new SearchError('BODY_TOO_LARGE', 'response body too large')));
            }
            chunks.push(buf);
          });
          res.on('end', () => {
            done(() =>
              resolve({
                kind: 'response',
                response: {
                  body: Buffer.concat(chunks).toString('utf8'),
                  contentType: ctype,
                  finalUrl: url,
                },
              }),
            );
          });
          res.on('error', () => {
            done(() => reject(new SearchError('FETCH_FAILED', 'response stream error')));
          });
        },
      );
    } catch {
      return done(() => reject(new SearchError('FETCH_FAILED', 'request init failed')));
    }

    req.on('error', (err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'SSRF_BLOCKED') {
        return done(() => reject(new SearchError('SSRF_BLOCKED', 'blocked address')));
      }
      done(() => reject(new SearchError('FETCH_FAILED', 'network error')));
    });
    // Socket INACTIVITY timeout (idle between bytes).
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      done(() => reject(new SearchError('TIMEOUT', 'request timed out')));
    });
    // WALL-CLOCK deadline for the whole hop — a slow-drip server that keeps the
    // socket just active enough to dodge the inactivity timeout can still never
    // hold the fetch past this. (Per-hop; total is bounded by MAX_REDIRECTS.)
    deadline = setTimeout(() => {
      req.destroy();
      done(() => reject(new SearchError('TIMEOUT', 'request deadline exceeded')));
    }, FETCH_TIMEOUT_MS);
    req.end();
  });
}

function headerStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isAllowedContentType(ctype: string): boolean {
  const mime = (ctype.split(';')[0] ?? '').trim().toLowerCase();
  if (ALLOWED_CONTENT_TYPES.includes(mime)) return true;
  // *+json (e.g. application/ld+json).
  if (mime.endsWith('+json')) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// extractText — bounded, linear HTML→text. NO broad/nested regex, NO new dep.
// ────────────────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg']);

export function extractText(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  let skipUntil: string | null = null; // closing tag name we're skipping to.

  while (i < n) {
    const ch = html[i]!;
    if (ch === '<') {
      // Comment block <!-- ... -->
      if (html.startsWith('<!--', i)) {
        const close = html.indexOf('-->', i + 4);
        i = close === -1 ? n : close + 3;
        continue;
      }
      // CDATA / doctype / processing — skip to '>'.
      if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
        const close = html.indexOf('>', i);
        i = close === -1 ? n : close + 1;
        continue;
      }
      const tag = readTagName(html, i);
      if (tag) {
        if (tag.closing) {
          if (skipUntil && tag.name === skipUntil) skipUntil = null;
        } else if (SKIP_TAGS.has(tag.name) && !tag.selfClosing) {
          skipUntil = tag.name;
        }
        i = tag.end;
        // A tag boundary is whitespace between text runs.
        if (!skipUntil) out.push(' ');
        continue;
      }
      // A lone '<' not starting a tag — treat as text.
      if (!skipUntil) out.push(ch);
      i += 1;
      continue;
    }
    if (skipUntil) {
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }

  const joined = decodeEntities(out.join(''));
  return collapseWhitespace(joined);
}

interface TagInfo {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly end: number; // index just past the closing '>'.
}

// Parse a tag starting at html[start] === '<'. Returns null if it isn't a real
// tag (e.g. '< ' or end of input). Linear, no regex.
function readTagName(html: string, start: number): TagInfo | null {
  let i = start + 1;
  const n = html.length;
  let closing = false;
  if (html[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < n) {
    const c = html[i]!;
    if (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '-'
    ) {
      i += 1;
    } else {
      break;
    }
  }
  if (i === nameStart) return null; // no name → not a tag.
  const name = html.slice(nameStart, i).toLowerCase();
  // Skip to the closing '>'.
  let selfClosing = false;
  while (i < n && html[i] !== '>') {
    if (html[i] === '/' && html[i + 1] === '>') selfClosing = true;
    i += 1;
  }
  const end = i < n ? i + 1 : n;
  return { name, closing, selfClosing, end };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch !== '&') {
      out += ch;
      i += 1;
      continue;
    }
    const semi = s.indexOf(';', i + 1);
    if (semi === -1 || semi - i > 10) {
      out += ch;
      i += 1;
      continue;
    }
    const ent = s.slice(i + 1, semi);
    if (ent.startsWith('#')) {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          out += String.fromCodePoint(code);
        } catch {
          out += '';
        }
        i = semi + 1;
        continue;
      }
    } else if (ENTITIES[ent] !== undefined) {
      out += ENTITIES[ent];
      i = semi + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function collapseWhitespace(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}
