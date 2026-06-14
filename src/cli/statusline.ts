// FORGE-197: `forge statusline` — the display-only parked-decision badge.
//
// Designed to be wired into a host's status line (Claude Code's
// `statusLine: { type: 'command', command: 'forge statusline' }`), which runs
// the command frequently. So this is SYNC and CHEAP: it scans only
// `<forgeDir>/orchestrator/tasks/<id>/state.json` (via collectTasksByState) for
// `blocked_on_question` tasks — no phases.yaml, no settings, no tracker.
//
// Output contract (R5 — silent outside a forge repo):
//   - NOT a forge repo (the orchestrator tasks root is ABSENT) → exit 0, NO
//     stdout. The host's status line then shows nothing — Forge does not
//     announce itself in a directory it does not manage.
//   - A DETECTED forge repo with zero parked tasks → `forge ◇ 0`.
//   - N > 0 parked tasks → `forge ◆ N to answer`.
//
// Never crashes: a missing/empty/corrupt `.forge` degrades to absent (silent).
// Read-only; always exits 0.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveForgeDir } from './orchestrate/flags.ts';
import { collectTasksByState } from '../orchestrator/readiness.ts';

export interface StatuslineOptions {
  readonly cwd: string;
  readonly rest: readonly string[];
  readonly stdout?: NodeJS.WritableStream;
}

export interface StatuslineResult {
  readonly exitCode: number;
}

/**
 * Entry point for `forge statusline`. Always exits 0 (a status line that errors
 * would corrupt the host's prompt). Writes to an injectable stream so tests can
 * capture output without patching process.stdout.
 */
export function runStatusline(opts: StatuslineOptions): StatuslineResult {
  const out = opts.stdout ?? process.stdout;
  const forgeDir = resolveForgeDir(opts.rest, opts.cwd);

  // R5: silent outside a forge repo. The orchestrator tasks root is the marker
  // that this is a forge-managed, orchestrated project. collectTasksByState
  // also returns [] when the dir is absent, but it cannot distinguish
  // "not a forge repo" from "forge repo, zero parked tasks" — and those want
  // DIFFERENT output (nothing vs `◇ 0`). So probe the tasks root explicitly.
  const tasksRoot = join(forgeDir, 'orchestrator', 'tasks');
  let isForgeRepo: boolean;
  try {
    isForgeRepo = existsSync(tasksRoot);
  } catch {
    isForgeRepo = false;
  }
  if (!isForgeRepo) {
    return { exitCode: 0 };
  }

  let parked = 0;
  try {
    parked = collectTasksByState(forgeDir, (s) => s === 'blocked_on_question').length;
  } catch {
    // Defensive — collectTasksByState is already tolerant (missing/corrupt →
    // []), but never let the status line throw.
    parked = 0;
  }

  if (parked > 0) {
    out.write(`forge ◆ ${parked} to answer\n`);
  } else {
    out.write('forge ◇ 0\n');
  }
  return { exitCode: 0 };
}
