// FORGE-213: model availability probing + warn-downgrade resolver.
//
// The thin "is this host reachable RIGHT NOW" filter between the catalog
// (FORGE-212) and the route (FORGE-210). This module ships the PRIMITIVE:
//   - `computeAvailability` — per-host reachability, matching each host's REAL
//     dispatch path (R1), via cheap probes only.
//   - `resolveAvailableModel` — a PURE warn-downgrade resolver over the catalog
//     filtered by availability.
//
// SAFETY (R5): availability is determined by `<bin> --version` (exitCode 0),
// env-var reads, and a cheap file-exists check ONLY. There is NEVER a model
// invocation or a paid API call. The claude CLI is NEVER probed — claude is
// dispatched via the in-session subagent callback (Task tool), so its signal is
// the `CLAUDE_CODE` env var, exactly as `ClaudeHarness.healthCheck` uses it.
//
// Router consumption (filter the catalog through availability; warn-downgrade at
// dispatch; enforced-spawn fail-fast) is FORGE-210, which composes
// effectiveModelTier (211) + catalog (212) + this module (213).

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execa } from 'execa';

import type { ExecaLike } from '../cli/init/validate.ts';
import { HOST_CLI_BIN, probeBinVersion, DEFAULT_PROBE_TIMEOUT_MS } from './host-probe.ts';
import { MODEL_TIERS, type ModelTier } from '../schemas/phases.ts';
import {
  CATALOG_HOSTS,
  type CatalogHost,
  type ModelsCatalog,
} from '../schemas/models-catalog.ts';

// ── Availability set ──────────────────────────────────────────────────────────
export interface HostAvailability {
  readonly available: boolean;
  // Every failing gate, in check order. Empty when available. A gated /
  // unconfigured host is `available: false` with a reason — NOT an error.
  readonly reasons: string[];
}
export type AvailabilitySet = Record<CatalogHost, HostAvailability>;

export interface AvailabilityDeps {
  readonly exec: ExecaLike;
  readonly getEnv: (name: string) => string | undefined;
  readonly fileExists: (path: string) => boolean;
  // Resolved home directory — injected for tests; production uses os.homedir().
  // NEVER a literal '~' (which the fs layer does not expand).
  readonly homeDir: string;
  // settings.agents.cursor_host_beta_opt_in — cursor is unreachable unless true.
  readonly betaOptIn: boolean;
  readonly timeoutMs?: number;
}

// Per-host reachability matching the REAL dispatch path (R1). Each host is
// probed independently; a host can be unavailable for several reasons at once
// (reasons accumulate). Nothing here throws on a gated/missing host.
export async function computeAvailability(
  hosts: readonly CatalogHost[],
  deps: AvailabilityDeps,
): Promise<AvailabilitySet> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const entries = await Promise.all(
    hosts.map(async (host): Promise<[CatalogHost, HostAvailability]> => {
      const reasons: string[] = [];

      switch (host) {
        case 'claude': {
          // Dispatched via the in-session subagent callback (Task tool), NOT the
          // `claude` CLI. Do NOT probe `claude --version` — that would falsely
          // mark claude unavailable in a perfectly valid in-session dispatch.
          if (!deps.getEnv('CLAUDE_CODE')) {
            reasons.push('not in a Claude Code session (CLAUDE_CODE unset)');
          }
          break;
        }
        case 'codex': {
          // Dispatched via `codex exec`. Reachable iff the CLI is present AND a
          // codex auth file exists. Do NOT rely on OPENAI_API_KEY —
          // spawnSubprocess strips it from the dispatch env.
          const binOk = await probeBinVersion(HOST_CLI_BIN.codex, deps.exec, timeoutMs);
          if (!binOk) reasons.push('codex CLI not found');
          // homeDir from the injected dep / os.homedir() — never a literal '~'.
          const authPath = join(deps.homeDir, '.codex', 'auth.json');
          if (!deps.fileExists(authPath)) {
            reasons.push('no codex auth (~/.codex/auth.json)');
          }
          break;
        }
        case 'gemini': {
          // Dispatched via the `gemini` CLI behind the experimental gate. There
          // is NO checkable Google credential in the codebase, so bin + gate is
          // the honest signal (do not invent a fake cred).
          const binOk = await probeBinVersion(HOST_CLI_BIN.gemini, deps.exec, timeoutMs);
          if (!binOk) reasons.push('gemini CLI not found');
          if (deps.getEnv('FORGE_GEMINI_EXPERIMENTAL') !== '1') {
            reasons.push('gemini experimental gate closed (FORGE_GEMINI_EXPERIMENTAL=1)');
          }
          break;
        }
        case 'cursor': {
          // Dispatched via the `agent` CLI behind beta opt-in. Beta gate first
          // (a closed gate is the headline reason), then bin, then key.
          if (deps.betaOptIn !== true) {
            reasons.push('beta gate closed (agents.cursor_host_beta_opt_in)');
          }
          const binOk = await probeBinVersion(HOST_CLI_BIN.cursor, deps.exec, timeoutMs);
          if (!binOk) reasons.push('agent CLI not found');
          const key = deps.getEnv('CURSOR_API_KEY');
          if (!key || key.length === 0) reasons.push('CURSOR_API_KEY unset');
          break;
        }
      }

      return [host, { available: reasons.length === 0, reasons }];
    }),
  );

  const set = {} as AvailabilitySet;
  for (const [host, avail] of entries) set[host] = avail;
  return set;
}

