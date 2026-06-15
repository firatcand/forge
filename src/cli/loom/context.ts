// FORGE-200 (Loom I1): shared resolution for the loom verbs.
//
// Resolves the repo root + canonical loom.db path (worktree → main checkout),
// reads the memory-backend selector from settings best-effort (degrading to the
// local default when settings.yaml is absent/invalid — mirrors audit's
// loadAuditConfig posture), and opens the backend through the factory.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import { createBackend } from '../../memory/factory.ts';
import { resolveLoomDbPath, resolveRepoRoot } from '../../memory/paths.ts';
import type { Memory } from '../../schemas/settings.ts';
import type { MemoryBackend } from '../../memory/types.ts';

export interface LoomContext {
  readonly cwd: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly memory: Memory;
  readonly warnings: string[];
}

const DEFAULT_MEMORY: Memory = { backend: 'local' };

export function resolveContext(cwd: string): LoomContext {
  const repoRoot = resolveRepoRoot(cwd);
  const dbPath = resolveLoomDbPath(cwd);
  const warnings: string[] = [];

  // Best-effort settings read: the memory block defaults to local, so a missing
  // settings.yaml is fine. Only surface a warning on an UNEXPECTED load failure
  // (a present-but-invalid file), not on a plain absent file.
  let memory: Memory = DEFAULT_MEMORY;
  const settingsPath = path.join(repoRoot, '.forge', 'settings.yaml');
  if (existsSync(settingsPath)) {
    try {
      const settings = loadSettings(settingsPath);
      memory = settings.memory;
    } catch (err) {
      warnings.push(
        `settings.yaml present but unreadable (${err instanceof Error ? err.message : String(err)}); using default memory backend 'local'`,
      );
    }
  }

  return { cwd, repoRoot, dbPath, memory, warnings };
}

// Open the backend for the resolved context. Throws on open failure — callers
// decide whether that is soft (recall/status on a missing db) or fatal.
export async function resolveBackend(ctx: LoomContext): Promise<MemoryBackend> {
  return createBackend(ctx.memory, ctx.dbPath);
}

// Does the loom.db file already exist? recall/status fail SOFT (empty result +
// warning) when it does not, rather than creating an empty db and crashing.
export function dbExists(ctx: LoomContext): boolean {
  return existsSync(ctx.dbPath);
}
