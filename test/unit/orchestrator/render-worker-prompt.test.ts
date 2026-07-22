import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderWorkerPrompt,
  UnknownPlaceholderError,
  UnterminatedHostBlockError,
  type WorkerPromptContext,
} from '../../../src/orchestrator/render-worker-prompt.ts';

function baseCtx(overrides: Partial<WorkerPromptContext> = {}): WorkerPromptContext {
  return {
    taskId: 'FORGE-1',
    attemptId: 'attempt-abc',
    runId: 'run-xyz',
    worktreePath: '/tmp/wt',
    phase: 'IMPLEMENT',
    taskDescription: 'Do the thing.',
    acceptanceCriteria: ['Bullet A', 'Bullet B'],
    conventions: '# Project conventions',
    host: 'claude',
    priorAttempts: [],
    answeredQuestions: [],
    ...overrides,
  };
}

test('renderer: substitutes all allowlisted placeholders', () => {
  const tmpl = [
    'task={{TASK_ID}}',
    'attempt={{ATTEMPT_ID}}',
    'run={{RUN_ID}}',
    'wt={{WORKTREE_PATH}}',
    'phase={{PHASE}}',
    'desc={{TASK_DESCRIPTION}}',
    'ac={{ACCEPTANCE_CRITERIA}}',
    'conv={{CONVENTIONS}}',
    'prior={{PRIOR_ATTEMPTS}}',
    'ans={{ANSWERED_QUESTIONS}}',
    'bw={{BUDGET_WARNING}}',
    'qb={{QUESTION_BUDGET_FLAGS}}',
  ].join('\n');
  const out = renderWorkerPrompt(tmpl, baseCtx({ questionBudget: { soft: 2, hard: 4 } }));
  assert.match(out, /task=FORGE-1/);
  assert.match(out, /attempt=attempt-abc/);
  assert.match(out, /phase=IMPLEMENT/);
  assert.match(out, /ac=- Bullet A\n- Bullet B/);
  assert.match(out, /qb=--question-budget-soft 2 --question-budget-hard 4/);
  // No surviving {{...}} placeholders.
  assert.doesNotMatch(out, /{{[A-Z_]+}}/);
});

test('renderer: {{BUDGET_WARNING}} injects the soft-cap warning when present (AC6)', () => {
  const tmpl = 'budget={{BUDGET_WARNING}}';
  const out = renderWorkerPrompt(
    tmpl,
    baseCtx({ softCapWarning: '⚠ Question budget: you have already asked 4 question(s)' }),
  );
  assert.match(out, /budget=⚠ Question budget: you have already asked 4 question\(s\)/);
});

test('renderer: {{BUDGET_WARNING}} renders (none) when no soft-cap warning is set', () => {
  const tmpl = '{{BUDGET_WARNING}}';
  assert.equal(renderWorkerPrompt(tmpl, baseCtx()), '(none)');
  assert.equal(renderWorkerPrompt(tmpl, baseCtx({ softCapWarning: '' })), '(none)');
});

test('renderer: {{QUESTION_BUDGET_FLAGS}} renders empty when no budget is set', () => {
  assert.equal(renderWorkerPrompt('{{QUESTION_BUDGET_FLAGS}}', baseCtx()), '');
});

test('renderer: throws UnknownPlaceholderError on unrecognized token', () => {
  const tmpl = 'header {{UNKNOWN_TOKEN}} footer';
  assert.throws(() => renderWorkerPrompt(tmpl, baseCtx()), UnknownPlaceholderError);
});

test('renderer: strips claude-host block when host=codex', () => {
  const tmpl = [
    'shared header',
    '<!-- host: claude -->',
    'Claude-only working-directory rules',
    '<!-- /host -->',
    'shared footer',
  ].join('\n');
  const out = renderWorkerPrompt(tmpl, baseCtx({ host: 'codex' }));
  assert.doesNotMatch(out, /Claude-only/);
  assert.match(out, /shared header/);
  assert.match(out, /shared footer/);
});

test('renderer: keeps claude-host block when host=claude', () => {
  const tmpl = [
    'shared header',
    '<!-- host: claude -->',
    'Claude-only working-directory rules',
    '<!-- /host -->',
    'shared footer',
  ].join('\n');
  const out = renderWorkerPrompt(tmpl, baseCtx({ host: 'claude' }));
  assert.match(out, /Claude-only working-directory rules/);
});

