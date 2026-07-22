// `forge orchestrate spec-diff <task_id>` — reads the lease for the task, then
// prints an informational block if commits touching spec/ have landed since
// the claim's stamped spec_revision. Silent on empty diff.
//
// This is the surface that the future dispatch skill (P2.5-T07 / FORGE-98)
// invokes when rendering the worker prompt on resume. Per
// spec/ORCHESTRATOR.md §Write-surface contract, skills never read .forge/
// directly — they go through CLI verbs. This verb is purely read-side.

import { dirname } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isNodeFsError } from '../../orchestrator/questions/errors.ts';
import {
  leaseFilePath,
  stateFilePath,
  tasksRootDir,
} from '../../orchestrator/questions/paths.ts';
import { parseLeaseFile } from '../../schemas/lease.ts';
import { TaskStateSchema } from '../../schemas/task-state.ts';
import {
  computeSpecDiffSinceClaim,
  type SpecDiffNotification,
} from '../../orchestrator/spec-diff.ts';

const LEASE_FILE_MAX_BYTES = 64 * 1024; // 64 KiB — leases are small

// FORGE-164: states that count as ACTIVE for --all-active enumeration. A claim
// in any of these predates a spec/ change that could affect in-flight work — the
// signal we surface. blocked_on_question is INCLUDED (the worker is paused but
// still owns the task). Terminal/respawn-pending states are excluded.
const ACTIVE_STATES = new Set(['dispatched', 'running', 'blocked_on_question']);

// FORGE-164: one entry per active task whose claim predates a spec/ change.
export interface AllActiveSpecDiffEntry {
  readonly task_id: string;
  readonly commit_count: number;
  readonly files_affected: readonly string[];
  /** True when the active task's lease has expired (claim still predates the change). */
  readonly lease_expired: boolean;
}

export interface OrchestrateSpecDiffOptions {
  readonly taskId: string;
  readonly forgeDir: string;
  /**
   * FORGE-164: enumerate ALL active tasks (dispatched|running|blocked_on_question)
   * whose claim predates a spec/ change, instead of inspecting a single task.
   * When set, taskId is ignored.
   */
  readonly allActive?: boolean;
  /**
   * Working directory for git invocations and digest fallback walks. Defaults to
   * dirname(forgeDir). Trust boundary: this value is forwarded directly to
   * execa({ cwd }) and to filesystem walks — the caller is assumed to be the
   * authenticated local user. If this verb is ever exposed over a network/IPC
   * boundary, validate repoRoot stays inside the project root.
   */
  readonly repoRoot?: string;
  readonly json?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface OrchestrateSpecDiffResult {
  readonly exitCode: number;
}

interface JsonOk {
  readonly ok: true;
  readonly data: SpecDiffNotification | null;
}
interface JsonErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

function writeJson(stream: NodeJS.WritableStream, payload: JsonOk | JsonErr): void {
  stream.write(JSON.stringify(payload) + '\n');
}

export async function runOrchestrateSpecDiff(
  opts: OrchestrateSpecDiffOptions,
): Promise<OrchestrateSpecDiffResult> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const json = opts.json ?? false;
  const repoRoot = opts.repoRoot ?? dirname(opts.forgeDir);

  // FORGE-164: --all-active enumeration. Always exits 0 (strictly informational).
  if (opts.allActive) {
    return runAllActive({ ...opts, out, err, json, repoRoot });
  }

