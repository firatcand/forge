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
import { runOrchestrateReconcile } from './reconcile.ts';
import { guardrailCheckHandler } from './guardrail-check.ts';
import { ensureWorktreeHandler } from './ensure-worktree.ts';

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
  synopsis: 'Run the deterministic reconciler over local + tracker state.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const dryRun = hasFlag(rest, 'dry-run');
    const result = runOrchestrateGc({ forgeDir, dryRun });
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
  ['attach', attachHandler],
  ['spec-diff', specDiffHandler],
  ['guardrail-check', guardrailCheckHandler],
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
  ['gc', gcHandler],
]);

// Order used for --help rendering. Read-only first, then mutating, then nested.
export const HELP_ORDER: readonly string[] = [
  'phases',
  'status',
  'questions',
  'doctor',
  'attach',
  'spec-diff',
  'guardrail-check',
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
  'gc',
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

// Internal hook so subsequent step files (Step 3, 4, 5) can register their
// verbs without re-exporting the whole registry. The signature is intentionally
// narrow: a verb registration cannot mutate an existing entry.
export function registerVerb(name: string, handler: VerbHandler | Map<string, VerbHandler>): void {
  if (VERBS.has(name)) {
    throw new Error(`forge orchestrate registry: '${name}' already registered`);
  }
  VERBS.set(name, handler);
}
