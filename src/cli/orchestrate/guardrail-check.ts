// `forge orchestrate guardrail-check --path <p>` — worker preflight before
// writing to a path. The verb reads `agents.preflight_globs` from settings
// and returns whether the proposed write touches an architectural surface.
//
// Enforcement model: this is NOT a mechanical interception of the host's
// file-write tools (forge has no PreToolUse hook into Claude Task or Codex
// subagents). It is prompt-discipline + audit:
//
//   1. The worker prompt (templates/worker-prompt.template.md) instructs
//      every worker to call this verb before any write.
//   2. When `--task` + `--attempt` are supplied, the verb appends a
//      `guardrail_checked` event to the attempt log. A future ticket
//      (FORGE-FOLLOWUP-A) will have `forge orchestrate complete`
//      cross-reference verdict's `files_changed` against this event
//      stream and mark `verdict_unverified` if a guardrail write
//      occurred without a prior check.
//
// Read-band: the verb itself does not mutate state-machine tasks. The event
// append is best-effort and only happens when caller identity (task +
// attempt + lease) can be resolved.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import {
  resolveRepoRelative,
  matchPreflight,
  type PreflightResult,
} from '../../orchestrator/preflight.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { leaseFilePath, validateIdSegment } from '../../orchestrator/questions/paths.ts';
import { parseLeaseFile, type Lease } from '../../schemas/lease.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { resolveLogRotateMaxBytes } from './log-rotate-settings.ts';
import type { VerbHandler } from './index.ts';

export interface GuardrailCheckArgs {
  readonly path: string;
  readonly forgeDir: string;
  readonly cwd: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly json?: boolean;
}

// FORGE-65: the verb's result shape is the preflight library's result shape.
// Kept as a named alias so existing importers of GuardrailCheckResult are
// unaffected by the extraction into src/orchestrator/preflight.ts.
export type GuardrailCheckResult = PreflightResult;

const MAX_PATH_LEN = 1024;

export function runGuardrailCheck(args: GuardrailCheckArgs): {
  exitCode: number;
  data?: GuardrailCheckResult;
} {
  const json = args.json ?? false;

  if (!args.path) {
    return { exitCode: emit(fail('INVALID_ARGS', '--path is required', false), { json }) };
  }
  if (args.path.length > MAX_PATH_LEN) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', `--path exceeds ${MAX_PATH_LEN} bytes`, false),
        { json },
      ),
    };
  }

  // RepoRoot convention mirrors spec-diff.ts: dirname(forgeDir).
  // Resolve containment BEFORE loading settings: an out-of-repo / symlink-escape
  // path must be refused with INVALID_ARGS regardless of settings.yaml state
  // (Codex 2nd-pass: loading settings first let a bad settings.yaml mask the
  // OUTSIDE_REPO rejection with SETTINGS_LOAD_ERROR).
  const repoRoot = path.dirname(args.forgeDir);
  const resolved = resolveRepoRelative(repoRoot, args.cwd, args.path);
  if ('error' in resolved) {
    // The response envelope intentionally does NOT echo the resolved path —
    // that would leak the repoRoot's depth in the filesystem to envelope
    // readers (security-auditor on FORGE-97).
    return {
      exitCode: emit(
        fail('INVALID_ARGS', 'path resolves outside the repository (after symlink resolution)', false),
        { json },
      ),
    };
  }

  // Load settings. preflight_globs has a schema default, so a missing field
  // expands to the standard list.
  let preflightGlobs: readonly string[];
  try {
    const settings = loadSettings(path.join(args.forgeDir, 'settings.yaml'));
    preflightGlobs = settings.agents.preflight_globs;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: emit(fail('SETTINGS_LOAD_ERROR', msg, true), { json }),
    };
  }

  const outcome = matchPreflight(resolved.relative, preflightGlobs);
  if (outcome.kind === 'invalid_glob') {
    return {
      exitCode: emit(
        fail('INVALID_GLOB', outcome.message, false, { glob: outcome.glob }),
        { json },
      ),
    };
  }

  const result = outcome.result;

  // Best-effort event append. Only happens when caller identity is known.
  if (args.taskId && args.attemptId) {
    appendGuardrailEvent({
      forgeDir: args.forgeDir,
      taskId: args.taskId,
      attemptId: args.attemptId,
      result,
    });
  }

  return {
    exitCode: emit(ok(result), { json }),
    data: result,
  };
}

function appendGuardrailEvent(args: {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  result: GuardrailCheckResult;
}): void {
  // Validate taskId + attemptId BEFORE constructing any filesystem path —
  // security-auditor on FORGE-97 flagged HIGH: an unsanitized taskId like
  // "../../../etc" would otherwise probe arbitrary FS locations via the
  // `existsSync` / `readFileSync` calls below.
  try {
    validateIdSegment(args.taskId, 'taskId');
    validateIdSegment(args.attemptId, 'attemptId');
  } catch {
    // Invalid id — skip event emission entirely. The caller already
    // surfaced the result; this is a best-effort audit append.
    return;
  }

  // Resolve lease to recover caller identity via the validated path helper.
  // If the lease is missing or invalid, silently skip the event — by design,
  // workers may legitimately call this verb outside an active attempt (e.g.
  // interactive use). The verb still returns the architectural verdict.
  let leasePath: string;
  try {
    leasePath = leaseFilePath(args.forgeDir, args.taskId);
  } catch {
    return;
  }
  if (!existsSync(leasePath)) return;
  let lease: Lease;
  try {
    const raw = readFileSync(leasePath, 'utf8');
    const parsed = parseLeaseFile(JSON.parse(raw));
    // FORGE-231: tombstone (released) or invalid → no active lease to record.
    if (parsed.kind !== 'active') return;
    lease = parsed.lease;
  } catch {
    return;
  }

  try {
    appendAttemptEvent(
      {
        type: 'guardrail_checked',
        ts: new Date().toISOString(),
        path: args.result.path,
        matched_glob: args.result.matched_glob,
        suggested_decision_key: args.result.suggested_decision_key,
      },
      {
        forgeDir: args.forgeDir,
        taskId: args.taskId,
        attemptId: args.attemptId,
        caller: {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
        logRotateMaxBytes: resolveLogRotateMaxBytes(args.forgeDir),
      },
    );
  } catch (e) {
    // Audit event is best-effort, but a failure to write deserves a stderr
    // warning so operators see the signal — CLAUDE.md "no silent catches"
    // (code-reviewer on FORGE-97). The verb itself already returned success;
    // we don't change its exit code.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `guardrail-check: failed to append guardrail_checked event for task ${args.taskId}: ${msg}\n`,
    );
  }
}

export const guardrailCheckHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Check whether a path falls under agents.preflight_globs (worker preflight).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const targetPath = parseFlag(rest, 'path') ?? '';
    const taskId = parseFlag(rest, 'task');
    const attemptId = parseFlag(rest, 'attempt');
    const json = hasFlag(rest, 'json');
    const result = runGuardrailCheck({
      path: targetPath,
      forgeDir,
      cwd: opts.cwd,
      ...(taskId ? { taskId } : {}),
      ...(attemptId ? { attemptId } : {}),
      json,
    });
    return { exitCode: result.exitCode };
  },
};
