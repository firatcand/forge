// `forge orchestrate event` — worker appends to events.jsonl.
//
// Pure event-write, no state transition. Used by workers to checkpoint
// arbitrary progress that the CLI itself can't observe (e.g., shell sequences,
// drift detection). The event type is open-string at the CLI layer — the
// AttemptEventSchema enforces the legal discriminated union when validating.
//
// Spec: `event accepts --type drift with --data JSON payload`.

import { EventArgsSchema, type EventArgs } from '../../schemas/cli-args.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import type { Lease } from '../../schemas/lease.ts';
import { AttemptEventSchema, type AttemptEvent } from '../../schemas/attempt.ts';
import { OrchestratorError } from '../../core/errors.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { resolveLogRotateMaxBytes } from './log-rotate-settings.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import type { VerbHandler } from './index.ts';

export async function runOrchestrateEvent(args: EventArgs): Promise<{ exitCode: number }> {
  const parsed = EventArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // Read lease to recover caller identity.
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

  // Construct the event record. The schema is a discriminated union — but most
  // worker-emitted events (drift, worktree_inspected) need fields beyond ts.
  // For 'drift' we fold the --data payload into a generic shape; the
  // AttemptEventSchema rejects unknown discriminator values, so workers must
  // pass a recognized type.
  const ts = new Date().toISOString();
  const eventRecord = buildEventRecord(opts.type, ts, opts.data ?? {});
  const validation = AttemptEventSchema.safeParse(eventRecord);
  if (!validation.success) {
    return {
      exitCode: emit(
        fail(
          'INVALID_EVENT',
          `event failed schema validation: ${validation.error.message}`,
          false,
          { type: opts.type },
        ),
        { json: opts.json },
      ),
    };
  }

  try {
    appendAttemptEvent(validation.data, {
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      attemptId: opts.attemptId,
      caller: callerFromLease(lease),
      logRotateMaxBytes: resolveLogRotateMaxBytes(opts.forgeDir),
    });
  } catch (err) {
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

  return { exitCode: emit(ok({ appended: true, type: opts.type }), { json: opts.json }) };
}

function buildEventRecord(
  type: string,
  ts: string,
  data: Record<string, unknown>,
): AttemptEvent | Record<string, unknown> {
  // The schema is a discriminated union — `type` must match a legal literal.
  // The caller supplies the type-specific fields via --data.
  return { type, ts, ...data } as AttemptEvent;
}

export const eventHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Append an event to the attempt log (accepts --type drift with --data JSON).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const type = parseFlag(rest, 'type') ?? '';
    const dataRaw = parseFlag(rest, 'data');
    let data: Record<string, unknown> | undefined;
    if (dataRaw) {
      try {
        const parsedData = JSON.parse(dataRaw);
        if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
          data = parsedData as Record<string, unknown>;
        }
      } catch {
        // Surface the parse error from the schema layer for consistency.
      }
    }
    const json = hasFlag(rest, 'json');
    return runOrchestrateEvent({
      taskId,
      attemptId,
      type,
      ...(data ? { data } : {}),
      forgeDir,
      json,
    });
  },
};
