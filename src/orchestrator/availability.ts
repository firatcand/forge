// Host-reachability preflight: "is this host reachable RIGHT NOW".
//
//   - `computeAvailability` — per-host reachability, matching each host's REAL
//     dispatch path, via cheap probes only.
//
// SAFETY: availability is determined by `<bin> --version` (exitCode 0),
// env-var reads, and a cheap file-exists check ONLY. There is NEVER a model
// invocation or a paid API call. The claude CLI is NEVER probed — claude is
// dispatched via the in-session subagent callback (Task tool), so its signal is
// the `CLAUDE_CODE` env var, exactly as `ClaudeHarness.healthCheck` uses it.

import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execa } from 'execa';

import type { ExecaLike } from '../cli/init/validate.ts';
import { HOST_CLI_BIN, probeBinVersion, DEFAULT_PROBE_TIMEOUT_MS } from './host-probe.ts';
import type { Host } from '../schemas/hosts.ts';

// ── Availability set ──────────────────────────────────────────────────────────
export interface HostAvailability {
  readonly available: boolean;
  // Every failing gate, in check order. Empty when available. A gated /
  // unconfigured host is `available: false` with a reason — NOT an error.
  readonly reasons: string[];
}
export type AvailabilitySet = Record<Host, HostAvailability>;

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
  hosts: readonly Host[],
  deps: AvailabilityDeps,
): Promise<AvailabilitySet> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const entries = await Promise.all(
    hosts.map(async (host): Promise<[Host, HostAvailability]> => {
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
