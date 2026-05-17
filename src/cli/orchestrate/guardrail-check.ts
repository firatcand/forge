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
//      `guardrail_checked` event to the attempt log. `forge orchestrate
//      complete` (future FORGE-FOLLOWUP-A) cross-references verdict's
//      `files_changed` against this event stream and marks
//      `verdict_unverified` if a guardrail write occurred without a
//      prior check.
//
// Read-band: the verb itself does not mutate state-machine tasks. The event
// append is best-effort and only happens when caller identity (task +
// attempt + lease) can be resolved.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadSettings } from '../../core/settings.ts';
import { matchAny, InvalidGlobError } from '../../orchestrator/glob-match.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
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

export function runGuardrailCheck(args: GuardrailCheckArgs): {
  exitCode: number;
  data?: GuardrailCheckResult;
} {
  if (!args.path) {
    return {
      exitCode: emit(fail('INVALID_ARGS', '--path is required', false), { json: args.json ?? false }),
    };
  }
  if (args.path.length > MAX_PATH_LEN) {
    return {
      exitCode: emit(
        fail('INVALID_ARGS', `--path exceeds ${MAX_PATH_LEN} bytes`, false),
        { json: args.json ?? false },
      ),
    };
  }

  // RepoRoot convention mirrors spec-diff.ts: dirname(forgeDir).
  const repoRoot = path.dirname(args.forgeDir);
  const absPath = path.resolve(args.cwd, args.path);
  const relative = path.relative(repoRoot, absPath);

  // Load settings. preflight_globs has a schema default, so a missing field
  // expands to the standard list.
  let preflightGlobs: readonly string[];
  try {
    const settings = loadSettings(path.join(args.forgeDir, 'settings.yaml'));
    preflightGlobs = settings.agents.preflight_globs;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: emit(fail('SETTINGS_LOAD_ERROR', msg, true), { json: args.json ?? false }),
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
          { json: args.json ?? false },
        ),
      };
    }
    // Path was absolute or otherwise outside the repo — treat as non-architectural.
    match = { matched: false };
  }

  const result: GuardrailCheckResult = match.matched
    ? {
        architectural: true,
        path: relative,
        matched_glob: match.matchedGlob ?? null,
        suggested_decision_key: suggestDecisionKey(match.matchedGlob ?? '', relative),
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
    exitCode: emit(ok(result), { json: args.json ?? false }),
    data: result,
  };
}

function appendGuardrailEvent(args: {
  forgeDir: string;
  taskId: string;
  attemptId: string;
  result: GuardrailCheckResult;
}): void {
  // Resolve lease to recover caller identity. If the lease is missing or
  // invalid, silently skip the event — the verb still returns the result.
  const leasePath = path.join(args.forgeDir, 'orchestrator', 'tasks', args.taskId, 'lease.json');
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
  } catch {
    // Audit event is best-effort; the verb's primary result already returned.
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
