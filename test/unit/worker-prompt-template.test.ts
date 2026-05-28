// Template-shape contract for `templates/worker-prompt.template.md`.
//
// These tests assert structural promises of the v0.4 template:
//   - authority-by-field matrix (5 rows)
//   - at least 3 worked examples
//   - §Preflight wrapper section referencing `guardrail-check`
//   - allowlisted placeholder tokens (matches src/orchestrator/render-worker-prompt.ts)
//   - host-conditional blocks balanced
//   - NO references to the dropped 6-level chain / drift protocol
//
// If you legitimately need to change the template's shape, update both this
// test and the renderer's PLACEHOLDERS set in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderWorkerPrompt,
  type WorkerPromptContext,
} from '../../src/orchestrator/render-worker-prompt.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '../../templates/worker-prompt.template.md');
const template = readFileSync(templatePath, 'utf8');

test('template: contains authority-by-field matrix with 5 rows', () => {
  assert.match(template, /Authority by field/i);
  // Each row's leading artifact label appears in the matrix.
  assert.match(template, /`spec\/SPEC\.md`/);
  assert.match(template, /`spec\/PRD\.md`/);
  assert.match(template, /`plans\/phases\.yaml`/);
  assert.match(template, /Tracker issue body/);
  assert.match(template, /Source code/);
});

