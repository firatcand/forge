// FORGE-210 (R4): the shared effective-catalog loader.
//
// BOTH `forge orchestrate models` (read mode) AND `forge orchestrate route`
// must see the SAME catalog after the same cache→seed→canonicalize→applyPins
// pipeline — otherwise the router could route to a model the `models` read
// view never shows (or vice-versa). This module is the single source of that
// pipeline so the two verbs cannot diverge in seed lookup, validation,
// canonical host/id order, or pin filtering.
//
// Determinism boundary (R6): given a fixed on-disk cache (or, cold, the bundled
// seed) and fixed settings.models.pinned, this returns a byte-stable catalog.
// It performs NO availability probing — that is the caller's (route's) job via
// the FORGE-213 availability module, which reads live host state and is NOT
// replay-deterministic across changing host state.

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ModelsCatalogSchema,
  CATALOG_HOSTS,
  type ModelsCatalog,
  type CatalogHost,
} from '../schemas/models-catalog.ts';
import type { Models } from '../schemas/settings.ts';

// On-disk catalog files are treated as untrusted input — size-capped before
// read (mirrors models.ts / dashboard.ts FILE_MAX_BYTES).
const FILE_MAX_BYTES = 1 * 1024 * 1024;
const CATALOG_FILENAME = 'models-catalog.json';

// ── F3: canonicalization — determinism boundary ──────────────────────────────
// An agent-authored cache/seed may carry hosts and models in arbitrary
// key/array order. Canonicalize so a semantically-identical catalog always
// yields a stable host + id order: hosts ordered by CATALOG_HOSTS, models within
// each host sorted by id. Returns a NEW catalog (no mutation of the input).
export function canonicalizeCatalog(catalog: ModelsCatalog): ModelsCatalog {
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

// ── R1: applyPins — pure per-host allow-list FILTER over the catalog ──────────
// `pinned[host]` (when set) restricts a host to ONLY those cached model ids:
//   - keeps models whose id ∈ pins[host];
//   - a host with NO pin entry → unchanged (full list);
//   - a pinned id NOT present in the catalog → dropped + recorded in unknownPins.
// Tiers/sources stay authoritative in the catalog — the pin never re-specifies a
// model. Returns a NEW catalog (no mutation of the input).
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
    // Record pins that name a model the catalog doesn't have.
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

// ── Seed cold-start loader (5-level import.meta.url walk; mirrors
// src/cli/upgrade/template-loader.ts locateContextTemplate) ───────────────────
function loadBundledSeed(): ModelsCatalog {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: src/orchestrator/ → ../../templates/. Bundled: dist/ → ../templates/.
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
        `loadEffectiveCatalog: bundled seed at ${candidate} failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
  throw new Error(
    'loadEffectiveCatalog: templates/models-catalog.seed.json not found in bundle',
  );
}

export interface EffectiveCatalogResult {
  readonly catalog: ModelsCatalog;
  // 'cache' when the on-disk .forge/models-catalog.json was read; 'seed' when
  // we cold-started from the bundled seed.
  readonly source: 'cache' | 'seed';
  readonly unknownPins: UnknownPin[];
}

// The single, shared cache→seed→canonicalize→applyPins pipeline. Throws only
// when BOTH the cache is absent/unreadable AND the bundled seed cannot be found
// or fails schema validation (a packaging bug, not adopter input).
export function loadEffectiveCatalog(
  forgeDir: string,
  settings: { models: Models },
): EffectiveCatalogResult {
  const catalogPath = join(forgeDir, CATALOG_FILENAME);
  const cached = loadCache(catalogPath);
  const source: 'cache' | 'seed' = cached ? 'cache' : 'seed';
  const base = cached ?? loadBundledSeed();
  // Canonicalize BEFORE pin-filtering so the host + id order is stable
  // regardless of how the on-disk cache/seed was authored.
  const { catalog, unknownPins } = applyPins(canonicalizeCatalog(base), settings.models.pinned);
  return { catalog, source, unknownPins };
}
