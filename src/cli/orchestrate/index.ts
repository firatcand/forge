// Verb-table dispatcher for `forge orchestrate <verb> [...]`.
//
// Replaces the legacy if-chain. Adding a new verb means: (1) write the verb
// handler module, (2) register it here with its band metadata, (3) write its
// help string in help.ts. The dispatcher walks the registry for --help so the
// classification table cannot drift from the implementation.

import { fail, emit } from '../envelope.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import { runOrchestrateAnswer } from './answer.ts';
import { runOrchestrateAttach } from './attach.ts';
import { runOrchestrateGc } from './gc.ts';
import { runOrchestrateQuestions } from './questions.ts';
import { runOrchestrateSpecDiff } from './spec-diff.ts';
import { runOrchestrateStatus } from './status.ts';
import { parseFlag, firstPositional } from './flags.ts';
import { phasesHandler } from './phases.ts';
import { doctorHandler } from './doctor.ts';
import { runStartHandler } from './run-start.ts';
import { runListHandler } from './run-list.ts';
import { claimHandler } from './claim.ts';
import { dispatchHandler } from './dispatch.ts';
import { heartbeatHandler } from './heartbeat.ts';
import { questionWriteHandler } from './question-write.ts';
import { eventHandler } from './event.ts';
import { completeHandler } from './complete.ts';
import { cancelHandler } from './cancel.ts';
import { applyDecisionHandler } from './apply-decision.ts';
import { amendRoadmapHandler } from './amend-roadmap.ts';
import { runOrchestrateReconcile } from './reconcile.ts';
import { guardrailCheckHandler } from './guardrail-check.ts';
import { ensureWorktreeHandler } from './ensure-worktree.ts';
import { renderWorkerPromptHandler } from './render-worker-prompt.ts';
import { secondOpinionHandler } from './second-opinion.ts';
import { dashboardHandler } from './dashboard.ts';

export type VerbBand = 'read' | 'mutate';

export interface VerbHandler {
  readonly band: VerbBand;
  readonly synopsis: string;
  readonly run: (rest: readonly string[], opts: DispatcherOpts) => Promise<{ exitCode: number }>;
}

export interface DispatcherOpts {
  readonly cwd: string;
}

export type VerbRegistry = Map<string, VerbHandler | Map<string, VerbHandler>>;

// ── Adapter wrappers for the 6 pre-existing verbs ────────────────────────────
// Each wrapper extracts flags into the verb's existing options shape, calls
// the verb's runner, and returns { exitCode }.

const questionsHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List open worker questions (--json + --run <id> for skill consumption).',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const runId = parseFlag(rest, 'run') ?? parseFlag(rest, 'run-id');
    const result = runOrchestrateQuestions({
      open: hasFlag(rest, 'open'),
      forgeDir,
      json: hasFlag(rest, 'json'),
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const answerHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Supervisor answers an open question.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const questionId = firstPositional(rest) ?? '';
    const optionId = parseFlag(rest, 'option') ?? '';
    const note = parseFlag(rest, 'note');
    const result = runOrchestrateAnswer({
      questionId,
      optionId,
      forgeDir,
      ...(note ? { note } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const statusHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Snapshot of task and run state.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const runId = firstPositional(rest) ?? parseFlag(rest, 'run-id');
    const result = runOrchestrateStatus({
      forgeDir,
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const attachHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Tail per-run notifications.jsonl.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const runId = firstPositional(rest) ?? parseFlag(rest, 'run-id');
    const result = await runOrchestrateAttach({
      forgeDir,
      follow: true,
      ...(runId ? { runId } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const gcHandler: VerbHandler = {
  band: 'mutate',
  synopsis:
    'Run the deterministic reconciler: legacy v1 migration + 14-row divergence table (--dry-run plans); --remove-worktrees [--task <id>] removes terminal-task worktrees.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const dryRun = hasFlag(rest, 'dry-run');

    // ── `--remove-worktrees` — mutually exclusive early mode (FORGE-116) ──
    if (hasFlag(rest, 'remove-worktrees')) {
      // No other gc flags may combine with this mode. Allowed companions are
      // exactly: --task <id>, --dry-run, --json, and --forge-dir.
      const ALLOWED = new Set([
        'remove-worktrees',
        'task',
        'dry-run',
        'json',
        'forge-dir',
      ]);
      for (const arg of rest) {
        if (!arg.startsWith('--')) continue;
        const name = arg.slice(2).split('=')[0]!;
        if (!ALLOWED.has(name)) {
          const envelope = fail(
            'INVALID_ARGS',
            `forge orchestrate gc --remove-worktrees: unknown or incompatible flag '--${name}'. ` +
              `In this mode only --task <id>, --dry-run, and --json are accepted.`,
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
      }
      // Fix 4 (FORGE-116): reject any positional argument in --remove-worktrees
      // mode. The accepted surface is exactly --task <id>, --dry-run, --json,
      // --forge-dir. A positional (any token not starting with '--' and not the
      // value of a flag that consumes the next token) is not part of this surface.
      {
        const valueFlags = new Set(['task', 'forge-dir']); // flags that consume next token
        let i = 0;
        while (i < rest.length) {
          const a = rest[i]!;
          if (a.startsWith('--')) {
            const name = a.slice(2).split('=')[0]!;
            // If it's a value-consuming flag in `--flag value` form, skip the value token too.
            if (valueFlags.has(name) && !a.includes('=')) {
              i += 2;
            } else {
              i += 1;
            }
          } else {
            // Positional token.
            const envelope = fail(
              'INVALID_ARGS',
              `forge orchestrate gc --remove-worktrees: unexpected positional argument '${a}'. ` +
                `This mode accepts no positional arguments; use --task <id> to scope to a single task.`,
              false,
            );
            return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
          }
        }
      }
      // --task, if present, must carry a value that passes the task-id format.
      // Fix 1 (FORGE-116): validate BEFORE any path construction so that a value
      // like `../..` is rejected with INVALID_ARGS rather than escaping .forge/worktrees.
      const TASK_ID_RE = /^(?:[A-Z][A-Z0-9]*-\d+|P\d+(?:\.\d+)?-T\d+[a-z]?)$/;
      let scopedTask: string | undefined;
      if (hasFlag(rest, 'task')) {
        const value = parseFlag(rest, 'task');
        if (value === undefined || value.length === 0 || value.startsWith('--')) {
          const envelope = fail(
            'INVALID_ARGS',
            "forge orchestrate gc --remove-worktrees: --task requires a value (the task id).",
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
        if (!TASK_ID_RE.test(value)) {
          const envelope = fail(
            'INVALID_ARGS',
            `forge orchestrate gc --remove-worktrees: --task value '${value}' is not a valid task id. ` +
              `Expected format: TRACKER-123 (e.g. FORGE-116) or P1-T3 (phases shape).`,
            false,
          );
          return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
        }
        scopedTask = value;
      }
      const result = await runOrchestrateGc({
        forgeDir,
        dryRun,
        removeWorktrees: true,
        json: hasFlag(rest, 'json'),
        ...(scopedTask !== undefined ? { removeWorktreesTask: scopedTask } : {}),
      });
      return { exitCode: result.exitCode };
    }

    const result = await runOrchestrateGc({ forgeDir, dryRun });
    return { exitCode: result.exitCode };
  },
};

const specDiffHandler: VerbHandler = {
  band: 'read',
  synopsis: 'Show spec/ commits since claim.spec_revision for a task.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = firstPositional(rest) ?? '';
    const json = hasFlag(rest, 'json');
    const repoRoot = parseFlag(rest, 'repo-root');
    const result = await runOrchestrateSpecDiff({
      taskId,
      forgeDir,
      json,
      ...(repoRoot ? { repoRoot } : {}),
    });
    return { exitCode: result.exitCode };
  },
};

const reconcileHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Bi-directional phases.yaml ↔ tracker sync (--pull | --push).',
  async run(rest, opts) {
    const result = await runOrchestrateReconcile({
      cwd: opts.cwd,
      argv: rest,
    });
    return { exitCode: result.exitCode };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const VERBS: VerbRegistry = new Map<string, VerbHandler | Map<string, VerbHandler>>([
  // Read-only band.
  ['phases', phasesHandler],
  ['doctor', doctorHandler],
  ['questions', questionsHandler],
  ['status', statusHandler],
  ['dashboard', dashboardHandler],
  ['attach', attachHandler],
  ['spec-diff', specDiffHandler],
  ['guardrail-check', guardrailCheckHandler],
  ['render-worker-prompt', renderWorkerPromptHandler],
  ['run', new Map<string, VerbHandler>([
    ['start', runStartHandler],
    ['list', runListHandler],
  ])],
  // Mutating band.
  ['ensure-worktree', ensureWorktreeHandler],
  ['claim', claimHandler],
  ['dispatch', dispatchHandler],
  ['heartbeat', heartbeatHandler],
  ['question', questionWriteHandler],
  ['answer', answerHandler],
  ['event', eventHandler],
  ['complete', completeHandler],
  ['cancel', cancelHandler],
  ['reconcile', reconcileHandler],
  ['apply-decision', applyDecisionHandler],
  ['amend-roadmap', amendRoadmapHandler],
  ['gc', gcHandler],
  ['second-opinion', secondOpinionHandler],
]);

// Order used for --help rendering. Read-only first, then mutating, then nested.
export const HELP_ORDER: readonly string[] = [
  'phases',
  'status',
  'dashboard',
  'questions',
  'doctor',
  'attach',
  'spec-diff',
  'guardrail-check',
  'render-worker-prompt',
  'run',
  'ensure-worktree',
  'claim',
  'dispatch',
  'heartbeat',
  'question',
  'answer',
  'event',
  'complete',
  'cancel',
  'reconcile',
  'apply-decision',
  'amend-roadmap',
  'gc',
  'second-opinion',
];

export async function dispatchOrchestrate(
  rest: readonly string[],
  opts: DispatcherOpts,
): Promise<{ exitCode: number }> {
  const sub = rest[0];
  if (!sub) {
    // No verb. Show usage on stderr; exit 1 (consistent with the rest of forge.ts).
    process.stderr.write(usage());
    return { exitCode: 1 };
  }
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return { exitCode: 0 };
  }
  const entry = VERBS.get(sub);
  if (!entry) {
    const envelope = fail(
      'UNKNOWN_VERB',
      `forge orchestrate: unknown verb '${sub}'. Run \`forge orchestrate --help\` for the list.`,
      false,
    );
    return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
  }
  // Nested verb (e.g., `run start`).
  if (entry instanceof Map) {
    const subSub = rest[1];
    if (!subSub || subSub === '--help' || subSub === '-h') {
      process.stdout.write(nestedUsage(sub, entry));
      return { exitCode: subSub ? 0 : 1 };
    }
    const handler = entry.get(subSub);
    if (!handler) {
      const envelope = fail(
        'UNKNOWN_VERB',
        `forge orchestrate ${sub}: unknown sub-verb '${subSub}'.`,
        false,
      );
      return { exitCode: emit(envelope, { json: hasFlag(rest, 'json') }) };
    }
    return handler.run(rest.slice(2), opts);
  }
  return entry.run(rest.slice(1), opts);
}

function usage(): string {
  const lines: string[] = [
    'Usage: forge orchestrate <verb> [options]',
    '',
    'Verbs (read-only — no lease, no tracker mutation):',
  ];
  for (const name of HELP_ORDER) {
    const handler = VERBS.get(name);
    if (!handler) continue;
    if (handler instanceof Map) {
      lines.push(`  ${name} (sub-verbs: ${[...handler.keys()].join(', ')})`);
      continue;
    }
    if (handler.band === 'read') {
      lines.push(`  ${name.padEnd(12)} ${handler.synopsis}`);
    }
  }
  lines.push('', 'Verbs (mutating — require user-approval per call):');
  for (const name of HELP_ORDER) {
    const handler = VERBS.get(name);
    if (!handler || handler instanceof Map) continue;
    if (handler.band === 'mutate') {
      lines.push(`  ${name.padEnd(12)} ${handler.synopsis}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function nestedUsage(name: string, sub: Map<string, VerbHandler>): string {
  const lines: string[] = [
    `Usage: forge orchestrate ${name} <sub-verb> [options]`,
    '',
    'Sub-verbs:',
  ];
  for (const [subName, handler] of sub) {
    lines.push(`  ${subName.padEnd(10)} [${handler.band}] ${handler.synopsis}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
