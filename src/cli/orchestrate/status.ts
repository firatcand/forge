import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isNodeFsError } from '../../orchestrator/questions/errors.ts';
import { detectCheapDivergences, type GcCheapWarning } from './gc.ts';

// state.json cap — 1MB. This is larger than QUESTION_FILE_MAX_BYTES (64KB)
// because state.json grows with worker count × tasks. Per ORCHESTRATOR.md
// §"Security posture" all .forge file reads are treated as untrusted, so we
// keep an explicit cap even though the dispatcher (trusted writer) produces
// this file.
const STATE_FILE_MAX_BYTES = 1 * 1024 * 1024;

export interface OrchestrateStatusOptions {
  readonly runId?: string;
  readonly forgeDir: string;
  // FORGE-149: emit a stable JSON envelope on stdout instead of the text summary.
  readonly json?: boolean;
  // FORGE-149: include the auto-gc cheap-divergence warnings in the JSON data.
  readonly includeWarnings?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface OrchestrateStatusResult {
  readonly exitCode: number;
}

function pickLatestRun(orchestratorDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(orchestratorDir);
  } catch (err) {
    if (isNodeFsError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  const runs: string[] = [];
  for (const entry of entries) {
    try {
      if (statSync(join(orchestratorDir, entry)).isDirectory()) {
        runs.push(entry);
      }
    } catch {
      // Skip entries that vanish mid-listing.
    }
  }
  if (runs.length === 0) return null;
  // UUIDv7-prefixed run ids sort lexicographically into chronological order
  // (per ORCHESTRATOR.md). We pick the latest descending.
  runs.sort();
  return runs[runs.length - 1] ?? null;
}

function formatStateSummary(runId: string, state: Record<string, unknown>): string {
  const lines = [`Run: ${runId}`];
  if (typeof state['started_at'] === 'string') {
    lines.push(`Started: ${state['started_at']}`);
  }
  if (typeof state['pid'] === 'number') {
    lines.push(`PID: ${state['pid']}`);
  }
  const workers = state['workers'];
  if (Array.isArray(workers)) {
    const counts = new Map<string, number>();
    for (const w of workers) {
      if (w && typeof w === 'object') {
        const status = (w as Record<string, unknown>)['status'];
        const key = typeof status === 'string' ? status : 'unknown';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    lines.push(`Workers: ${workers.length}`);
    const sortedStatus = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [status, count] of sortedStatus) {
      lines.push(`  ${status}: ${count}`);
    }
  } else if (workers && typeof workers === 'object') {
    const keys = Object.keys(workers as Record<string, unknown>);
    lines.push(`Workers: ${keys.length}`);
  }
  return lines.join('\n') + '\n';
}

// FORGE-149: structured projection that mirrors EXACTLY what formatStateSummary
// prints today — run id, started_at, pid, and the per-status worker counts.
// Deliberately NOT a new schema (no per-task entries): the JSON envelope is a
// machine-readable mirror of the existing text snapshot, nothing more.
// FORGE-149: the JSON projection MIRRORS the text formatter's sparseness. The
// text path omits "Started:"/"PID:" lines when the keys are absent (or the wrong
// type) in state, and omits the per-status worker breakdown when `workers` is
// object-shaped (uncountable per-status). The JSON envelope must match: optional
// keys are OMITTED ENTIRELY rather than emitted as null — no null-emitting.
interface StatusData {
  readonly run_id: string;
  readonly started_at?: string;
  readonly pid?: number;
  readonly worker_count: number;
  readonly worker_status_counts?: Record<string, number>;
  readonly warnings?: readonly GcCheapWarning[];
}

function buildStatusData(runId: string, state: Record<string, unknown>): StatusData {
  const startedAt = typeof state['started_at'] === 'string' ? state['started_at'] : undefined;
  const pid = typeof state['pid'] === 'number' ? state['pid'] : undefined;
  const workers = state['workers'];
  let workerCount = 0;
  // Present ONLY when workers is array-shaped (the text path's per-status loop).
  // When workers is object-shaped the text formatter prints just the count, so
  // the JSON omits worker_status_counts entirely (mirroring that path).
  let counts: Record<string, number> | undefined;
  if (Array.isArray(workers)) {
    workerCount = workers.length;
    counts = {};
    for (const w of workers) {
      if (w && typeof w === 'object') {
        const status = (w as Record<string, unknown>)['status'];
        const key = typeof status === 'string' ? status : 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  } else if (workers && typeof workers === 'object') {
    workerCount = Object.keys(workers as Record<string, unknown>).length;
  }
  return {
    run_id: runId,
    ...(startedAt !== undefined ? { started_at: startedAt } : {}),
    ...(pid !== undefined ? { pid } : {}),
    worker_count: workerCount,
    ...(counts !== undefined ? { worker_status_counts: counts } : {}),
  };
}

export function runOrchestrateStatus(
  opts: OrchestrateStatusOptions,
): OrchestrateStatusResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const orchestratorDir = join(opts.forgeDir, 'orchestrator');

  // Cheap auto-gc detect-and-warn (FORGE-22). Detect-only; warnings to stderr in
  // ALL modes (back-compat). FORGE-149: the returned array also feeds --json
  // --include-warnings.
  const cheapWarnings = detectCheapDivergences(opts.forgeDir, err, new Date());

  let runId = opts.runId;
  if (!runId) {
    try {
      const latest = pickLatestRun(orchestratorDir);
      if (!latest) {
        err.write(`forge orchestrate status: no runs found in ${orchestratorDir}\n`);
        return { exitCode: 1 };
      }
      runId = latest;
    } catch (e) {
      err.write(
        `forge orchestrate status: failed to read ${orchestratorDir}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return { exitCode: 1 };
    }
  }

  const statePath = join(orchestratorDir, runId, 'state.json');

  let isDir = false;
  try {
    const s = statSync(statePath);
    isDir = s.isDirectory();
    if (s.size > STATE_FILE_MAX_BYTES) {
      err.write(
        `forge orchestrate status: ${statePath} exceeds ${STATE_FILE_MAX_BYTES} bytes\n`,
      );
      return { exitCode: 1 };
    }
  } catch (e) {
    if (isNodeFsError(e) && e.code === 'ENOENT') {
      err.write(`forge orchestrate status: state file not found: ${statePath}\n`);
      return { exitCode: 1 };
    }
    err.write(
      `forge orchestrate status: failed to stat ${statePath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  if (isDir) {
    err.write(`forge orchestrate status: ${statePath} is a directory\n`);
    return { exitCode: 1 };
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch (e) {
    err.write(
      `forge orchestrate status: failed to read ${statePath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  if (Buffer.byteLength(raw, 'utf8') > STATE_FILE_MAX_BYTES) {
    err.write(
      `forge orchestrate status: ${statePath} exceeds ${STATE_FILE_MAX_BYTES} bytes\n`,
    );
    return { exitCode: 1 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    err.write(
      `forge orchestrate status: ${statePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { exitCode: 1 };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    err.write(`forge orchestrate status: ${statePath} is not a JSON object\n`);
    return { exitCode: 1 };
  }
  const state = parsed as Record<string, unknown>;
  if (opts.json) {
    // FORGE-149: stable ok envelope mirroring the text snapshot fields. The
    // warnings array rides along only when --include-warnings is set.
    const data: StatusData = {
      ...buildStatusData(runId, state),
      ...(opts.includeWarnings ? { warnings: cheapWarnings } : {}),
    };
    out.write(`${JSON.stringify({ ok: true, data })}\n`);
    return { exitCode: 0 };
  }
  out.write(formatStateSummary(runId, state));
  return { exitCode: 0 };
}
