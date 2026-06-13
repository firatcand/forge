// `forge orchestrate inbox` — read-only list of parked tasks (FORGE-195).
//
// A "parked" task is one in state blocked_on_question: a worker hit an
// architectural decision it could not make autonomously (or a review-phase
// escalation, FORGE-184) and is waiting on a supervisor answer. This verb
// surfaces every parked task together with its correlated open questions so a
// supervisor (or the /goal driver, FORGE-187) can triage them in one place.
//
// Read band: no lease, no tracker mutation, no state write. Best-effort,
// non-atomic snapshot. The shared state-dir scanner (collectTasksByState) skips
// corrupt / schema-invalid / hostile-named entries; a blocked task with no open
// questions still lists with open_questions: [].

import { collectTasksByState } from '../../orchestrator/readiness.ts';
import { listOpenQuestionsAcrossTree } from '../../orchestrator/questions/index.ts';
import { QuestionChannelError } from '../../orchestrator/questions/errors.ts';
import type { Question, DecisionClassification } from '../../schemas/questions.ts';
import type { TaskState } from '../../schemas/task-state.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { hasFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

export interface InboxQuestion {
  readonly question_id: string;
  readonly decision_key: string;
  readonly question: string;
  readonly options: Question['options'];
  readonly recommended_option_id?: string;
  readonly classification: DecisionClassification;
  readonly created_at: string;
}

export interface InboxParkedTask {
  readonly task_id: string;
  readonly state: TaskState;
  readonly open_questions: InboxQuestion[];
}

export interface OrchestrateInboxOptions {
  readonly forgeDir: string;
  readonly json?: boolean;
  // Injectable streams so PassThrough fixtures can capture output (precedent:
  // dashboard.ts / questions.ts). Defaults to process.stdout / process.stderr.
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export interface OrchestrateInboxResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

function toInboxQuestion(q: Question): InboxQuestion {
  return {
    question_id: q.question_id,
    decision_key: q.decision_key,
    question: q.question,
    options: q.options,
    ...(q.recommended_option_id !== undefined
      ? { recommended_option_id: q.recommended_option_id }
      : {}),
    classification: q.classification,
    created_at: q.created_at,
  };
}

export function runOrchestrateInbox(
  opts: OrchestrateInboxOptions,
): OrchestrateInboxResult {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const json = opts.json === true;

  const parked = collectTasksByState(
    opts.forgeDir,
    (s) => s === 'blocked_on_question',
  );
  const parkedIds = new Set(parked.map((p) => p.taskId));

  // Correlate open questions, grouped by task_id, keeping only those whose task
  // is in the parked set.
  const questionsByTask = new Map<string, Question[]>();
  let questions: readonly Question[] = [];
  try {
    questions = listOpenQuestionsAcrossTree({
      forgeDir: opts.forgeDir,
      onSkip: (path, e) => {
        err.write(`[warn] skipping ${path}: ${e.code} ${e.message}\n`);
      },
    });
  } catch (e) {
    const msg =
      e instanceof QuestionChannelError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    return { exitCode: writeEnvelope(fail('QUESTION_CHANNEL_ERROR', msg, false), out) };
  }
  for (const q of questions) {
    if (!parkedIds.has(q.task_id)) continue;
    const list = questionsByTask.get(q.task_id) ?? [];
    list.push(q);
    questionsByTask.set(q.task_id, list);
  }

  const parked_tasks: InboxParkedTask[] = parked.map((scan) => ({
    task_id: scan.taskId,
    state: scan.state,
    open_questions: (questionsByTask.get(scan.taskId) ?? []).map(toInboxQuestion),
  }));

  if (json) {
    return { exitCode: writeEnvelope(ok({ parked_tasks }), out) };
  }

  if (parked_tasks.length === 0) {
    out.write('No parked tasks.\n');
    return { exitCode: 0 };
  }
  const lines: string[] = [];
  for (const t of parked_tasks) {
    lines.push(`${t.task_id} [${t.state}] — ${t.open_questions.length} open question(s)`);
    for (const q of t.open_questions) {
      lines.push(`  [${q.question_id}] ${q.decision_key} (${q.classification.decision_type})`);
      lines.push(`    Q: ${q.question}`);
    }
  }
  out.write(lines.join('\n') + '\n');
  return { exitCode: 0 };
}

export const inboxHandler: VerbHandler = {
  band: 'read',
  synopsis: 'List parked tasks (blocked_on_question) with their correlated open questions.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    return runOrchestrateInbox({ forgeDir, json: hasFlag(rest, 'json') });
  },
};
