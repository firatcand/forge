import type { Logger, Tracker } from './base.ts';
import { GitHubTracker } from './github.ts';
import { LinearTracker } from './linear.ts';
import { NotionTracker } from './notion.ts';
import { createStdioMcpCall, type StdioMcpHandle } from './notion-mcp-transport.ts';
import type { Settings } from '../schemas/settings.ts';

export interface TrackerHandle {
  readonly tracker: Tracker;
  // Present only for transports that spawn a child process (Notion MCP). The
  // caller is contractually required to await close() in a finally block.
  readonly close?: () => Promise<void>;
}

// Threat model: settings.yaml is TRUSTED EXECUTABLE CONFIG (same trust level as
// package.json scripts or a Makefile). The Notion launcher accepts an arbitrary
// `mcp_command` because that's the customization point for users running a
// different Notion MCP server build. Allowlisting argv[0] is security theater
// (`node -e` / `npx -y <pkg>` are still arbitrary code execution); the honest
// mitigation is that settings.yaml must be repo-tracked + review-gated.
//
// Extracted from reconcile.ts under FORGE-95 so apply-decision can construct a
// tracker without duplicating the Notion MCP wiring (which FORGE-117 rewrites).
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

// Whether `updateIssueBody` is implemented for this tracker. Notion's is a
// NOT_IMPLEMENTED stub until FORGE-117 lands the `ntn` transport; apply-decision
// preflights this so it fails BEFORE any local mutation rather than half-applying.
// FORGE-117: flip to always-true once NotionTracker.updateIssueBody ships.
export function trackerSupportsBodyMutation(tracker: Pick<Tracker, 'type'>): boolean {
  return tracker.type !== 'notion';
}
