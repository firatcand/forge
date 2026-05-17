import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isNodeFsError } from '../../orchestrator/questions/errors.ts';

// state.json cap — 1MB. This is larger than QUESTION_FILE_MAX_BYTES (64KB)
// because state.json grows with worker count × tasks. Per ORCHESTRATOR.md
// §"Security posture" all .forge file reads are treated as untrusted, so we
// keep an explicit cap even though the dispatcher (trusted writer) produces
// this file.
const STATE_FILE_MAX_BYTES = 1 * 1024 * 1024;

export interface OrchestrateStatusOptions {
  readonly runId?: string;
  readonly forgeDir: string;
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

export function runOrchestrateStatus(
  opts: OrchestrateStatusOptions,
): OrchestrateStatusResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const orchestratorDir = join(opts.forgeDir, 'orchestrator');

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
  out.write(formatStateSummary(runId, parsed as Record<string, unknown>));
  return { exitCode: 0 };
}
