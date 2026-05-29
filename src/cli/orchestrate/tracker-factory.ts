// Construct a Tracker instance from settings.yaml for claim/dispatch/heartbeat.
//
// The orchestrate CLI verbs only need a narrow slice of the Tracker interface:
// claim(), releaseClaim(), and setClaimFence(). For test environments (and
// adopters that haven't configured a tracker yet), the binary may run without a
// real tracker — in that case, callers get a NoopTracker that always succeeds.
//
// Activate the noop path via:
//   - settings.yaml missing entirely (bootstrap mode)
//   - FORGE_NOOP_TRACKER=1 env var (test mode)
//
// Production setups configure tracker.type in settings.yaml and the factory
// instantiates the matching adapter (Linear/GitHub/Notion) via createTracker.
// Notion spawns an MCP child process, so resolveTrackerForCLI returns an
// optional `close` the caller MUST invoke in a finally (see claim.ts/cancel.ts).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import type { ClaimFenceData } from '../../trackers/claim-fence.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import { GitHubTracker } from '../../trackers/github.ts';
import { LinearTracker } from '../../trackers/linear.ts';
import { NotionTracker } from '../../trackers/notion.ts';
import {
  createStdioMcpCall,
  type StdioMcpHandle,
} from '../../trackers/notion-mcp-transport.ts';
import type { Settings } from '../../schemas/settings.ts';
import type { ClaimResult } from '../../trackers/types.ts';

// The narrow slice of Tracker that claim/dispatch/heartbeat use. A full Tracker
// (real adapter) is structurally assignable to this.
export interface ClaimableTracker {
  readonly type: string;
  claim(issueId: string, runId: string): Promise<ClaimResult>;
  releaseClaim(issueId: string, runId: string): Promise<void>;
  setClaimFence(issueId: string, data: ClaimFenceData | null): Promise<void>;
}

export class NoopTracker implements ClaimableTracker {
  readonly type = 'noop';
  async claim(_issueId: string, _runId: string): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(_issueId: string, _runId: string): Promise<void> {
    // best-effort, nothing to release
  }
  async setClaimFence(
    _issueId: string,
    _data: ClaimFenceData | null,
  ): Promise<void> {
    // bootstrap/test mode — no tracker to mirror the claim onto
  }
}

// A constructed tracker plus an optional teardown. Notion spawns an MCP child
// process via createStdioMcpCall; `close` tears it down. Linear/GitHub leave
// `close` undefined. Callers MUST invoke `close` in a finally.
export interface TrackerHandle {
  readonly tracker: Tracker;
  readonly close?: () => Promise<void>;
}

// Threat model for createTracker:
//
// settings.yaml is treated as TRUSTED EXECUTABLE CONFIG (same trust level as
// package.json scripts or a Makefile). The Notion launcher accepts an
// arbitrary `mcp_command` because that's the customization point for users
// who want a different Notion MCP server build/version. An earlier review
// suggested allowlisting `mcp_command[0]` to {npx, node}, but Codex 2nd-pass
// pointed out that `node -e '...'` or `npx -y <attacker-pkg>` are still
// arbitrary code execution — argv[0] is not a meaningful boundary. So
// allowlisting was security theater.
//
// Honest mitigation: settings.yaml must be repo-tracked and review-gated
// (branch protection, CODEOWNERS). The same applies to package.json, Makefile,
// and any other dev-time config that names a binary forge will run. CI
// systems that allow PR contributors to mutate settings.yaml without review
// have a broader trust-model issue that this allowlist would not have
// resolved either.
export function createTracker(settings: Settings, logger: Logger): TrackerHandle {
  const t = settings.tracker;
  switch (t.type) {
    case 'linear':
      return { tracker: new LinearTracker(t, logger) };
    case 'github':
      return { tracker: new GitHubTracker(t, logger) };
    case 'notion': {
      const [command, ...args] = t.config.mcp_command;
      if (!command) {
        throw new Error('notion tracker: mcp_command must be non-empty');
      }
      const handle: StdioMcpHandle = createStdioMcpCall({
        command,
        args,
        env: t.config.mcp_env,
      });
      return {
        tracker: new NotionTracker(t, logger, { mcp: handle.call }),
        close: () => handle.close(),
      };
    }
    default: {
      const exhaustive: never = t;
      throw new Error(`unreachable tracker type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Silent logger for CLI tracker construction. Claim/cancel call setClaimFence
// best-effort and surface their own warnings via the verb's logger, so the
// adapter-internal retry chatter stays quiet here.
function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

export type TrackerLookupResult =
  | { ok: true; tracker: ClaimableTracker; close?: () => Promise<void> }
  | {
      ok: false;
      code: 'NO_TRACKER_CONFIGURED' | 'TRACKER_INIT_FAILED';
      message: string;
    };

export function resolveTrackerForCLI(forgeDir: string): TrackerLookupResult {
  if (process.env.FORGE_NOOP_TRACKER === '1') {
    return { ok: true, tracker: new NoopTracker() };
  }
  const settingsPath = path.join(forgeDir, 'settings.yaml');
  if (!existsSync(settingsPath)) {
    // Bootstrap mode — projects without a tracker can still exercise the
    // local state machine. NoopTracker keeps claim/dispatch usable.
    //
    // Codex 2nd-pass: emit a visible warning so the silent fallback can't
    // be mistaken for a real tracker claim. Suppressed in test/JSON paths
    // by setting FORGE_NOOP_TRACKER=1 (which takes the explicit branch above).
    process.stderr.write(
      'warning: no .forge/settings.yaml found — claim/dispatch using NoopTracker (no tracker mutation). ' +
        'Configure tracker.type in settings.yaml for production use, or set FORGE_NOOP_TRACKER=1 to silence.\n',
    );
    return { ok: true, tracker: new NoopTracker() };
  }
  try {
    const settings = loadSettings(settingsPath);
    const handle = createTracker(settings, silentLogger());
    return { ok: true, tracker: handle.tracker, close: handle.close };
  } catch (err) {
    return {
      ok: false,
      code: 'TRACKER_INIT_FAILED',
      message: `failed to construct tracker from settings.yaml: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
