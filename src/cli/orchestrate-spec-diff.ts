// `forge orchestrate spec-diff <task_id>` — reads the lease for the task, then
// prints an informational block if commits touching spec/ have landed since
// the claim's stamped spec_revision. Silent on empty diff.
//
// This is the surface that the future dispatch skill (P2.5-T07 / FORGE-98)
// invokes when rendering the worker prompt on resume. Per
// spec/ORCHESTRATOR.md §Write-surface contract, skills never read .forge/
// directly — they go through CLI verbs. This verb is purely read-side.

import { dirname } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { isNodeFsError } from '../orchestrator/questions/errors.ts';
import { leaseFilePath } from '../orchestrator/questions/paths.ts';
import { LeaseSchema } from '../schemas/lease.ts';
import {
  computeSpecDiffSinceClaim,
  type SpecDiffNotification,
} from '../orchestrator/spec-diff.ts';

const LEASE_FILE_MAX_BYTES = 64 * 1024; // 64 KiB — leases are small

export interface OrchestrateSpecDiffOptions {
  readonly taskId: string;
  readonly forgeDir: string;
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

  const validation = LeaseSchema.safeParse(parsedJson);
  if (!validation.success) {
    const msg = `lease schema validation failed: ${validation.error.message}`;
    if (json) writeJson(err, { ok: false, error: { code: 'SCHEMA_INVALID', message: msg } });
    else err.write(`forge orchestrate spec-diff: ${msg}\n`);
    return { exitCode: 1 };
  }

  const lease = validation.data;
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
