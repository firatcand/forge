import { readFileSync } from 'node:fs';

import { OrchestratorError } from '../../core/errors.ts';
import { parseLeaseFile, type Lease } from '../../schemas/lease.ts';
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
  const parsed = parseLeaseFile(JSON.parse(raw));
  if (parsed.kind === 'released') {
    // FORGE-231: the verbs served here require an ACTIVE lease; a tombstone
    // means the task is not claimed.
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease for task ${taskId} is released (tombstone) — task is not claimed`,
      { taskId },
    );
  }
  if (parsed.kind === 'invalid') {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `lease.json schema invalid for task ${taskId}`,
      { taskId, zodError: parsed.error },
    );
  }
  return parsed.lease;
}

export function callerFromLease(lease: Lease): StateCaller {
  return {
    run_id: lease.owner_run_id,
    claim_id: lease.claim_id,
    generation: lease.generation,
  };
}
