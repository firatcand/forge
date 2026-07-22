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
// FORGE-160: cursor joins as a beta primary worker host. Its host block in
// templates/worker-prompt.template.md mirrors how gemini joined in FORGE-88.
export type WorkerHost = 'claude' | 'codex' | 'gemini' | 'cursor';

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
  // FORGE-231: review-phase pinning (both diff endpoints resolved at dispatch).
  readonly reviewTargetSha?: string;
  readonly reviewBaseSha?: string;
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
  readonly questionBudget?: {
    readonly soft: number;
    readonly hard: number;
  };
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
  'QUESTION_BUDGET_FLAGS',
  'REVIEW_PINNING',
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

function renderQuestionBudgetFlags(
  budget?: { readonly soft: number; readonly hard: number },
): string {
  if (!budget) return '';
  return `--question-budget-soft ${budget.soft} --question-budget-hard ${budget.hard}`;
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
    ['QUESTION_BUDGET_FLAGS', renderQuestionBudgetFlags(ctx.questionBudget)],
    ['REVIEW_PINNING', renderReviewPinning(ctx)],
  ]);

  return substitutePlaceholders(stripped, values);
}

// FORGE-231: the pinned-review contract block (empty outside REVIEW). The
// diff endpoints are IMMUTABLE SHAs pinned at dispatch time — the frozen base
// branch name plus the reviewed head; no floating refs appear in the range.
function renderReviewPinning(ctx: WorkerPromptContext): string {
  if (ctx.phase !== 'REVIEW' || !ctx.reviewTargetSha || !ctx.reviewBaseSha) return '';
  return [
    '# Pinned review contract (FORGE-231)',
    '',
    `You are reviewing EXACTLY the range \`git diff ${ctx.reviewBaseSha}...${ctx.reviewTargetSha}\` — both endpoints are pinned SHAs; never review a floating ref or the working tree.`,
    '',
    `Your verdict file (\`review_verdict.json\` in this attempt's directory) MUST include \`"target_sha": "${ctx.reviewTargetSha}"\` — the completion gate rejects any verdict that does not speak for this exact commit.`,
    '',
  ].join('\n');
}
