// FORGE-200 (Loom I1) / FORGE-228 (Loom I4): the memory-backend factory.
//
// Switches on `memory.backend` from settings. `local` (SQLite WAL+FTS5) is the
// default; `neon` (FORGE-228) is the opt-in remote Postgres backend. The async
// signature mirrors openLocalBackend (the sqlite/pg drivers are lazy-imported
// inside the backend so a non-loom / local-default invocation never loads them).

import { existsSync } from 'node:fs';

import type { Memory } from '../schemas/settings.ts';
import { openLocalBackend } from './local/backend.ts';
import { openRemoteBackend, remoteExists } from './remote/backend.ts';
import type { MemoryBackend } from './types.ts';

export async function createBackend(memory: Memory, dbPath: string): Promise<MemoryBackend> {
  switch (memory.backend) {
    case 'local':
      return openLocalBackend(dbPath);
    case 'neon':
      return openRemoteBackend(memory, dbPath);
    default: {
      // Exhaustiveness guard: a new union member without a case here is a
      // compile error. At runtime, fail loudly rather than silently no-op.
      const exhaustive: never = memory;
      throw new Error(`loom: unsupported memory backend: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// FORGE-228: non-creating existence probe. Replaces the SQLite-file-only check so
// recall/status/query/traverse/doctor can soft-fail on an unbuilt graph WITHOUT
// the side effect of creating/bootstrapping the store. local → loom.db present;
// neon → schema table reachable (connect read-only; misconfig throws loud).
export async function backendExists(memory: Memory, dbPath: string): Promise<boolean> {
  switch (memory.backend) {
    case 'local':
      return existsSync(dbPath);
    case 'neon':
      return remoteExists();
    default: {
      const exhaustive: never = memory;
      throw new Error(`loom: unsupported memory backend: ${JSON.stringify(exhaustive)}`);
    }
  }
}
