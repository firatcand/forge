// `forge orchestrate models` — the agent-refreshed model catalog (FORGE-212).
//
// READ band. Two modes on one verb (matches the ticket's `models --refresh`
// shape):
//
//   models                          → read the cached catalog + staleness.
//                                     No cache → load the bundled seed (cold
//                                     start). Applies settings.models.pinned as
//                                     a per-host allow-list FILTER (R1). Nudges
//                                     on stderr when older than ttl_days (R6).
//   models --refresh --file <json>  → validate an agent-compiled catalog,
//                                     atomically write .forge/models-catalog.json,
//                                     print a diff vs the prior cache.
//
// Why read-band despite the `--refresh` write: the only thing it writes is the
// benign local DERIVED cache (.forge/models-catalog.json) — no lease, no
// tracker, no approval. Flagged for the reviewer as deliberate (R3). The
// `--file` payload is UNTRUSTED (agent/external): size-capped before read and
// every schema field is bounded + `.strict()` (R2).
//
// Source-of-truth note: the router (FORGE-210) reads ONLY this cache for
// deterministic routing and reuses `applyPins`; availability probing
// (FORGE-213) filters it further.

import { readFileSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { execa } from 'execa';

import { writeAtomic } from '../../core/fs-atomic.ts';
import { formatRelativeAge } from '../../core/freshness.ts';
import { loadSettings } from '../../core/settings.ts';
import {
  computeAvailability,
  type AvailabilitySet,
} from '../../orchestrator/availability.ts';
import type { ExecaLike } from '../init/validate.ts';
import {
  ModelsCatalogSchema,
  CATALOG_HOSTS,
  type ModelsCatalog,
  type CatalogHost,
} from '../../schemas/models-catalog.ts';
import type { Models } from '../../schemas/settings.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// Untrusted --file size guard — mirrors dashboard.ts readJsonCapped's cap.
const FILE_MAX_BYTES = 1 * 1024 * 1024;

const CATALOG_FILENAME = 'models-catalog.json';
const DEFAULT_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── F3: canonicalization — determinism boundary ──────────────────────────────
// An agent-authored --file may carry hosts and models in arbitrary key/array
// order. Before diffing, printing, or writing the cache we canonicalize so a
// semantically-identical catalog always yields a byte-identical written cache
// and a stable diff: hosts ordered by CATALOG_HOSTS, models within each host
// sorted by id. Returns a NEW catalog (no mutation of the input).
function canonicalizeCatalog(catalog: ModelsCatalog): ModelsCatalog {
  const nextHosts: ModelsCatalog['hosts'] = {};
  for (const host of CATALOG_HOSTS) {
    const hc = catalog.hosts[host];
    if (!hc) continue;
    const models = [...hc.models].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    nextHosts[host] = { ...hc, models };
  }
  return { ...catalog, hosts: nextHosts };
}

// ── R1: applyPins — pure per-host allow-list FILTER over the cache ────────────
// `pinned[host]` (when set) restricts a host to ONLY those cached model ids:
//   - keeps cached models whose id ∈ pins[host];
//   - a host with NO pin entry → unchanged (full list);
//   - a pinned id NOT present in the cache → dropped + recorded in unknownPins.
// Tiers/sources stay authoritative in the cache — the pin never re-specifies a
// model. Returns a NEW catalog (no mutation of the input). The router (210)
// reuses this.
export interface UnknownPin {
  readonly host: CatalogHost;
  readonly id: string;
}
export interface ApplyPinsResult {
  readonly catalog: ModelsCatalog;
  readonly unknownPins: UnknownPin[];
}

export function applyPins(
  catalog: ModelsCatalog,
  pinned: Models['pinned'],
): ApplyPinsResult {
  if (!pinned) return { catalog, unknownPins: [] };

  const unknownPins: UnknownPin[] = [];
  const nextHosts: ModelsCatalog['hosts'] = {};

  for (const [host, hostCatalog] of Object.entries(catalog.hosts) as [
    CatalogHost,
    ModelsCatalog['hosts'][CatalogHost],
  ][]) {
    if (!hostCatalog) continue;
    const pins = pinned[host];
    if (!pins || pins.length === 0) {
      // No pin for this host → unchanged.
      nextHosts[host] = hostCatalog;
      continue;
    }
    const cachedIds = new Set(hostCatalog.models.map((m) => m.id));
    // Record pins that name a model the cache doesn't have.
    for (const id of pins) {
      if (!cachedIds.has(id)) unknownPins.push({ host, id });
    }
    const pinSet = new Set(pins);
    const kept = hostCatalog.models.filter((m) => pinSet.has(m.id));
    // A pin that filters to zero known models would violate HostCatalog.min(1).
    // Drop the host entirely in that case (the router sees no models for it)
    // rather than emit an invalid host catalog.
    if (kept.length === 0) continue;
    nextHosts[host] = { models: kept };
  }

  return { catalog: { ...catalog, hosts: nextHosts }, unknownPins };
}

// ── Seed cold-start loader (5-level import.meta.url walk; mirrors
// src/cli/upgrade/template-loader.ts locateContextTemplate) ───────────────────
function loadBundledSeed(): ModelsCatalog {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/cli/orchestrate/ → ../../../templates/. Bundled: dist/ → ../templates/.
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(
      here,
      ...(Array(i).fill('..') as string[]),
      'templates',
      'models-catalog.seed.json',
    );
    let raw: string;
    try {
      raw = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const parsed = ModelsCatalogSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `forge orchestrate models: bundled seed at ${candidate} failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
  throw new Error(
    'forge orchestrate models: templates/models-catalog.seed.json not found in bundle',
  );
}

// ── F4: fd-bounded read of the untrusted --file ──────────────────────────────
// Close the stat→read TOCTOU: bind the size cap to the actual open fd, not to a
// path that could be swapped between a statSync and a readFileSync. openSync →
// fstatSync (fast reject on declared size) → read at most FILE_MAX_BYTES + 1
// bytes from the fd; if the bytes actually read exceed the cap, the file is too
// large and we reject WITHOUT writing. closeSync always runs in finally.
type CappedRead =
  | { kind: 'ok'; raw: string }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'not_file' }
  | { kind: 'error'; message: string };

function readFileFdCapped(filePath: string): CappedRead {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: 'not_file' };
    if (st.size > FILE_MAX_BYTES) return { kind: 'too_large', bytes: st.size };
    // Read up to cap+1 bytes from the fd itself. If we manage to read more than
    // the cap, the (possibly swapped) file grew past the bound — reject.
    const buf = Buffer.allocUnsafe(FILE_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > FILE_MAX_BYTES) return { kind: 'too_large', bytes: total };
    }
    return { kind: 'ok', raw: buf.toString('utf8', 0, total) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close; the read result already stands.
      }
    }
  }
}

// ── Cache read (untrusted-on-disk: size-capped, schema-validated) ─────────────
function loadCache(catalogPath: string): ModelsCatalog | undefined {
  let raw: string;
  try {
    const s = statSync(catalogPath);
    if (!s.isFile() || s.size > FILE_MAX_BYTES) return undefined;
    raw = readFileSync(catalogPath, 'utf8');
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = ModelsCatalogSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

// Best-effort settings load — missing/unreadable settings.yaml → defaults
// (mirror doctor.ts: a verb in the read band must not refuse to run because the
// adopter hasn't `forge init`-ed yet).
function loadModelsSettings(forgeDir: string): Models {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.models;
  } catch {
    return { ttl_days: DEFAULT_TTL_DAYS };
  }
}

// FORGE-213: cursor availability is gated on agents.cursor_host_beta_opt_in.
// Best-effort like loadModelsSettings — default false (cursor stays gated) when
// settings are missing/unreadable.
function loadCursorBetaOptIn(forgeDir: string): boolean {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.agents.cursor_host_beta_opt_in === true;
  } catch {
    return false;
  }
}

// ── Diff: added / removed / retiered models, per host ─────────────────────────
export interface CatalogDiff {
  readonly added: { host: string; id: string; tier: string }[];
  readonly removed: { host: string; id: string }[];
  readonly retiered: { host: string; id: string; from: string; to: string }[];
}

export function diffCatalogs(
  prev: ModelsCatalog | undefined,
  next: ModelsCatalog,
): CatalogDiff {
  const added: CatalogDiff['added'] = [];
  const removed: CatalogDiff['removed'] = [];
  const retiered: CatalogDiff['retiered'] = [];

  const prevHosts = prev?.hosts ?? {};
  // F3: iterate hosts in CATALOG_HOSTS order and ids in sorted order so the diff
  // rows are deterministic regardless of the input file's key/array ordering.
  for (const host of CATALOG_HOSTS) {
    const prevModels = new Map(
      (prevHosts[host]?.models ?? []).map((m) => [m.id, m]),
    );
    const nextModels = new Map(
      (next.hosts[host]?.models ?? []).map((m) => [m.id, m]),
    );
    const sortedIds = (ids: Iterable<string>): string[] =>
      [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of sortedIds(nextModels.keys())) {
      const m = nextModels.get(id)!;
      const before = prevModels.get(id);
      if (!before) {
        added.push({ host, id, tier: m.tier });
      } else if (before.tier !== m.tier) {
        retiered.push({ host, id, from: before.tier, to: m.tier });
      }
    }
    for (const id of sortedIds(prevModels.keys())) {
      if (!nextModels.has(id)) removed.push({ host, id });
    }
  }
  return { added, removed, retiered };
}

// ── Staleness ─────────────────────────────────────────────────────────────────
function computeAgeMs(refreshedAt: string, now: Date): number {
  const ms = Date.parse(refreshedAt);
  return Number.isNaN(ms) ? 0 : now.getTime() - ms;
}

export interface ModelsReadData {
  readonly catalog: ModelsCatalog;
  readonly source: 'cache' | 'seed';
  readonly stale: boolean;
  readonly age: string;
  readonly unknown_pins: UnknownPin[];
}
export interface ModelsRefreshData {
  readonly written: true;
  readonly path: string;
  readonly diff: CatalogDiff;
}
export interface ModelsAvailabilityData {
  readonly availability: AvailabilitySet;
}

export interface OrchestrateModelsOptions {
  readonly forgeDir: string;
  readonly json?: boolean;
  readonly refresh?: boolean;
  // FORGE-213: compute the per-host availability set over the catalog hosts and
  // emit it. Read-band (no writes). Mutually exclusive with --refresh.
  readonly availability?: boolean;
  readonly file?: string;
  readonly now?: Date;
  // Injectable streams so PassThrough fixtures capture output (precedent:
  // dashboard.ts / status.ts — the shared logger writes straight to
  // process.stdout and is invisible to captured streams).
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  // FORGE-213 (R4): availability deps seam. Default to the real
  // execa/process.env/existsSync/os.homedir so production needs no wiring; tests
  // inject deterministic fakes (NO real binaries).
  readonly exec?: ExecaLike;
  readonly getEnv?: (name: string) => string | undefined;
  readonly fileExists?: (path: string) => boolean;
  readonly homeDir?: string;
  readonly timeoutMs?: number;
}
export interface OrchestrateModelsResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

const quiet = (): boolean => process.env.FORGE_QUIET === '1';

export function runOrchestrateModels(
  opts: OrchestrateModelsOptions,
): OrchestrateModelsResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const json = opts.json === true;
  const now = opts.now ?? new Date();
  const catalogPath = path.join(opts.forgeDir, CATALOG_FILENAME);

  // ── R4: --availability + --refresh is INVALID_ARGS, rejected BEFORE any file
  // op (read OR write). --availability runs through the async path
  // (runOrchestrateModelsAvailability) routed by the handler; reaching this sync
  // entry point with `availability` set alongside `refresh` is the illegal combo.
  if (opts.availability && opts.refresh) {
    return {
      exitCode: writeEnvelope(
        fail(
          'INVALID_ARGS',
          'forge orchestrate models: --availability and --refresh are mutually exclusive.',
          false,
        ),
        out,
      ),
    };
  }

  // ── Refresh mode ───────────────────────────────────────────────────────────
  if (opts.refresh) {
    const file = opts.file;
    if (!file || file.length === 0) {
      return {
        exitCode: writeEnvelope(
          fail(
            'MISSING_INPUT',
            'forge orchestrate models --refresh requires --file <json> (the agent-compiled catalog).',
            false,
          ),
          out,
        ),
      };
    }
    // R2 + F4: fd-bounded read — the cap is enforced against the open fd, not a
    // swappable path (closes the stat→read TOCTOU). Rejects an oversized
    // untrusted file BEFORE any parse/write.
    const read = readFileFdCapped(file);
    let raw: string;
    switch (read.kind) {
      case 'ok':
        raw = read.raw;
        break;
      case 'too_large':
        return {
          exitCode: writeEnvelope(
            fail(
              'INPUT_TOO_LARGE',
              `forge orchestrate models --refresh: ${file} is ${read.bytes} bytes (> ${FILE_MAX_BYTES} byte cap).`,
              false,
            ),
            out,
          ),
        };
      case 'not_file':
        return {
          exitCode: writeEnvelope(
            fail('MISSING_INPUT', `forge orchestrate models --refresh: ${file} is not a file.`, false),
            out,
          ),
        };
      case 'error':
        return {
          exitCode: writeEnvelope(
            fail(
              'MISSING_INPUT',
              `forge orchestrate models --refresh: cannot read ${file}: ${read.message}`,
              false,
            ),
            out,
          ),
        };
    }

    let json2: unknown;
    try {
      json2 = JSON.parse(raw);
    } catch (e) {
      return {
        exitCode: writeEnvelope(
          fail(
            'INVALID_CATALOG',
            `forge orchestrate models --refresh: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
            false,
          ),
          out,
        ),
      };
    }
    const parsed = ModelsCatalogSchema.safeParse(json2);
    if (!parsed.success) {
      return {
        exitCode: writeEnvelope(
          fail(
            'INVALID_CATALOG',
            `forge orchestrate models --refresh: ${file} failed catalog validation: ${parsed.error.message}`,
            false,
          ),
          out,
        ),
      };
    }

    // F3: canonicalize both sides before diffing/writing so a semantically
    // identical (shuffled) input yields a byte-identical cache + stable diff.
    const prev = loadCache(catalogPath);
    const canonical = canonicalizeCatalog(parsed.data);
    const diff = diffCatalogs(prev ? canonicalizeCatalog(prev) : prev, canonical);
    try {
      writeAtomic(catalogPath, `${JSON.stringify(canonical, null, 2)}\n`);
    } catch (e) {
      return {
        exitCode: writeEnvelope(
          fail(
            'WRITE_FAILED',
            `forge orchestrate models --refresh: failed to write ${catalogPath}: ${e instanceof Error ? e.message : String(e)}`,
            false,
          ),
          out,
        ),
      };
    }

    const data: ModelsRefreshData = { written: true, path: catalogPath, diff };
    if (json) return { exitCode: writeEnvelope(ok(data), out) };
    out.write(formatRefresh(data));
    return { exitCode: 0 };
  }

  // ── Read mode ────────────────────────────────────────────────────────────────
  const cached = loadCache(catalogPath);
  const source: 'cache' | 'seed' = cached ? 'cache' : 'seed';
  let base: ModelsCatalog;
  if (cached) {
    base = cached;
  } else {
    try {
      base = loadBundledSeed();
    } catch (e) {
      return {
        exitCode: writeEnvelope(
          fail('SEED_NOT_FOUND', e instanceof Error ? e.message : String(e), false),
          out,
        ),
      };
    }
  }

  const settings = loadModelsSettings(opts.forgeDir);
  const ttlDays = settings.ttl_days ?? DEFAULT_TTL_DAYS;
  // F3: canonicalize before pin-filtering so the read/JSON output is in a stable
  // host + id order regardless of how the on-disk cache/seed was authored.
  const { catalog, unknownPins } = applyPins(canonicalizeCatalog(base), settings.pinned);

  const ageMs = computeAgeMs(base.refreshed_at, now);
  const stale = ageMs > ttlDays * MS_PER_DAY;

  // R6: staleness nudge — read path ONLY, stderr ONLY, never on JSON stdout,
  // FORGE_QUIET-suppressible.
  if (stale && !quiet()) {
    err.write(
      `⚠ model catalog is stale (refreshed ${formatRelativeAge(ageMs)} ago, ttl ${ttlDays}d) — run /models to refresh\n`,
    );
  }
  // R1: warn (stderr) on unknown pins, FORGE_QUIET-suppressible.
  if (unknownPins.length > 0 && !quiet()) {
    const list = unknownPins.map((p) => `${p.host}:${p.id}`).join(', ');
    err.write(
      `⚠ settings.models.pinned references model ids not in the catalog (ignored): ${list}\n`,
    );
  }

  const data: ModelsReadData = {
    catalog,
    source,
    stale,
    age: formatRelativeAge(ageMs),
    unknown_pins: unknownPins,
  };
  if (json) return { exitCode: writeEnvelope(ok(data), out) };
  out.write(formatRead(data));
  return { exitCode: 0 };
}