test('renderer: handles multiple host blocks for different hosts', () => {
  const tmpl = [
    '<!-- host: claude -->',
    'CLAUDE_ONLY',
    '<!-- /host -->',
    '<!-- host: codex -->',
    'CODEX_ONLY',
    '<!-- /host -->',
  ].join('\n');
  const claudeOut = renderWorkerPrompt(tmpl, baseCtx({ host: 'claude' }));
  assert.match(claudeOut, /CLAUDE_ONLY/);
  assert.doesNotMatch(claudeOut, /CODEX_ONLY/);
  const codexOut = renderWorkerPrompt(tmpl, baseCtx({ host: 'codex' }));
  assert.match(codexOut, /CODEX_ONLY/);
  assert.doesNotMatch(codexOut, /CLAUDE_ONLY/);
});

test('renderer: throws UnterminatedHostBlockError on unbalanced markers', () => {
  const tmpl = '<!-- host: claude --> unclosed body';
  assert.throws(() => renderWorkerPrompt(tmpl, baseCtx()), UnterminatedHostBlockError);
});

test('renderer: empty acceptanceCriteria renders as (none)', () => {
  const tmpl = '{{ACCEPTANCE_CRITERIA}}';
  const out = renderWorkerPrompt(tmpl, baseCtx({ acceptanceCriteria: [] }));
  assert.equal(out, '(none)');
});

test('renderer: empty priorAttempts renders as (none — this is the first attempt)', () => {
  const tmpl = '{{PRIOR_ATTEMPTS}}';
  const out = renderWorkerPrompt(tmpl, baseCtx({ priorAttempts: [] }));
  assert.equal(out, '(none — this is the first attempt)');
});

test('renderer: priorAttempts list formatting', () => {
  const tmpl = '{{PRIOR_ATTEMPTS}}';
  const out = renderWorkerPrompt(
    tmpl,
    baseCtx({
      priorAttempts: [
        { attemptId: 'a1', status: 'changes_needed', savePoint: 'failing tests in foo.test.ts' },
        { attemptId: 'a2', status: 'blocked' },
      ],
    }),
  );
  assert.match(out, /- attempt a1: changes_needed — failing tests in foo\.test\.ts/);
  assert.match(out, /- attempt a2: blocked\b/);
});

test('renderer: answeredQuestions formatting', () => {
  const tmpl = '{{ANSWERED_QUESTIONS}}';
  const out = renderWorkerPrompt(
    tmpl,
    baseCtx({
      answeredQuestions: [
        { decisionKey: 'authority-collision:scope:retry-handling', answer: 'add retry; SPEC owns scope' },
      ],
    }),
  );
  assert.match(out, /`authority-collision:scope:retry-handling` → add retry/);
});

test('renderer: cross-product — host stripping × placeholder substitution', () => {
  // Codex worker, with Claude-specific block AND placeholders.
  const tmpl = [
    'Task: {{TASK_ID}}',
    '<!-- host: claude -->',
    'cd {{WORKTREE_PATH}} && do-claude-thing',
    '<!-- /host -->',
    'AC: {{ACCEPTANCE_CRITERIA}}',
  ].join('\n');
  const out = renderWorkerPrompt(tmpl, baseCtx({ host: 'codex' }));
  // Claude block stripped, including any placeholders inside it.
  assert.doesNotMatch(out, /cd \/tmp\/wt/);
  assert.doesNotMatch(out, /do-claude-thing/);
  // Outer placeholders still substituted.
  assert.match(out, /Task: FORGE-1/);
  assert.match(out, /AC: - Bullet A/);
});

test('renderer: placeholder INSIDE a stripped host block does not throw on unknown token', () => {
  // Stripping happens before substitution — unknown tokens in dead blocks are silently removed.
  const tmpl = [
    '<!-- host: claude -->',
    '{{NOT_A_REAL_TOKEN}}',
    '<!-- /host -->',
    'safe text',
  ].join('\n');
  const out = renderWorkerPrompt(tmpl, baseCtx({ host: 'codex' }));
  assert.match(out, /safe text/);
});

test('renderer: REVIEW phase with pinned SHAs renders the pinned-review contract', () => {
  const template = 'Phase: {{PHASE}}\n{{REVIEW_PINNING}}';
  const target = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const out = renderWorkerPrompt(template, {
    ...baseCtx(),
    phase: 'REVIEW',
    reviewTargetSha: target,
    reviewBaseSha: base,
  });
  assert.match(out, new RegExp(`git diff ${base}\\.\\.\\.${target}`));
  assert.match(out, new RegExp(`"target_sha": "${target}"`));
});

test('renderer: non-review phases render an empty pinning block', () => {
  const out = renderWorkerPrompt('X{{REVIEW_PINNING}}Y', { ...baseCtx(), phase: 'IMPLEMENT' });
  assert.equal(out, 'XY');
});
