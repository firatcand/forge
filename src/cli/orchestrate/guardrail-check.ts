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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import { matchAny, InvalidGlobError } from '../../orchestrator/glob-match.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { leaseFilePath, validateIdSegment } from '../../orchestrator/questions/paths.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface GuardrailCheckArgs {
  readonly path: string;
  readonly forgeDir: string;
  readonly cwd: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly json?: boolean;
}

export interface GuardrailCheckResult {
  readonly architectural: boolean;
  readonly path: string;
  readonly matched_glob: string | null;
  readonly suggested_decision_key: string | null;
}

const MAX_PATH_LEN = 1024;

function slugify(s: string): string {
  // Lowercase, replace non-[a-z0-9.-_] with '-', collapse repeats, trim.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function suggestDecisionKey(matchedGlob: string, relativePath: string): string {
  // Stable key: `guardrail:<glob>:<basename>`. The basename anchors the key
  // per-file so two writes to the same guardrail glob don't dedupe against
  // each other.
  const base = path.basename(relativePath);
  return `guardrail:${slugify(matchedGlob)}:${slugify(base)}`;
}

/**
 * Resolve `cwd + targetPath` to a repo-relative path, refusing anything that
 * escapes the repoRoot — including via symlinks. Returns `null` when the
 * target is outside the repo (caller treats as `INVALID_ARGS`).
 *
 * Security-auditor + Codex review on FORGE-97: lexical containment via
 * `path.relative` is insufficient. A symlinked file inside the repo pointing
 * to `/etc/passwd` would otherwise be classified as non-architectural; a
 * relative path like `../../etc/passwd` would surface its traversal depth in
 * the response envelope.
 */
function resolveRepoRelative(
  repoRoot: string,
  cwd: string,
  targetPath: string,
): { relative: string } | { error: 'OUTSIDE_REPO' } {
  // Realpath the repoRoot once. If the repoRoot itself doesn't exist
  // (impossible in practice — the caller is running INSIDE it), fall back to
  // the lexical path so we still fail closed below.
  let realRepoRoot: string;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    realRepoRoot = repoRoot;
  }

  // For the target, the file might not exist yet (that's the common case —
  // the worker is asking BEFORE the write). Realpath the longest existing
  // prefix and append the unresolved tail.
  const abs = path.resolve(cwd, targetPath);
  const real = realpathOfLongestPrefix(abs);

  const relative = path.relative(realRepoRoot, real);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return { error: 'OUTSIDE_REPO' };
  }
  return { relative };
}

function realpathOfLongestPrefix(abs: string): string {
  // Walk up the path until realpath succeeds; reattach the unresolved tail.
  // This handles "target file doesn't exist yet" without skipping symlink
  // resolution on the existing ancestors.
  let cursor = abs;
  const tail: string[] = [];
  while (cursor !== path.dirname(cursor)) {
    try {
      const real = realpathSync(cursor);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      tail.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
  // Reached filesystem root with no existing ancestor — return the lexical path.
  return abs;
}

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
  const repoRoot = path.dirname(args.forgeDir);
  const resolved = resolveRepoRelative(repoRoot, args.cwd, args.path);
  if ('error' in resolved) {
    // Refuse to answer for paths outside the repo. The response envelope
    // intentionally does NOT echo the resolved path — that would leak the
    // repoRoot's depth in the filesystem to envelope readers
    // (security-auditor on FORGE-97).
    return {
      exitCode: emit(
        fail('INVALID_ARGS', 'path resolves outside the repository (after symlink resolution)', false),
        { json },
      ),
    };
  }
  const relative = resolved.relative;

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

  // Match against globs.
  let match: ReturnType<typeof matchAny>;
  try {
    match = matchAny(relative, preflightGlobs);
  } catch (e) {
    if (e instanceof InvalidGlobError) {
      return {
        exitCode: emit(
          fail('INVALID_GLOB', e.message, false, { glob: e.glob }),
          { json },
        ),
      };
    }
    // matchAny only throws InvalidGlobError or the absolute-path guard,
    // which can't fire here (we just produced `relative`). Conservative: treat
    // as non-matching but surface to stderr for triage.
    process.stderr.write(`guardrail-check: unexpected matcher error: ${e instanceof Error ? e.message : String(e)}\n`);
    match = { matched: false };
  }

  const result: GuardrailCheckResult = match.matched
    ? {
        architectural: true,
        path: relative,
        // `match.matched === true` guarantees `matchedGlob` is a defined
        // string (see glob-match.ts:matchAny return shape).
        matched_glob: match.matchedGlob!,
        suggested_decision_key: suggestDecisionKey(match.matchedGlob!, relative),
      }
    : {
        architectural: false,
        path: relative,
        matched_glob: null,
        suggested_decision_key: null,
      };

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
    const parsed = LeaseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    lease = parsed.data;
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