  if (!opts.taskId) {
    const msg = 'task_id is required (positional argument)';
    if (json) writeJson(err, { ok: false, error: { code: 'INVALID_ID', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }

  let leasePath: string;
  try {
    leasePath = leaseFilePath(opts.forgeDir, opts.taskId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) writeJson(err, { ok: false, error: { code: 'INVALID_ID', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }

  // Size guard before read, matching the pattern in orchestrate-status.
  try {
    const s = statSync(leasePath);
    if (s.isDirectory()) {
      const msg = `${leasePath} is a directory`;
      if (json) writeJson(err, { ok: false, error: { code: 'IO_ERROR', message: msg } });
      else err.write(`forge orchestrate spec-diff: ${msg}\n`);
      return { exitCode: 1 };
    }
    if (s.size > LEASE_FILE_MAX_BYTES) {
      const msg = `${leasePath} exceeds ${LEASE_FILE_MAX_BYTES} bytes`;
      if (json) writeJson(err, { ok: false, error: { code: 'IO_ERROR', message: msg } });
      else err.write(`forge orchestrate spec-diff: ${msg}\n`);
      return { exitCode: 1 };
    }
  } catch (e) {
    if (isNodeFsError(e) && e.code === 'ENOENT') {
      const msg = `lease not found for task ${opts.taskId}: ${leasePath}`;
      if (json) writeJson(err, { ok: false, error: { code: 'LEASE_NOT_FOUND', message: msg } });
      else err.write(`forge orchestrate spec-diff: ${msg}\n`);
      return { exitCode: 1 };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (json) writeJson(err, { ok: false, error: { code: 'IO_ERROR', message: msg } });
    else err.write(`forge orchestrate spec-diff: failed to stat ${leasePath}: ${msg}\n`);
    return { exitCode: 1 };
  }

  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (json) writeJson(err, { ok: false, error: { code: 'IO_ERROR', message: msg } });
    else err.write(`forge orchestrate spec-diff: failed to read ${leasePath}: ${msg}\n`);
    return { exitCode: 1 };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    const msg = `${leasePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    if (json) writeJson(err, { ok: false, error: { code: 'SCHEMA_INVALID', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }

  const validation = parseLeaseFile(parsedJson);
  if (validation.kind === 'released') {
    // FORGE-231: tombstone — the task is not claimed; there is no
    // claim-time spec revision to diff against.
    const msg = `lease for this task is released (tombstone) — task is not claimed`;
    if (json) writeJson(err, { ok: false, error: { code: 'LEASE_NOT_FOUND', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }
  if (validation.kind === 'invalid') {
    const msg = `lease schema validation failed: ${validation.error}`;
    if (json) writeJson(err, { ok: false, error: { code: 'SCHEMA_INVALID', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }

  const lease = validation.lease;
  const result = await computeSpecDiffSinceClaim(repoRoot, lease.spec_revision);

  if (json) {
    writeJson(out, { ok: true, data: result });
    return { exitCode: 0 };
  }

  if (result === null) {
    // silent — no diff to surface
    return { exitCode: 0 };
  }

  out.write(result.rendered + '\n');
  return { exitCode: 0 };
}

// FORGE-164: enumerate every active task whose claim predates a spec/ change.
//
// Walk .forge/orchestrator/tasks/<id>/, reading state.json + lease.json:
//   - state ∉ ACTIVE_STATES                 → skip (not in flight)
//   - state.json / lease.json missing       → skip (no active claim to inspect)
//   - corrupt lease/state (parse/schema)    → SKIP + one stderr note (never fail)
//   - EXPIRED lease                         → still inspected; lease_expired:true
//   - no spec diff since the claim          → omitted from the list
//   - spec diff present                     → { task_id, commit_count, files_affected, lease_expired }
//
// Always exits 0 (strictly informational — the push-time half of the FORGE-114
// SPEC-change mitigation). JSON: { ok:true, data: AllActiveSpecDiffEntry[] }.
async function runAllActive(args: {
  forgeDir: string;
  repoRoot: string;
  json: boolean;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}): Promise<OrchestrateSpecDiffResult> {
  const { forgeDir, repoRoot, json, out, err } = args;
  const entries: AllActiveSpecDiffEntry[] = [];

  let taskIds: string[];
  try {
    taskIds = readdirSync(tasksRootDir(forgeDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No tasks dir → empty list, exit 0.
    taskIds = [];
  }

  const now = Date.now();

  for (const taskId of taskIds) {
    // ── state.json: gate on ACTIVE state ──
    let statePath: string;
    let leasePath: string;
    try {
      statePath = stateFilePath(forgeDir, taskId);
      leasePath = leaseFilePath(forgeDir, taskId);
    } catch {
      // Invalid id segment (shouldn't happen for a real task dir) — skip quietly.
      continue;
    }

    const stateRaw = tryReadSmall(statePath);
    if (stateRaw === null) continue; // no state.json → not an active claim
    let stateParsed: unknown;
    try {
      stateParsed = JSON.parse(stateRaw);
    } catch {
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (state.json is not valid JSON)\n`);
      continue;
    }
    const stateValidation = TaskStateSchema.safeParse(stateParsed);
    if (!stateValidation.success) {
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (state.json failed schema validation)\n`);
      continue;
    }
    if (!ACTIVE_STATES.has(stateValidation.data.state)) continue;

    // ── lease.json: must exist + validate ──
    const leaseRaw = tryReadSmall(leasePath);
    if (leaseRaw === null) {
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (active state but no lease.json)\n`);
      continue;
    }
    let leaseParsed: unknown;
    try {
      leaseParsed = JSON.parse(leaseRaw);
    } catch {
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (lease.json is not valid JSON)\n`);
      continue;
    }
    const leaseValidation = parseLeaseFile(leaseParsed);
    if (leaseValidation.kind === 'released') {
      // FORGE-231: tombstone — active state but no active lease; report as such.
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (active state but lease is released)\n`);
      continue;
    }
    if (leaseValidation.kind === 'invalid') {
      err.write(`forge orchestrate spec-diff --all-active: skipping ${taskId} (lease.json failed schema validation)\n`);
      continue;
    }
    const lease = leaseValidation.lease;
    const leaseExpired = Date.parse(lease.expires_at) < now;

    // ── compute the diff since the stamped claim revision ──
    const diff = await computeSpecDiffSinceClaim(repoRoot, lease.spec_revision);
    if (diff === null) continue; // no-diff tasks omitted

    entries.push({
      task_id: taskId,
      commit_count: diff.commitCount,
      files_affected: diff.filesAffected,
      lease_expired: leaseExpired,
    });
  }

  if (json) {
    writeJsonAllActive(out, entries);
    return { exitCode: 0 };
  }

  if (entries.length === 0) {
    out.write('No active tasks have spec/ changes since they were claimed.\n');
    return { exitCode: 0 };
  }

  for (const e of entries) {
    const files = e.files_affected.length > 0 ? e.files_affected.join(', ') : 'spec/';
    const expired = e.lease_expired ? ' [lease expired]' : '';
    out.write(`${e.task_id}: ${e.commit_count} spec commit(s) affecting ${files}${expired}\n`);
  }
  return { exitCode: 0 };
}

/** Read a small file (lease/state-sized), returning null on absence/oversize/IO error. */
function tryReadSmall(p: string): string | null {
  try {
    const s = statSync(p);
    if (s.isDirectory() || s.size > LEASE_FILE_MAX_BYTES) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeJsonAllActive(
  stream: NodeJS.WritableStream,
  data: readonly AllActiveSpecDiffEntry[],
): void {
  stream.write(JSON.stringify({ ok: true, data }) + '\n');
}