test('template: includes at least 3 worked examples', () => {
  const matches = template.match(/^### Example \d/gm) ?? [];
  assert.ok(matches.length >= 3, `expected ≥3 worked examples, got ${matches.length}`);
});

test('template: contains §Preflight wrapper section referencing guardrail-check verb', () => {
  assert.match(template, /Preflight wrapper/i);
  assert.match(template, /forge orchestrate guardrail-check/);
  assert.match(template, /agents\.preflight_globs/);
});

test('template: lists the spec default guardrail globs', () => {
  for (const glob of [
    'src/index.ts',
    'src/schemas/\\*\\*',
    'src/bin/\\*\\*',
    'src/cli/\\*\\*',
    'src/trackers/base.ts',
    'src/cli/migrate.ts',
    'spec/\\*\\*',
    'CRITICAL.md',
    'CLAUDE.md',
    'AGENTS.md',
    'package.json',
    'phases.yaml',
  ]) {
    assert.match(template, new RegExp(glob), `expected template to mention ${glob}`);
  }
});

test('template: contains allowlisted placeholder tokens', () => {
  for (const token of [
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
  ]) {
    assert.match(template, new RegExp(`{{${token}}}`), `expected {{${token}}} placeholder`);
  }
});

test('template: documents the required question flags (FORGE-65)', () => {
  // The question verb now rejects writes without these; the documented worker
  // flow must include them or the primary path fails before the gate.
  assert.match(template, /--recommended-option-id/, 'expected --recommended-option-id in the question invocation');
  assert.match(template, /--what-happens-if-unanswered/, 'expected --what-happens-if-unanswered in the question invocation');
});

test('template: every {{TOKEN}} in the template is in the allowlist', () => {
  const ALLOWLIST = new Set([
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
  const used = new Set<string>();
  for (const m of template.matchAll(/{{([A-Z_]+)}}/g)) {
    used.add(m[1]!);
  }
  for (const tok of used) {
    assert.ok(ALLOWLIST.has(tok), `template uses {{${tok}}} but it is not in the renderer allowlist`);
  }
});

test('template: host blocks balance (claude, codex, gemini all pair open/close)', () => {
  // FORGE-88: gemini joined the supported host list.
  const openCount = (template.match(/<!--\s*host:\s*[a-z]+\s*-->/g) ?? []).length;
  const closeCount = (template.match(/<!--\s*\/host\s*-->/g) ?? []).length;
  assert.equal(openCount, closeCount, 'unbalanced host markers');
  assert.ok(openCount >= 3, 'expected at least one claude + codex + gemini host block');
  for (const host of ['claude', 'codex', 'gemini']) {
    assert.match(template, new RegExp(`<!--\\s*host:\\s*${host}\\s*-->`));
  }
});

test('template: worked examples agree with the authority-by-field matrix', () => {
  // Regression guard for the Codex/code-reviewer finding on FORGE-97:
  // Example 1 originally said "tracker body owns scope," contradicting
  // the matrix row that gives Tracker only metadata. Catch any future
  // regression that puts "scope" into a tracker-ownership claim.
  const tracker = /Tracker issue body[^|]*\|([^|]+)\|/i.exec(template);
  assert.ok(tracker, 'expected a Tracker matrix row');
  const trackerOwns = tracker[1] ?? '';
  assert.doesNotMatch(
    trackerOwns,
    /\bscope\b/i,
    `Tracker row must not claim ownership of "scope" — belongs to PRD/phases.yaml. Got: "${trackerOwns.trim()}"`,
  );
});

test('template: preflight wrapper does NOT claim mechanical enforcement (v0.4)', () => {
  // BLOCK B2: prompt originally claimed `forge orchestrate complete` already
  // cross-references guardrail events and rejects on skip. That's
  // FORGE-FOLLOWUP-A and not in this PR. Soften to honest framing.
  const preflightSection = template.split(/^# Preflight wrapper/m)[1] ?? '';
  // Must reference "forthcoming" / "follow-up" / "planned" to signal deferred.
  assert.match(
    preflightSection,
    /forthcoming|follow-?up|planned/i,
    'preflight wrapper must label complete-enforcement as deferred',
  );
});

test('template: forbidden strings — no drift/6-level/ADR-hydration references', () => {
  // These were the dropped concepts from the 2026-05-17 PM pivot.
  const forbidden = [
    'drift_event_id',
    'routing_hint',
    '--drift-event-id',
    '--type drift',
    'Active ADRs that may affect this task',
    '6-level',
    '6 levels',
    'precedence chain',
  ];
  for (const needle of forbidden) {
    assert.doesNotMatch(template, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `template must not reference '${needle}' (dropped in 2026-05-17 PM pivot)`);
  }
});

test('template: end-to-end render against a realistic context succeeds', () => {
  const ctx: WorkerPromptContext = {
    taskId: 'FORGE-97',
    attemptId: 'attempt-zyx',
    runId: 'run-abc',
    worktreePath: '/Users/me/repos/forge/.forge/worktrees/FORGE-97',
    phase: 'IMPLEMENT',
    taskDescription: 'Rewrite the worker prompt for authority-by-field.',
    acceptanceCriteria: [
      'templates/worker-prompt.template.md exists',
      'renderer is pure and allowlisted',
    ],
    conventions: '## Project conventions\nFunctional components only.',
    host: 'claude',
    priorAttempts: [],
    answeredQuestions: [],
  };
  const out = renderWorkerPrompt(template, ctx);
  // No surviving {{TOKEN}} placeholders.
  assert.doesNotMatch(out, /{{[A-Z_]+}}/);
  // Claude block was kept.
  assert.match(out, /All Bash commands must be prefixed with `cd \/Users\/me\/repos/);
  // Codex block was stripped.
  assert.doesNotMatch(out, /Codex's sandbox already pins/);
  // Allowlisted-token content survived.
  assert.match(out, /FORGE-97/);
  assert.match(out, /attempt-zyx/);
  assert.match(out, /templates\/worker-prompt\.template\.md exists/);
});

test('template: end-to-end render for codex host strips claude and gemini blocks', () => {
  const ctx: WorkerPromptContext = {
    taskId: 'FORGE-97',
    attemptId: 'a',
    runId: 'r',
    worktreePath: '/wt',
    phase: 'REVIEW',
    taskDescription: '...',
    acceptanceCriteria: ['x'],
    conventions: '',
    host: 'codex',
    priorAttempts: [],
    answeredQuestions: [],
  };
  const out = renderWorkerPrompt(template, ctx);
  assert.match(out, /Codex's sandbox already pins/);
  assert.doesNotMatch(out, /All Bash commands must be prefixed with `cd/);
  assert.doesNotMatch(out, /orchestrator spawned `gemini`/);
});

test('template: end-to-end render for gemini host strips claude and codex blocks (FORGE-88)', () => {
  const ctx: WorkerPromptContext = {
    taskId: 'FORGE-88',
    attemptId: 'a',
    runId: 'r',
    worktreePath: '/Users/me/repos/forge/.forge/worktrees/FORGE-88',
    phase: 'IMPLEMENT',
    taskDescription: '...',
    acceptanceCriteria: ['x'],
    conventions: '',
    host: 'gemini',
    priorAttempts: [],
    answeredQuestions: [],
  };
  const out = renderWorkerPrompt(template, ctx);
  // Gemini block survived — references gemini-spawn semantics + process.cwd().
  assert.match(out, /orchestrator spawned `gemini`/);
  assert.match(out, /process\.cwd\(\)/);
  // WORKTREE_PATH substitution worked inside the gemini block.
  assert.match(out, /\/Users\/me\/repos\/forge\/\.forge\/worktrees\/FORGE-88/);
  // Sibling host blocks removed.
  assert.doesNotMatch(out, /All Bash commands must be prefixed with `cd/);
  assert.doesNotMatch(out, /Codex's sandbox already pins/);
});
