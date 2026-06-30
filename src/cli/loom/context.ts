// FORGE-200 (Loom I1): shared resolution for the loom verbs.
//
// Resolves the repo root + canonical loom.db path (worktree → main checkout),
// reads the memory-backend selector from settings best-effort (degrading to the
// local default when settings.yaml is absent/invalid — mirrors audit's
// loadAuditConfig posture), and opens the backend through the factory.
//
// FORGE-228: when the remote (neon) backend is selected, the connection string is
// loaded from the MAIN-CHECKOUT .forge/.env (loom resolves repoRoot via
// git-common-dir, but the startup loadForgeEnv runs from cwd — so a worktree /
// subdir invocation would otherwise miss it).

import path from 'node:path';

import { loadForgeEnv } from '../../core/forge-env.ts';
import { loadSettings } from '../../core/settings.ts';
import { backendExists, createBackend } from '../../memory/factory.ts';
import { resolveLoomDbPath, resolveRepoRoot } from '../../memory/paths.ts';
import { redactDsn } from '../../memory/remote/backend.ts';
import type { Memory } from '../../schemas/settings.ts';
import type { MemoryBackend } from '../../memory/types.ts';
import { existsSync } from 'node:fs';

export interface LoomContext {
  readonly cwd: string;
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly memory: Memory;
  // FORGE-228: human-facing store location for `db_path` output + warnings. local
  // → the loom.db file path; neon → a redacted `postgres://host/db` (never a DSN).
  // Keeps recall/query/traverse/reindex consistent with status()/doctor().
  readonly location: string;
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

  // FORGE-228: seed the neon connection string from the main-checkout .forge/.env
  // (no-override + allowlisted; an already-set env wins). Local backend needs no
  // credential, so only do this for neon.
  let location = dbPath;
  if (memory.backend === 'neon') {
    loadForgeEnv(repoRoot, (m) => warnings.push(m));
    const dsn = process.env.NEON_DATABASE_URL;
    location = dsn && dsn.trim() !== '' ? redactDsn(dsn) : 'postgres:NEON_DATABASE_URL';
  }

  return { cwd, repoRoot, dbPath, memory, location, warnings };
}

// Open the backend for the resolved context. Throws on open failure — callers
// decide whether that is soft (recall/status on a missing db) or fatal.
export async function resolveBackend(ctx: LoomContext): Promise<MemoryBackend> {
  return createBackend(ctx.memory, ctx.dbPath);
}

// FORGE-228: does the backing store already exist, WITHOUT creating it? recall /
// status / query / traverse / doctor fail SOFT (empty result + warning) when it
// does not, rather than bootstrapping an empty store and crashing. local → the
// loom.db file; neon → the schema table is reachable (a neon misconfig throws
// loud rather than masquerading as an empty graph).
export async function dbExists(ctx: LoomContext): Promise<boolean> {
  return backendExists(ctx.memory, ctx.dbPath);
}
