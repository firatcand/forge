// `forge orchestrate question` — worker writes an architectural question.
//
// This is the single enforcement chokepoint for the question lifecycle
// (spec/ORCHESTRATOR.md:886-906): forge cannot mechanically intercept worker
// file-writes (ORCHESTRATOR.md:752), so the gate runs HERE, in the verb, not
// in the (untrusted) worker prompt. Before a question is written we run
// gateQuestion (src/orchestrator/decision-classifier.ts):
//
//   reuse a prior answer for this decision_key (AC4)
//   → else block on an existing open question for this decision_key (AC5)
//   → else, if the per-task hard_cap is reached, force an autonomous decision
//     and log it (AC7)
//   → else write the question (carrying a soft-cap warning once soft is
//     crossed, surfaced for the next attempt's prompt — AC6).
//
// recommended_option_id + what_happens_if_unanswered are REQUIRED here (AC8),
// enforced at the verb rather than in QuestionSchema so readQuestion stays
// lenient toward legacy/in-flight question files the dedupe scan reads.
//
// Per spec line 184-189, the verb signature is:
//   forge orchestrate question <task-id> --attempt <attempt-id>
//     --decision-key <key> --question <text> [--options-file <path>]
//     --recommended-option-id <id> --what-happens-if-unanswered <text>
//     [--question-budget-soft <n>] [--question-budget-hard <n>]
//     [--drift-event-id <id>] [--routing-hint apply-decision|amend-roadmap]

