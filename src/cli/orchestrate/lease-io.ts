import { readFileSync } from 'node:fs';

import { OrchestratorError } from '../../core/errors.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { leaseFilePath } from '../../orchestrator/questions/paths.ts';
import type { StateCaller } from '../../orchestrator/state-machine.ts';

export function readLease(forgeDir: string, taskId: string): Lease {
  const path = leaseFilePath(forgeDir, taskId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path },
    );
  }
  const parsed = LeaseSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `lease.json schema invalid for task ${taskId}`,
      { taskId, zodError: parsed.error.message },
    );
  }
  return parsed.data;
}

export function callerFromLease(lease: Lease): StateCaller {
  return {
    run_id: lease.owner_run_id,
    claim_id: lease.claim_id,
    generation: lease.generation,
  };
}
