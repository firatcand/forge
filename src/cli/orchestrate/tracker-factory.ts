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
// Since FORGE-117 every adapter is CLI/SDK-backed (no child processes), so
// `close` is always undefined; the optional teardown hook is kept on
// TrackerHandle for interface stability (callers already tolerate undefined).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import type { ClaimFenceData } from '../../trackers/claim-fence.ts';
import type { Logger, Tracker } from '../../trackers/base.ts';
import { GitHubTracker } from '../../trackers/github.ts';
import { LinearTracker } from '../../trackers/linear.ts';
import { NotionTracker, defaultNtnExec } from '../../trackers/notion.ts';
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

// A constructed tracker plus an optional teardown. Since FORGE-117 no adapter
// spawns a child process, so `close` is always undefined — the hook is kept
// for interface stability (callers already invoke it conditionally).
export interface TrackerHandle {
  readonly tracker: Tracker;
  readonly close?: () => Promise<void>;
}

// Threat model for createTracker: settings.yaml is treated as TRUSTED
// EXECUTABLE CONFIG (same trust level as package.json scripts or a Makefile)
// and must be repo-tracked and review-gated (branch protection, CODEOWNERS).
// Since FORGE-117 no tracker config field names a binary to launch — the
// Notion adapter shells out to the fixed `ntn` CLI on PATH exactly like the
// GitHub adapter shells out to `gh`. The deprecated mcp_command/mcp_env
// fields are accepted by the schema but IGNORED (warned below); they are
// removed for real in v0.5.
export function createTracker(settings: Settings, logger: Logger): TrackerHandle {
  const t = settings.tracker;
  switch (t.type) {
    case 'linear':
      return { tracker: new LinearTracker(t, logger) };
    case 'github':
      return { tracker: new GitHubTracker(t, logger) };
    case 'notion': {
      if (
        t.config.mcp_command !== undefined ||
        t.config.mcp_env !== undefined
      ) {
        process.stderr.write(
          'warning: tracker.config.mcp_command / mcp_env are deprecated and ignored — NotionTracker uses the `ntn` CLI since FORGE-117; remove them from .forge/settings.yaml (the fields will be rejected in v0.5).\n',
        );
      }
      return { tracker: new NotionTracker(t, logger, { ntn: defaultNtnExec }) };
    }
    default: {
      const exhaustive: never = t;
      throw new Error(`unreachable tracker type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Whether `updateIssueBody` is implemented for this tracker. Historically
// Notion's was a NOT_IMPLEMENTED stub; FORGE-117 shipped the `ntn`-backed
// implementation, so every adapter now supports body mutation. The preflight
// hook is kept (apply-decision still calls it) so a future incapable adapter
// fails BEFORE any local mutation rather than half-applying.
export function trackerSupportsBodyMutation(_tracker: Pick<Tracker, 'type'>): boolean {
  return true;
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
  } catch {
    // Do NOT interpolate err.message: loadSettings/zod errors embed the
    // absolute settings.yaml path + raw issue list, which would leak into the
    // CLI JSON envelope on stdout (FORGE-167 review: security-auditor M1).
    return {
      ok: false,
      code: 'TRACKER_INIT_FAILED',
      message:
        'failed to construct tracker from .forge/settings.yaml (check tracker.type + config)',
    };
  }
}