import { readFileSync } from 'node:fs';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { QuestionWriteArgsSchema, type QuestionWriteArgs } from '../../schemas/cli-args.ts';
import {
  QuestionOptionSchema,
  type Question,
  type DecisionClassification,
} from '../../schemas/questions.ts';
import { writeQuestionAtomic } from '../../orchestrator/questions/writer.ts';
import {
  validateClassification,
  ClassificationError,
  gateQuestion,
  resolveBudget,
  type ResolvedBudget,
} from '../../orchestrator/decision-classifier.ts';
import {
  classifyError,
  nextRetryState,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '../../orchestrator/retry.ts';
import { loadSettings } from '../../core/settings.ts';
import { readTaskState, writeTaskState } from '../../orchestrator/state-machine.ts';
import { appendAttemptEvent } from '../../orchestrator/attempt-events.ts';
import { OrchestratorError, SettingsError } from '../../core/errors.ts';
import type { Lease } from '../../schemas/lease.ts';
import path from 'node:path';
import { emit, fail, ok } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import { callerFromLease, readLease } from './lease-io.ts';
import type { VerbHandler } from './index.ts';

const QUESTION_EXPIRY_HOURS_DEFAULT = 24;

const OPTIONS_FILE_SCHEMA = z.array(QuestionOptionSchema).min(2).max(10);

// Fallback global budget when settings.yaml can't be loaded — matches the
// QuestionBudgetSchema defaults so "no settings" behaves like "settings with
// defaults" (spec/ORCHESTRATOR.md:936).
const DEFAULT_QUESTION_BUDGET: ResolvedBudget = { soft: 3, hard: 6 };

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

  // AC8: recommended_option_id + what_happens_if_unanswered are required on
  // every question the CLI writes. Reject early, before any I/O.
  if (!opts.recommendedOptionId) {
    return {
      exitCode: emit(
        fail('MISSING_REQUIRED_FIELD', '--recommended-option-id is required', false),
        { json: opts.json },
      ),
    };
  }
  if (!opts.whatHappensIfUnanswered) {
    return {
      exitCode: emit(
        fail('MISSING_REQUIRED_FIELD', '--what-happens-if-unanswered is required', false),
        { json: opts.json },
      ),
    };
  }
  // Narrowed to string by the guards above.
  const recommendedOptionId = opts.recommendedOptionId;
  const whatHappensIfUnanswered = opts.whatHappensIfUnanswered;

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

  // recommended_option_id must name an actual option. Validate once, here, so a
  // bogus id is rejected with a clear error on EVERY outcome — including
  // forced_autonomous (which logs chosen_option_id) — rather than surfacing as
  // an opaque SCHEMA_INVALID from writeQuestionAtomic only on the write path
  // (Codex 2nd-pass).
  if (!options.some((o) => o.id === recommendedOptionId)) {
    return {
      exitCode: emit(
        fail(
          'INVALID_RECOMMENDED_OPTION',
          `--recommended-option-id '${recommendedOptionId}' is not one of the question's options`,
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  // 2. Load classification (or use default), via the standalone validator (AC1).
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
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      return {
        exitCode: emit(
          fail('INVALID_CLASSIFICATION', `--classification-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, false),
          { json: opts.json },
        ),
      };
    }
    try {
      classification = validateClassification(parsedJson);
    } catch (err) {
      if (err instanceof ClassificationError) {
        return {
          exitCode: emit(fail('INVALID_CLASSIFICATION', err.issues, false), { json: opts.json }),
        };
      }
      throw err;
    }
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

  // 4. Resolve the per-task budget: global default from settings.yaml, with the
  //    dispatcher-supplied per-task override applied on top (FORGE-98 passes the
  //    flags after reading phases.yaml; absent → global default).
  let budget;
  try {
    budget = resolveBudget(loadGlobalBudget(opts.forgeDir), {
      soft: opts.questionBudgetSoft,
      hard: opts.questionBudgetHard,
    });
  } catch (err) {
    return {
      exitCode: emit(
        fail(
          err instanceof SettingsError ? 'SETTINGS_LOAD_ERROR' : 'IO_ERROR',
          err instanceof Error ? err.message : String(err),
          false,
        ),
        { json: opts.json },
      ),
    };
  }

  // 5. Gate: reuse → block → hard_cap → write.
  let outcome;
  try {
    outcome = gateQuestion({
      forgeDir: opts.forgeDir,
      taskId: opts.taskId,
      decisionKey: opts.decisionKey,
      budget,
      recommendedOptionId,
      defaultAction: classification.default_action,
      maxAttempts: extras.maxAttempts ?? 3,
    });
  } catch (err) {
    if (err instanceof OrchestratorError && err.code === 'DECISION_KEY_EXHAUSTED') {
      return markDecisionKeyExhausted(opts, lease, err);
    }
    throw err;
  }

  if (outcome.kind === 'reuse') {
    return {
      exitCode: emit(
        ok({
          outcome: 'reused',
          decision_key: opts.decisionKey,
          question_id: outcome.question.question_id,
          option_id: outcome.answer.option_id,
          ...(outcome.answer.note ? { note: outcome.answer.note } : {}),
        }),
        { json: opts.json },
      ),
    };
  }

  if (outcome.kind === 'block_on_existing') {
    return {
      exitCode: emit(
        ok({
          outcome: 'blocked_on_existing',
          decision_key: opts.decisionKey,
          question_id: outcome.question.question_id,
        }),
        { json: opts.json },
      ),
    };
  }

  if (outcome.kind === 'forced_autonomous') {
    // AC7: the autonomous decision MUST be logged. Unlike the best-effort
    // question_written append, this event IS the deliverable here, so a write
    // failure is surfaced rather than swallowed.
    try {
      appendAttemptEvent(
        {
          type: 'autonomous_decision',
          ts: new Date().toISOString(),
          decision_key: opts.decisionKey,
          chosen_option_id: outcome.chosenOptionId,
          reason: outcome.reason,
        },
        {
          forgeDir: opts.forgeDir,
          taskId: opts.taskId,
          attemptId: opts.attemptId,
          caller: callerFromLease(lease),
        },
      );
    } catch (err) {
      return {
        exitCode: emit(
          fail(
            err instanceof OrchestratorError ? err.code : 'EVENT_WRITE_FAILED',
            `failed to log autonomous_decision: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
          { json: opts.json },
        ),
      };
    }
    return {
      exitCode: emit(
        ok({
          outcome: 'forced_autonomous',
          decision_key: opts.decisionKey,
          chosen_option_id: outcome.chosenOptionId,
          reason: outcome.reason,
        }),
        { json: opts.json },
      ),
    };
  }

  // outcome.kind === 'write'
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
    attempt: outcome.attempt,
    max_attempts: extras.maxAttempts ?? 3,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'open',
    question: opts.question,
    context: '',
    options,
    classification,
    recommended_option_id: recommendedOptionId,
    what_happens_if_unanswered: whatHappensIfUnanswered,
  };

  // Atomic write.
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

  // Append the 'question_written' event (best-effort audit trail).
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
          caller: callerFromLease(lease),
        },
      );
  } catch {
    // Best-effort audit trail.
  }

  // State transition: running → blocked_on_question.
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
          updated_by: callerFromLease(lease),
        },
        callerFromLease(lease),
      );
    }
  } catch {
    // State transition is best-effort here; the question is the authoritative record.
  }

  // Note: --drift-event-id and --routing-hint are accepted via the CLI; in the
  // v0.4 simplified pipeline (per spec note line 188-189) they are echoed in the
  // response envelope so the worker prompt template stays future-proof.
  return {
    exitCode: emit(
      ok({
        outcome: 'written',
        question_id: questionId,
        decision_key: opts.decisionKey,
        ...(outcome.softCapWarning ? { soft_cap_warning: outcome.softCapWarning } : {}),
        ...(opts.driftEventId ? { drift_event_id: opts.driftEventId } : {}),
        ...(opts.routingHint ? { routing_hint: opts.routingHint } : {}),
      }),
      { json: opts.json },
    ),
  };
}

