// `forge orchestrate heartbeat` — renew lease + first-heartbeat state hop.
//
// Wraps leases.heartbeat() to extend expires_at. If the task state is
// 'dispatched', transitions to 'running' (first heartbeat); otherwise the
// state is left untouched (subsequent heartbeats are pure lease renewal).
//
// Returns LEASE_STOLEN envelope (retriable=false) when generation has moved.

import path from 'node:path';

import { HeartbeatArgsSchema, type HeartbeatArgs } from '../../schemas/cli-args.ts';
import { OrchestratorError } from '../../core/errors.ts';
import {
  heartbeat as renewLease,
} from '../../orchestrator/leases.ts';
import {
  readTaskState,
  writeTaskState,
} from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { readFileSync } from 'node:fs';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export async function runOrchestrateHeartbeat(
  args: HeartbeatArgs,
): Promise<{ exitCode: number }> {
  const parsed = HeartbeatArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // Read attempt manifest to recover (run_id, claim_id, generation).
  let lease: Lease;
  try {
    lease = readLease(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }
  if (lease.attempt_id !== null && lease.attempt_id !== opts.attemptId) {
    // The lease records the most recent attempt for accounting; we let the
    // ownership check below be authoritative. Surface a soft warning by way
    // of the envelope details only on failure paths.
  }

  // Lease renewal: caller identity from the lease record.
  let renewed: Lease;
  try {
    renewed = renewLease({
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      caller: {
        run_id: lease.owner_run_id,
        claim_id: lease.claim_id,
        generation: lease.generation,
      },
    });
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'LEASE_STOLEN') {
      return {
        exitCode: emit(
          fail('LEASE_STOLEN', err.message, false, err.details),
          { json: opts.json },
        ),
      };
    }
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          true,
        ),
        { json: opts.json },
      ),
    };
  }

  // First-heartbeat state hop: dispatched → running.
  let firstHeartbeat = false;
  try {
    const state = readTaskState(opts.forgeDir, opts.taskId);
    if (state.state === 'dispatched') {
      writeTaskState(
        opts.forgeDir,
        {
          ...state,
          state: 'running',
          state_version: state.state_version + 1,
          updated_at: new Date().toISOString(),
          updated_by: {
            run_id: renewed.owner_run_id,
            claim_id: renewed.claim_id,
            generation: renewed.generation,
          },
        },
        {
          run_id: renewed.owner_run_id,
          claim_id: renewed.claim_id,
          generation: renewed.generation,
        },
      );
      firstHeartbeat = true;
    }
  } catch (err) {
    // State read/write failures don't undo the lease renewal — gc reconciles.
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          true,
          { hint: 'lease renewed but state transition failed — run forge orchestrate gc' },
        ),
        { json: opts.json },
      ),
    };
  }

  // Append the heartbeat event for audit.
  try {
    appendAttemptEvent(
      {
        type: 'heartbeat',
        ts: new Date().toISOString(),
        lease_expires_at: renewed.expires_at,
      },
      {
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        attemptId: opts.attemptId,
        caller: {
          run_id: renewed.owner_run_id,
          claim_id: renewed.claim_id,
          generation: renewed.generation,
        },
      },
    );
  } catch {
    // Best-effort event audit; lease renewal succeeded.
  }

  return {
    exitCode: emit(
      ok({
        claim_id: renewed.claim_id,
        generation: renewed.generation,
        expires_at: renewed.expires_at,
        first_heartbeat: firstHeartbeat,
      }),
      { json: opts.json },
    ),
  };
}

function readLease(forgeDir: string, taskId: string): Lease {
  const leasePath = path.join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json');
  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: leasePath },
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

export const heartbeatHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Renew the lease (and on first call, transition dispatched → running).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const json = hasFlag(rest, 'json');
    return runOrchestrateHeartbeat({
      taskId,
      attemptId,
      forgeDir,
      json,
    });
  },
};
