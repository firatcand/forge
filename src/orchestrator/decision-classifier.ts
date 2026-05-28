// FORGE-65: the decision gate behind `forge orchestrate question`.
//
// Forge cannot mechanically intercept worker file-writes (spec/ORCHESTRATOR.md:752),
// so the single enforcement chokepoint is the question verb. Before a question
// is written, this module decides whether it SHOULD be written at all:
//
//   1. validateClassification — accept well-formed DecisionClassification JSON,
//      reject malformed/missing with a typed error (AC1).
//   2. gateQuestion — the spec question lifecycle (ORCHESTRATOR.md:886-906):
//        reuse a prior answer for the same decision_key (AC4)
//        → else block on an existing open question for the same key (AC5)
//        → else, if the per-task hard_cap is reached, force an autonomous
//          decision (AC7)
//        → else write (carrying a soft-cap warning once soft is crossed, AC6).
//
// The per-decision_key respawn cap (max_attempts / DECISION_KEY_EXHAUSTED) is a
// DIFFERENT budget, owned by FORGE-146 — not enforced here. This module only
// owns the per-task soft/hard cap on TOTAL questions.

import {
  DecisionClassificationSchema,
  type DecisionClassification,
  type Answer,
  type Question,
} from '../schemas/questions.ts';
import {
  countTaskQuestions,
  findAnsweredQuestionByDecisionKey,
  findOpenQuestionByDecisionKey,
} from './questions/lookup.ts';

// ---------------------------------------------------------------------------
// AC1 — classification validation
// ---------------------------------------------------------------------------

export class ClassificationError extends Error {
  constructor(public readonly issues: string) {
    super(`invalid DecisionClassification: ${issues}`);
    this.name = 'ClassificationError';
  }
}

// Parse + validate a DecisionClassification from untrusted JSON (the worker
// emits it). Throws ClassificationError on any malformed/missing field so
// callers get a typed failure rather than a raw zod error.
export function validateClassification(input: unknown): DecisionClassification {
  const parsed = DecisionClassificationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ClassificationError(parsed.error.message);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// AC6 / AC7 — per-task question budget
// ---------------------------------------------------------------------------

export interface ResolvedBudget {
  readonly soft: number;
  readonly hard: number;
}

export interface PerTaskBudgetOverride {
  readonly soft?: number;
  readonly hard?: number;
}

export interface TaskBudgetState {
  readonly count: number;
  readonly soft: number;
  readonly hard: number;
  /** count >= soft — the next question should carry a warning. */
  readonly softExceeded: boolean;
  /** count >= hard — the question verb forces an autonomous decision. */
  readonly hardReached: boolean;
}

// Merge a per-task override (phases.yaml TaskSchema.question_budget) over the
// global default (settings.yaml agents.question_budget). Either member may be
// independently overridden; an unset member falls back to the global default.
export function resolveBudget(
  globalDefault: ResolvedBudget,
  perTask?: PerTaskBudgetOverride,
): ResolvedBudget {
  return {
    soft: perTask?.soft ?? globalDefault.soft,
    hard: perTask?.hard ?? globalDefault.hard,
  };
}

export function computeTaskBudget(args: {
  readonly forgeDir: string;
  readonly taskId: string;
  readonly budget: ResolvedBudget;
}): TaskBudgetState {
  const count = countTaskQuestions(args.taskId, { forgeDir: args.forgeDir });
  return {
    count,
    soft: args.budget.soft,
    hard: args.budget.hard,
    softExceeded: count >= args.budget.soft,
    hardReached: count >= args.budget.hard,
  };
}

// The soft-cap warning string injected into the NEXT attempt's worker prompt
// (rendered via the {{BUDGET_WARNING}} placeholder by the dispatch skill).
export function buildSoftCapWarning(state: TaskBudgetState): string {
  return (
    `⚠ Question budget: you have already asked ${state.count} question(s) on this task ` +
    `(soft cap ${state.soft}, hard cap ${state.hard}). Prefer deciding autonomously and ` +
    `logging your rationale unless the decision is genuinely architectural — once the hard ` +
    `cap is reached, further questions are auto-decided for you.`
  );
}

// ---------------------------------------------------------------------------
// AC4 / AC5 / AC7 — the gate
// ---------------------------------------------------------------------------

export type GateOutcome =
  | { readonly kind: 'reuse'; readonly question: Question; readonly answer: Answer }
  | { readonly kind: 'block_on_existing'; readonly question: Question }
  | {
      readonly kind: 'forced_autonomous';
      readonly reason: string;
      readonly chosenOptionId: string | null;
    }
  | { readonly kind: 'write'; readonly softCapWarning?: string };

export interface GateArgs {
  readonly forgeDir: string;
  readonly taskId: string;
  readonly decisionKey: string;
  readonly budget: ResolvedBudget;
  /** The worker's recommended option, used as the autonomous choice at hard_cap. */
  readonly recommendedOptionId?: string;
  /** classification.default_action — used in the autonomous justification. */
  readonly defaultAction?: string;
}

export function gateQuestion(args: GateArgs): GateOutcome {
  // 1. Reuse: a prior answer for this decision_key (any attempt) wins outright.
  const answered = findAnsweredQuestionByDecisionKey(args.decisionKey, {
    forgeDir: args.forgeDir,
    taskId: args.taskId,
  });
  if (answered) {
    return { kind: 'reuse', question: answered.question, answer: answered.answer };
  }

  // 2. Block: an open question for this decision_key (any attempt) — do not
  //    write a duplicate; the worker blocks on the pending one.
  const open = findOpenQuestionByDecisionKey(args.decisionKey, {
    forgeDir: args.forgeDir,
    taskId: args.taskId,
  });
  if (open) {
    return { kind: 'block_on_existing', question: open };
  }

  // 3. Budget: hard cap reached → force an autonomous decision (logged).
  const state = computeTaskBudget({
    forgeDir: args.forgeDir,
    taskId: args.taskId,
    budget: args.budget,
  });
  if (state.hardReached) {
    const chosenOptionId = args.recommendedOptionId ?? null;
    const reason = chosenOptionId
      ? `per-task hard_cap (${state.hard}) reached after ${state.count} question(s); ` +
        `proceeding autonomously with recommended option '${chosenOptionId}'`
      : `per-task hard_cap (${state.hard}) reached after ${state.count} question(s); ` +
        `no recommendation supplied, proceeding with classification default_action ` +
        `'${args.defaultAction ?? 'decide'}'`;
    return { kind: 'forced_autonomous', reason, chosenOptionId };
  }

  // 4. Budget OK → write. Once soft is crossed, carry the warning for the next
  //    attempt's prompt.
  return state.softExceeded
    ? { kind: 'write', softCapWarning: buildSoftCapWarning(state) }
    : { kind: 'write' };
}
