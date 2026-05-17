// `forge orchestrate question` — worker writes an architectural question.
//
// Wraps writeQuestionAtomic from src/orchestrator/questions/writer.ts.
// Transitions state running → blocked_on_question. Appends question_written
// event to attempts/<a>/events.jsonl.
//
// Per spec line 184-189, the verb signature is:
//   forge orchestrate question <task-id> --attempt <attempt-id>
//     --decision-key <key> --question <text> [--options-file <path>]
//     [--drift-event-id <id>] [--routing-hint apply-decision|amend-roadmap]
//
// Decision classification is REQUIRED by the schema but NOT a CLI flag in the
// spec — workers can pass --classification-file <path> (JSON) to override; if
// absent, we apply a conservative default (architectural / other / medium /
// module / ask). Per-fork: classification surface is internal to workers, so
// the default is part of the verb's behavior and not user-facing.

import { readFileSync } from 'node:fs';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { QuestionWriteArgsSchema, type QuestionWriteArgs } from '../../schemas/cli-args.ts';
import {
  QuestionOptionSchema,
  DecisionClassificationSchema,
  type Question,
  type DecisionClassification,
} from '../../schemas/questions.ts';
import { writeQuestionAtomic } from '../../orchestrator/questions/writer.ts';
import { readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { OrchestratorError } from '../../core/errors.ts';
import { LeaseSchema, type Lease } from '../../schemas/lease.ts';
import path from 'node:path';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import type { VerbHandler } from './index.ts';

const QUESTION_EXPIRY_HOURS_DEFAULT = 24;

const OPTIONS_FILE_SCHEMA = z.array(QuestionOptionSchema).min(2).max(10);

const DEFAULT_CLASSIFICATION: DecisionClassification = {
  decision_type: 'architectural',
  category: 'other',
  reversibility: 'medium',
  blast_radius: 'module',
  default_action: 'ask',
  reason: 'Worker-emitted architectural question (default classification).',
};

export interface QuestionWriteExtras {
  readonly classificationFile?: string;
  readonly maxAttempts?: number;
  readonly recommendedOptionId?: string;
}

export async function runOrchestrateQuestionWrite(
  args: QuestionWriteArgs,
  extras: QuestionWriteExtras = {},
): Promise<{ exitCode: number }> {
  const parsed = QuestionWriteArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { exitCode: emit(fail('INVALID_ARGS', parsed.error.message, false), { json: args.json }) };
  }
  const opts = parsed.data;

  // 1. Load options (if --options-file provided; otherwise default to a yes/no).
  let options;
  if (opts.optionsFile) {
    let raw: string;
    try {
      raw = readFileSync(opts.optionsFile, 'utf8');
    } catch (err) {
      return {
        exitCode: emit(
          fail('OPTIONS_FILE_READ_FAILED', `failed to read --options-file: ${err instanceof Error ? err.message : String(err)}`, false),
          { json: opts.json },
        ),
      };
    }
    let parsedJson;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      return {
        exitCode: emit(
          fail('INVALID_OPTIONS_FILE', `--options-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, false),
          { json: opts.json },
        ),
      };
    }
    const validation = OPTIONS_FILE_SCHEMA.safeParse(parsedJson);
    if (!validation.success) {
      return {
        exitCode: emit(
          fail('INVALID_OPTIONS_FILE', validation.error.message, false),
          { json: opts.json },
        ),
      };
    }
    options = validation.data;
  } else {
    options = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }

  // 2. Load classification (or use default).
  let classification = DEFAULT_CLASSIFICATION;
  if (extras.classificationFile) {
    let raw: string;
    try {
      raw = readFileSync(extras.classificationFile, 'utf8');
    } catch (err) {
      return {
        exitCode: emit(
          fail('CLASSIFICATION_FILE_READ_FAILED', `${err instanceof Error ? err.message : String(err)}`, false),
          { json: opts.json },
        ),
      };
    }
    const parsedClass = DecisionClassificationSchema.safeParse(JSON.parse(raw));
    if (!parsedClass.success) {
      return {
        exitCode: emit(
          fail('INVALID_CLASSIFICATION', parsedClass.error.message, false),
          { json: opts.json },
        ),
      };
    }
    classification = parsedClass.data;
  }

  // 3. Read lease for caller identity.
  let lease: Lease;
  try {
    lease = readLease(opts.forgeDir, opts.taskId);
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof OrchestratorError ? err.code : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  // 4. Build the question record.
  const questionId = uuidv7();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUESTION_EXPIRY_HOURS_DEFAULT * 3_600_000);
  const question: Question = {
    version: 1,
    question_id: questionId,
    run_id: lease.owner_run_id,
    task_id: opts.taskId,
    agent_id: 'worker',
    decision_key: opts.decisionKey,
    attempt: 1,
    max_attempts: extras.maxAttempts ?? 3,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'open',
    question: opts.question,
    context: '',
    options,
    classification,
    ...(extras.recommendedOptionId ? { recommended_option_id: extras.recommendedOptionId } : {}),
  };

  // 5. Atomic write.
  try {
    writeQuestionAtomic(question, {
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      attemptId: opts.attemptId,
    });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'IO_ERROR';
    return {
      exitCode: emit(
        fail(code, err instanceof Error ? err.message : String(err), false),
        { json: opts.json },
      ),
    };
  }

  // 6. Append the 'question_written' event.
  try {
    appendAttemptEvent(
      {
        type: 'question_written',
        ts: now.toISOString(),
        question_id: questionId,
        decision_key: opts.decisionKey,
      },
      {
        forgeDir: opts.forgeDir,
        taskId: opts.taskId,
        attemptId: opts.attemptId,
        caller: {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      },
    );
  } catch {
    // Best-effort audit trail.
  }

  // 7. State transition: running → blocked_on_question.
  try {
    const state = readTaskState(opts.forgeDir, opts.taskId);
    if (state.state === 'running') {
      writeTaskState(
        opts.forgeDir,
        {
          ...state,
          state: 'blocked_on_question',
          state_version: state.state_version + 1,
          updated_at: new Date().toISOString(),
          updated_by: {
            run_id: lease.owner_run_id,
            claim_id: lease.claim_id,
            generation: lease.generation,
          },
        },
        {
          run_id: lease.owner_run_id,
          claim_id: lease.claim_id,
          generation: lease.generation,
        },
      );
    }
  } catch {
    // State transition is best-effort here; the question is the authoritative record.
  }

  // Note: --drift-event-id and --routing-hint are accepted via the CLI; in the
  // v0.4 simplified pipeline (per spec note line 188-189) they are stored on the
  // question only when a future migration extends the QuestionSchema. For now,
  // accepting the flags keeps the worker prompt template future-proof — the
  // verb echoes them in the response envelope.
  return {
    exitCode: emit(
      ok({
        question_id: questionId,
        decision_key: opts.decisionKey,
        ...(opts.driftEventId ? { drift_event_id: opts.driftEventId } : {}),
        ...(opts.routingHint ? { routing_hint: opts.routingHint } : {}),
      }),
      { json: opts.json },
    ),
  };
}

function readLease(forgeDir: string, taskId: string): Lease {
  const leasePath = path.join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json');
  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch {
    throw new OrchestratorError(
      'LEASE_NOT_FOUND',
      `lease.json not found for task ${taskId}`,
      { taskId, path: leasePath },
    );
  }
  const parsed = LeaseSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new OrchestratorError(
      'SCHEMA_INVALID',
      `lease.json schema invalid for task ${taskId}`,
      { taskId, zodError: parsed.error.message },
    );
  }
  return parsed.data;
}

export const questionWriteHandler: VerbHandler = {
  band: 'mutate',
  synopsis: 'Write a worker question (atomically), transition to blocked_on_question.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const taskId = parseFlag(rest, 'task') ?? rest.find((a) => !a.startsWith('--')) ?? '';
    const attemptId = parseFlag(rest, 'attempt') ?? '';
    const decisionKey = parseFlag(rest, 'decision-key') ?? '';
    const question = parseFlag(rest, 'question') ?? '';
    const optionsFile = parseFlag(rest, 'options-file');
    const driftEventId = parseFlag(rest, 'drift-event-id');
    const routingHintRaw = parseFlag(rest, 'routing-hint');
    const routingHint = (routingHintRaw === 'apply-decision' || routingHintRaw === 'amend-roadmap')
      ? routingHintRaw
      : undefined;
    const json = hasFlag(rest, 'json');
    return runOrchestrateQuestionWrite({
      taskId,
      attemptId,
      decisionKey,
      question,
      forgeDir,
      json,
      ...(optionsFile ? { optionsFile } : {}),
      ...(driftEventId ? { driftEventId } : {}),
      ...(routingHint ? { routingHint } : {}),
    });
  },
};