function markDecisionKeyExhausted(
  opts: QuestionWriteArgs,
  lease: Lease,
  err: OrchestratorError,
): { exitCode: number } {
  const errorClass = classifyError(err);
  const decision = nextRetryState(
    Number.POSITIVE_INFINITY,
    errorClass,
    loadRetryPolicy(opts.forgeDir),
  );
  try {
    const state = readTaskState(opts.forgeDir, opts.taskId);
    writeTaskState(
      opts.forgeDir,
      {
        ...state,
        state: 'failed',
        state_version: state.state_version + 1,
        failure_reason: decision.failure_reason ?? 'decision_key_budget',
        last_failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: callerFromLease(lease),
      },
        callerFromLease(lease),
      );
  } catch (stateErr) {
    return {
      exitCode: emit(
        fail(
          stateErr instanceof OrchestratorError ? stateErr.code : 'IO_ERROR',
          stateErr instanceof Error ? stateErr.message : String(stateErr),
          true,
          { decision_key: opts.decisionKey, original_code: err.code },
        ),
        { json: opts.json },
      ),
    };
  }
  return {
    exitCode: emit(
      ok({
        outcome: 'decision_key_exhausted',
        decision_key: opts.decisionKey,
        next_state: 'failed',
        failure_reason: decision.failure_reason ?? 'decision_key_budget',
        details: err.details,
      }),
      { json: opts.json },
    ),
  };
}

// Load the project's global question budget from settings.yaml. Best-effort:
// a missing/unreadable settings file falls back to the schema defaults (3/6)
// with a stderr note, so the question verb does not hard-depend on settings.yaml.
function loadGlobalBudget(forgeDir: string): ResolvedBudget {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return settings.agents.question_budget;
  } catch (err) {
    // Absent settings.yaml → fall back to the schema defaults (3/6): the question
    // verb must work in a bare tree. But a present-but-malformed settings.yaml is
    // a real config error and must surface, not be silently defaulted away
    // (Codex 2nd-pass).
    if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
      return DEFAULT_QUESTION_BUDGET;
    }
    throw err;
  }
}

function loadRetryPolicy(forgeDir: string): RetryPolicy {
  try {
    const settings = loadSettings(path.join(forgeDir, 'settings.yaml'));
    return {
      retry_attempts: settings.agents.retry_attempts,
      retry_backoff_ms_max: settings.agents.retry_backoff_ms_max,
    };
  } catch (err) {
    if (err instanceof SettingsError && err.code === 'FILE_NOT_FOUND') {
      return DEFAULT_RETRY_POLICY;
    }
    throw err;
  }
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
    const recommendedOptionId = parseFlag(rest, 'recommended-option-id');
    const whatHappensIfUnanswered = parseFlag(rest, 'what-happens-if-unanswered');
    const softRaw = parseFlag(rest, 'question-budget-soft');
    const hardRaw = parseFlag(rest, 'question-budget-hard');
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
      ...(recommendedOptionId ? { recommendedOptionId } : {}),
      ...(whatHappensIfUnanswered ? { whatHappensIfUnanswered } : {}),
      ...(softRaw !== undefined ? { questionBudgetSoft: Number(softRaw) } : {}),
      ...(hardRaw !== undefined ? { questionBudgetHard: Number(hardRaw) } : {}),
      ...(driftEventId ? { driftEventId } : {}),
      ...(routingHint ? { routingHint } : {}),
    });
  },
};