// ── R4: --availability mode (async — computeAvailability probes are async) ────
// Computes the per-host availability set over the pinned catalog hosts using the
// production deps (real execa / process.env / existsSync / os.homedir) unless a
// test injects fakes through the options seam. Read-band: no writes, no model
// invocation / paid call (R5). The --availability + --refresh INVALID_ARGS guard
// is enforced in runOrchestrateModels before any file op.
export async function runOrchestrateModelsAvailability(
  opts: OrchestrateModelsOptions,
): Promise<OrchestrateModelsResult> {
  const out = opts.stdout ?? process.stdout;
  const json = opts.json === true;

  if (opts.refresh) {
    return {
      exitCode: writeEnvelope(
        fail(
          'INVALID_ARGS',
          'forge orchestrate models: --availability and --refresh are mutually exclusive.',
          false,
        ),
        out,
      ),
    };
  }

  const betaOptIn = loadCursorBetaOptIn(opts.forgeDir);
  const availability: AvailabilitySet = await computeAvailability(CATALOG_HOSTS, {
    exec: opts.exec ?? (execa as unknown as ExecaLike),
    getEnv: opts.getEnv ?? ((n: string) => process.env[n]),
    fileExists: opts.fileExists ?? ((p: string) => existsSync(p)),
    homeDir: opts.homeDir ?? homedir(),
    betaOptIn,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const data: ModelsAvailabilityData = { availability };
  if (json) return { exitCode: writeEnvelope(ok(data), out) };
  out.write(formatAvailability(data));
  return { exitCode: 0 };
}

function formatAvailability(d: ModelsAvailabilityData): string {
  const lines: string[] = ['Host availability:'];
  for (const host of CATALOG_HOSTS) {
    const a = d.availability[host];
    if (!a) continue;
    if (a.available) {
      lines.push(`  ${host}: available`);
    } else {
      lines.push(`  ${host}: unavailable — ${a.reasons.join('; ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

function formatRead(d: ModelsReadData): string {
  const lines: string[] = [];
  lines.push(
    `Model catalog (source: ${d.source}${d.stale ? ', STALE' : ''}, refreshed ${d.age} ago)`,
  );
  for (const [host, hc] of Object.entries(d.catalog.hosts)) {
    if (!hc) continue;
    lines.push(`  ${host}:`);
    for (const m of hc.models) {
      lines.push(`    [${m.tier}] ${m.id}`);
    }
  }
  if (d.unknown_pins.length > 0) {
    lines.push('  (unknown pins ignored: ' + d.unknown_pins.map((p) => `${p.host}:${p.id}`).join(', ') + ')');
  }
  return lines.join('\n') + '\n';
}

function formatRefresh(d: ModelsRefreshData): string {
  const lines: string[] = [`Wrote ${d.path}`];
  const { added, removed, retiered } = d.diff;
  if (added.length === 0 && removed.length === 0 && retiered.length === 0) {
    lines.push('  (no changes vs prior cache)');
  }
  for (const a of added) lines.push(`  + ${a.host}:${a.id} (${a.tier})`);
  for (const r of removed) lines.push(`  - ${r.host}:${r.id}`);
  for (const t of retiered) lines.push(`  ~ ${t.host}:${t.id} ${t.from} → ${t.to}`);
  return lines.join('\n') + '\n';
}

export const modelsHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Read the model catalog + staleness; --availability probes per-host reachability; --refresh --file <json> validates + writes .forge/models-catalog.json.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const file = parseFlag(rest, 'file');
    const refresh = hasFlag(rest, 'refresh');
    const availability = hasFlag(rest, 'availability');
    const json = hasFlag(rest, 'json');
    // R4: --availability runs through the async prober path. The
    // --availability + --refresh INVALID_ARGS combo is rejected there (and in
    // runOrchestrateModels) before any file op.
    if (availability) {
      return runOrchestrateModelsAvailability({ forgeDir, json, refresh });
    }
    return runOrchestrateModels({
      forgeDir,
      json,
      refresh,
      ...(file ? { file } : {}),
    });
  },
};
