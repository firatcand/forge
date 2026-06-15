// FORGE-200 (Loom I1): the memory-backend factory.
//
// Switches on `memory.backend` from settings. I1 ships ONE variant (`local`).
// The async signature mirrors openLocalBackend (sqlite is lazy-imported inside
// openDb), and adding a remote variant (Athena) later is purely additive — a new
// case here plus a new discriminated-union member in MemorySchema.

import type { Memory } from '../schemas/settings.ts';
import { openLocalBackend } from './local/backend.ts';
import type { MemoryBackend } from './types.ts';

export async function createBackend(memory: Memory, dbPath: string): Promise<MemoryBackend> {
  switch (memory.backend) {
    case 'local':
      return openLocalBackend(dbPath);
    default: {
      // Exhaustiveness guard: a new union member without a case here is a
      // compile error. At runtime, fail loudly rather than silently no-op.
      const exhaustive: never = memory.backend;
      throw new Error(`loom: unsupported memory backend: ${String(exhaustive)}`);
    }
  }
}
