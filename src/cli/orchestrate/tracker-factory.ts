// Construct a Tracker instance from settings.yaml for claim/dispatch/heartbeat.
//
// The orchestrate CLI verbs only need a narrow slice of the Tracker interface:
// claim() and releaseClaim(). For test environments (and adopters that haven't
// configured a tracker yet), the binary may run without a real tracker — in
// that case, callers get a NoopTracker that always succeeds.
//
// Activate the noop path via:
//   - settings.yaml missing entirely (bootstrap mode)
//   - FORGE_NOOP_TRACKER=1 env var (test mode)
//
// Production setups configure tracker.type in settings.yaml and the factory
// instantiates the matching adapter (Linear/GitHub/Notion). Construction of
// those adapters has runtime dependencies (gh CLI, MCP stdio); for now this
// file delegates with a clear NO_TRACKER_CONFIGURED error if construction is
// needed but not yet wired. Wiring lands with the dispatch skill rollout
// (FORGE-98).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import type { ClaimResult } from '../../trackers/types.ts';

// The narrow slice of Tracker that claim/dispatch/heartbeat use.
export interface ClaimableTracker {
  readonly type: string;
  claim(issueId: string, runId: string): Promise<ClaimResult>;
  releaseClaim(issueId: string, runId: string): Promise<void>;
}

export class NoopTracker implements ClaimableTracker {
  readonly type = 'noop';
  async claim(_issueId: string, _runId: string): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(_issueId: string, _runId: string): Promise<void> {
    // best-effort, nothing to release
  }
}

export type TrackerLookupResult =
  | { ok: true; tracker: ClaimableTracker }
  | { ok: false; code: 'NO_TRACKER_CONFIGURED' | 'TRACKER_INIT_FAILED'; message: string };

export function resolveTrackerForCLI(forgeDir: string): TrackerLookupResult {
  if (process.env.FORGE_NOOP_TRACKER === '1') {
    return { ok: true, tracker: new NoopTracker() };
  }
  const settingsPath = path.join(forgeDir, 'settings.yaml');
  if (!existsSync(settingsPath)) {
    // Bootstrap mode — projects without a tracker can still exercise the
    // local state machine. NoopTracker keeps claim/dispatch usable.
    return { ok: true, tracker: new NoopTracker() };
  }
  try {
    const settings = loadSettings(settingsPath);
    const trackerType = settings.tracker.type;
    // Wiring real tracker adapters from settings is deferred to FORGE-98 (dispatch
    // skill rollout). In v0.4, callers with a real tracker config get a clear
    // error so they don't think claim silently succeeded against a noop.
    return {
      ok: false,
      code: 'NO_TRACKER_CONFIGURED',
      message: `tracker.type='${trackerType}' is configured but production tracker construction lands with FORGE-98. Set FORGE_NOOP_TRACKER=1 to bypass for local dev / tests.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'TRACKER_INIT_FAILED',
      message: `failed to load settings.yaml: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