// Production deps — real execa / process.env / existsSync / os.homedir.
export function defaultAvailabilityDeps(betaOptIn: boolean): AvailabilityDeps {
  return {
    exec: execa as unknown as ExecaLike,
    getEnv: (n: string) => process.env[n],
    fileExists: (p: string) => existsSync(p),
    homeDir: homedir(),
    betaOptIn,
  };
}

// ── Warn-downgrade resolver (PURE) ────────────────────────────────────────────
export interface ResolvedModel {
  readonly host: CatalogHost;
  readonly model: string;
  readonly tier: ModelTier;
  readonly downgraded: boolean;
  readonly warning?: string;
}
export interface UnavailableResolution {
  readonly unavailable: true;
  readonly reason: string;
}
export type ResolveResult = ResolvedModel | UnavailableResolution;

// Pick a reachable model for `desiredTier`:
//   - prefer the LOWEST tier that is >= desiredTier (exact, else auto-upgrade);
//   - if nothing reachable is >= desiredTier, downgrade to the HIGHEST reachable
//     tier below it, ALWAYS attaching a `warning` (R3);
//   - nothing reachable at all → { unavailable: true }.
// Deterministic: hosts iterated in CATALOG_HOSTS order, models by sorted id (R3).
// Defensive: validates desiredTier AND every catalog model's tier before any
// index math — throws loudly on an unknown tier (mirrors effectiveModelTier).
export function resolveAvailableModel(
  catalog: ModelsCatalog,
  availability: AvailabilitySet,
  desiredTier: ModelTier,
): ResolveResult {
  const desiredIdx = MODEL_TIERS.indexOf(desiredTier);
  if (desiredIdx < 0) {
    throw new Error(
      `resolveAvailableModel: unknown desiredTier '${String(desiredTier)}' (valid: ${MODEL_TIERS.join(', ')})`,
    );
  }

  // Validate EVERY catalog model's tier up front — across ALL hosts, regardless
  // of availability. A corrupt/stale catalog (an unknown tier slipped past a
  // cast) must fail loud immediately, not lurk on an unavailable host until it
  // comes up and silently mis-routes. (The 212 schema enforces this at parse
  // time; this guards the exported pure helper against hand-built/cast inputs.)
  for (const host of CATALOG_HOSTS) {
    const hc = catalog.hosts[host];
    if (!hc) continue;
    for (const m of hc.models) {
      if (MODEL_TIERS.indexOf(m.tier) < 0) {
        throw new Error(
          `resolveAvailableModel: catalog model '${host}:${m.id}' has unknown tier '${String(m.tier)}' (valid: ${MODEL_TIERS.join(', ')})`,
        );
      }
    }
  }

  // A candidate reachable model, already tier-validated.
  interface Candidate {
    readonly host: CatalogHost;
    readonly id: string;
    readonly tier: ModelTier;
    readonly tierIdx: number;
  }
  const candidates: Candidate[] = [];

  for (const host of CATALOG_HOSTS) {
    const hostCatalog = catalog.hosts[host];
    if (!hostCatalog) continue;
    // Only AVAILABLE hosts contribute candidates. A host absent from the
    // availability set is treated as unavailable (defensive).
    if (!availability[host]?.available) continue;

    const sorted = [...hostCatalog.models].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const m of sorted) {
      // tier already validated ≥0 by the up-front pre-pass.
      candidates.push({ host, id: m.id, tier: m.tier, tierIdx: MODEL_TIERS.indexOf(m.tier) });
    }
  }

  if (candidates.length === 0) {
    return { unavailable: true, reason: 'no reachable host has any catalog models' };
  }

  // At-or-above the floor: pick the LOWEST such tier (exact preferred, else the
  // cheapest auto-upgrade), breaking ties by CATALOG_HOSTS order then sorted id
  // (candidates are already in that order, so the first match wins).
  const atOrAbove = candidates.filter((c) => c.tierIdx >= desiredIdx);
  if (atOrAbove.length > 0) {
    let best = atOrAbove[0]!;
    for (const c of atOrAbove) {
      if (c.tierIdx < best.tierIdx) best = c;
    }
    return {
      host: best.host,
      model: best.id,
      tier: best.tier,
      downgraded: false,
    };
  }

  // Nothing >= floor reachable → downgrade to the HIGHEST reachable tier below
  // it, with a loud warning (R3: ALWAYS warn when returned tier < floor).
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.tierIdx > best.tierIdx) best = c;
  }
  return {
    host: best.host,
    model: best.id,
    tier: best.tier,
    downgraded: true,
    warning: `no model ≥ ${desiredTier} reachable; downgraded to ${best.tier} on ${best.host}`,
  };
}
