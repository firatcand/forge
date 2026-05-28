// Pure renderer for `templates/worker-prompt.template.md`.
//
// Two transformations, in order:
//   1. Strip `<!-- host: claude -->...<!-- /host -->` blocks whose host
//      doesn't match ctx.host. Other-host content is removed entirely so
//      the worker never sees instructions intended for another host.
//   2. Substitute `{{TOKEN}}` placeholders against an allowlist. Unknown
//      tokens throw — the template is the contract, no silent expansion.
//
// Inputs are trusted (templates ship inside forge). The renderer does NOT
// execute template content as code (rules out the `${...}` JS-style
// alternative considered during planning).

export class UnknownPlaceholderError extends Error {
  constructor(public readonly token: string) {
    super(`unknown placeholder {{${token}}} in worker-prompt template`);
    this.name = 'UnknownPlaceholderError';
  }
}

export class UnterminatedHostBlockError extends Error {
  constructor(public readonly host: string) {
    super(`unterminated <!-- host: ${host} --> block in worker-prompt template`);
    this.name = 'UnterminatedHostBlockError';
  }
}

// FORGE-88: gemini joins the supported worker hosts. The renderer's
// stripOtherHostBlocks regex is already host-agnostic; this widening
// only affects callers that branch on host.
export type WorkerHost = 'claude' | 'codex' | 'gemini';

export interface PriorAttemptSummary {
  readonly attemptId: string;
  readonly status: string;
  readonly savePoint?: string;
}

export interface AnsweredQuestionSummary {
  readonly decisionKey: string;
  readonly answer: string;
}

export interface WorkerPromptContext {
  readonly taskId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly worktreePath: string;
  readonly phase: 'IMPLEMENT' | 'REVIEW' | 'SHIP';
  readonly taskDescription: string;
  readonly acceptanceCriteria: readonly string[];
  readonly conventions: string;
  readonly host: WorkerHost;
  readonly priorAttempts: readonly PriorAttemptSummary[];
  readonly answeredQuestions: readonly AnsweredQuestionSummary[];
  // FORGE-65: soft-cap warning injected once the task crosses its soft question
  // budget (AC6). The dispatcher (FORGE-98) computes this via
  // decision-classifier.computeTaskBudget + buildSoftCapWarning and passes it in;
  // absent → the {{BUDGET_WARNING}} slot renders "(none)".
  readonly softCapWarning?: string;
}

// Allowlisted placeholder tokens. Adding a new token requires touching this
// set and the template in lockstep — caught at test time.
const PLACEHOLDERS = new Set([
  'TASK_ID',
  'ATTEMPT_ID',
  'RUN_ID',
  'WORKTREE_PATH',
  'PHASE',
  'TASK_DESCRIPTION',
  'ACCEPTANCE_CRITERIA',
  'CONVENTIONS',
  'PRIOR_ATTEMPTS',
  'ANSWERED_QUESTIONS',
  'BUDGET_WARNING',
]);

function renderAcceptance(criteria: readonly string[]): string {
  if (criteria.length === 0) return '(none)';
  return criteria.map((c) => `- ${c}`).join('\n');
}

function renderPriorAttempts(attempts: readonly PriorAttemptSummary[]): string {
  if (attempts.length === 0) return '(none — this is the first attempt)';
  return attempts
    .map(
      (a) =>
        `- attempt ${a.attemptId}: ${a.status}${a.savePoint ? ` — ${a.savePoint}` : ''}`,
    )
    .join('\n');
}

function renderAnsweredQuestions(answers: readonly AnsweredQuestionSummary[]): string {
  if (answers.length === 0) return '(none)';
  return answers.map((a) => `- \`${a.decisionKey}\` → ${a.answer}`).join('\n');
}

function renderBudgetWarning(warning?: string): string {
  return warning && warning.length > 0 ? warning : '(none)';
}

function stripOtherHostBlocks(template: string, host: WorkerHost): string {
  // Match `<!-- host: <name> --> ... <!-- /host -->`. Non-greedy so two
  // adjacent blocks don't merge. Capture the host name to decide whether
  // to keep the body.
  const blockRe = /<!--\s*host:\s*([a-z]+)\s*-->([\s\S]*?)<!--\s*\/host\s*-->/g;
  const out = template.replace(blockRe, (_full, blockHost: string, body: string) => {
    return blockHost === host ? body : '';
  });

  // Detect unterminated blocks after stripping — a stray opening marker
  // means the template was malformed.
  const stray = out.match(/<!--\s*host:\s*([a-z]+)\s*-->/);
  if (stray) {
    throw new UnterminatedHostBlockError(stray[1] ?? '');
  }
  return out;
}

function substitutePlaceholders(
  template: string,
  values: Map<string, string>,
): string {
  return template.replace(/{{([A-Z_]+)}}/g, (_full, token: string) => {
    if (!PLACEHOLDERS.has(token)) {
      throw new UnknownPlaceholderError(token);
    }
    const value = values.get(token);
    if (value === undefined) {
      // The allowlist guarantees presence — if this fires, the renderer's
      // value map is out of sync with the allowlist (caller programming bug).
      throw new UnknownPlaceholderError(token);
    }
    return value;
  });
}

export function renderWorkerPrompt(template: string, ctx: WorkerPromptContext): string {
  const stripped = stripOtherHostBlocks(template, ctx.host);

  const values = new Map<string, string>([
    ['TASK_ID', ctx.taskId],
    ['ATTEMPT_ID', ctx.attemptId],
    ['RUN_ID', ctx.runId],
    ['WORKTREE_PATH', ctx.worktreePath],
    ['PHASE', ctx.phase],
    ['TASK_DESCRIPTION', ctx.taskDescription],
    ['ACCEPTANCE_CRITERIA', renderAcceptance(ctx.acceptanceCriteria)],
    ['CONVENTIONS', ctx.conventions],
    ['PRIOR_ATTEMPTS', renderPriorAttempts(ctx.priorAttempts)],
    ['ANSWERED_QUESTIONS', renderAnsweredQuestions(ctx.answeredQuestions)],
    ['BUDGET_WARNING', renderBudgetWarning(ctx.softCapWarning)],
  ]);

  return substitutePlaceholders(stripped, values);
}
