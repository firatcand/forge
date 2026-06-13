// `forge orchestrate review-queue` — read-only list of tasks sitting in
// ready_for_review (FORGE-185). Surfaces what is waiting for a review pass:
// task id, title + write_globs (joined from the LOCAL phases.yaml cache),
// the current attempt id, and whether a lease is still held.
//
// Read band: no lease, no tracker mutation, no state write. Best-effort,
// non-atomic snapshot — files may change mid-read. The shared state-dir scanner
// (collectTasksByState) already skips corrupt / schema-invalid / hostile-named
// entries, so a single bad state.json never poisons the queue.

import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadPhases, resolvePhasesYaml } from '../../core/phases.ts';
import { PhasesError } from '../../core/errors.ts';
import type { Task } from '../../schemas/phases.ts';
import { collectTasksByState } from '../../orchestrator/readiness.ts';
import { leaseFilePath } from '../../orchestrator/questions/paths.ts';
import { LeaseSchema } from '../../schemas/lease.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

// Per-file read cap — mirrors dashboard.ts / status.ts. .forge files are
// treated as untrusted input.
const FILE_MAX_BYTES = 1 * 1024 * 1024;

// Local capped JSON reader (idiom copied from dashboard.ts collectTaskRows).
function readJsonCapped(filePath: string): unknown | undefined {
  let raw: string;
  try {
    const s = statSync(filePath);
    if (!s.isFile() || s.size > FILE_MAX_BYTES) return undefined;
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export interface ReviewQueueTask {
  readonly task_id: string;
  readonly title: string;
  readonly write_globs: readonly string[];
  readonly current_attempt_id: string | null;
  readonly lease_present: boolean;
}

export interface OrchestrateReviewQueueOptions {
  readonly forgeDir: string;
  readonly json?: boolean;
  // Injectable streams so PassThrough fixtures can capture output (precedent:
  // dashboard.ts / questions.ts). Defaults to process.stdout / process.stderr.
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface OrchestrateReviewQueueResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

// Index phases tasks by both phases id and tracker id so a state.json keyed by
// either resolves the same title/write_globs (mirrors collectActiveAttempts).
function indexTasks(
  flat: ReadonlyArray<{ task: Task }>,
): Map<string, Task> {
  const byId = new Map<string, Task>();
  for (const { task } of flat) {
    byId.set(task.id, task);
    if (task.tracker_issue_id) byId.set(task.tracker_issue_id, task);
  }
  return byId;
}

function leasePresent(forgeDir: string, taskId: string): boolean {
  try {
    return LeaseSchema.safeParse(readJsonCapped(leaseFilePath(forgeDir, taskId))).success;
  } catch {
    // A bad lease path / read must never crash the queue (R4).
    return false;
  }
}

export function runOrchestrateReviewQueue(
  opts: OrchestrateReviewQueueOptions,
): OrchestrateReviewQueueResult {
  const out = opts.stdout ?? process.stdout;
  const json = opts.json === true;

  // Load phases from the LOCAL cache (idiom copied from dashboard.ts): a missing
  // phases.yaml degrades gracefully to an empty queue; only a genuine
  // parse/schema error is surfaced as a failure.
  const cwd = dirname(opts.forgeDir);
  const phasesPath = resolvePhasesYaml(cwd);
  let flat: { task: Task }[] = [];
  if (phasesPath) {
    try {
      const { phases } = loadPhases(phasesPath);
      flat = phases.phases.flatMap((ph) => ph.tasks.map((task) => ({ task })));
    } catch (err) {
      if (err instanceof PhasesError && err.code === 'FILE_NOT_FOUND') {
        // Treat a race-deleted file the same as "no phases" — empty queue.
      } else if (err instanceof PhasesError && err.code === 'SCHEMA_INVALID') {
        return {
          exitCode: writeEnvelope(fail('SCHEMA_INVALID', err.message, false), out),
        };
      } else {
        return {
          exitCode: writeEnvelope(
            fail('IO_ERROR', err instanceof Error ? err.message : String(err), false),
            out,
          ),
        };
      }
    }
  }
  const byId = indexTasks(flat);

  const tasks: ReviewQueueTask[] = collectTasksByState(
    opts.forgeDir,
    (s) => s === 'ready_for_review',
  ).map((scan) => {
    const task = byId.get(scan.taskId) ?? byId.get(scan.record.task_id);
    return {
      task_id: scan.taskId,
      title: task?.title ?? '',
      write_globs: task?.write_globs ?? [],
      current_attempt_id: scan.record.current_attempt_id,
      lease_present: leasePresent(opts.forgeDir, scan.taskId),
    };
  });

  if (json) {
    return { exitCode: writeEnvelope(ok({ tasks }), out) };
  }

  if (tasks.length === 0) {
    out.write('No tasks awaiting review.\n');
    return { exitCode: 0 };
  }
  const lines: string[] = [];
  for (const t of tasks) {
    lines.push(`${t.task_id}${t.title ? ` — ${t.title}` : ''}`);
    lines.push(`  attempt: ${t.current_attempt_id ?? '(none)'}   lease: ${t.lease_present ? 'held' : 'released'}`);
    if (t.write_globs.length > 0) lines.push(`  write_globs: ${t.write_globs.join(', ')}`);
  }
  out.write(lines.join('\n') + '\n');
  return { exitCode: 0 };
}

export const reviewQueueHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List tasks awaiting review (state ready_for_review) with attempt + lease info.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    return runOrchestrateReviewQueue({ forgeDir, json: hasFlag(rest, 'json') });
  },
};
