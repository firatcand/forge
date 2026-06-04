import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateRenderWorkerPrompt } from '../../../../src/cli/orchestrate/render-worker-prompt.ts';

// Fixture builder: minimal repo tree with phases.yaml, CLAUDE.md, settings.yaml,
// templates/worker-prompt.template.md, and a manifest.json under .forge/orchestrator.
function buildFixture(overrides: {
  taskId?: string;
  attemptId?: string;
  trackerIssueId?: string;
  withConventions?: boolean;
  withSettings?: boolean;
  withTemplate?: boolean;
  withManifest?: boolean;
  withTaskInPhases?: boolean;
  template?: string;
} = {}): {
  repoRoot: string;
  forgeDir: string;
  taskId: string;
  attemptId: string;
  cleanup: () => void;
} {
  const taskId = overrides.taskId ?? 'FORGE-300';
  const attemptId = overrides.attemptId ?? '01900000-0000-7000-8000-000000000010';
  const trackerIssueId = overrides.trackerIssueId ?? taskId;
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-render-wp-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(forgeDir, { recursive: true });

  if (overrides.withConventions !== false) {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# Project conventions\nTest convention block.\n');
  }

  if (overrides.withSettings !== false) {
    writeFileSync(join(forgeDir, 'settings.yaml'), "primary_host_cli: 'claude'\n");
  }

  if (overrides.withTemplate !== false) {
    mkdirSync(join(repoRoot, 'templates'), { recursive: true });
    const template = overrides.template ?? [
      '# Worker prompt — {{TASK_ID}}',
      'attempt={{ATTEMPT_ID}} run={{RUN_ID}} phase={{PHASE}}',
      'wt={{WORKTREE_PATH}}',
      '',
      '## Task',
      '{{TASK_DESCRIPTION}}',
      '',
      '## Acceptance',
      '{{ACCEPTANCE_CRITERIA}}',
      '',
      '## Conventions',
      '{{CONVENTIONS}}',
      '',
      '## Prior',
      '{{PRIOR_ATTEMPTS}}',
      '',
      '## Answered',
      '{{ANSWERED_QUESTIONS}}',
    ].join('\n');
    writeFileSync(join(repoRoot, 'templates', 'worker-prompt.template.md'), template);
  }

  if (overrides.withTaskInPhases !== false) {
    mkdirSync(join(repoRoot, 'plans'), { recursive: true });
    const phases = `project: test
gate_check_command: "npm test"
phases:
  - id: phase-1
    name: "Test phase"
    status: active
    goal: "Test goal"
    gate_criteria:
      - "All tests pass"
    tasks:
      - id: P1-T01
        tracker_issue_id: "${trackerIssueId}"
        title: "Test task"
        description: "Implement the test feature with care."
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        acceptance:
          - "test passes"
          - "no regressions"
`;
    writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), phases);
  }

  if (overrides.withManifest !== false) {
    const manifestDir = join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        attempt_id: attemptId,
        task_id: taskId,
        run_id: '01900000-0000-7000-8000-aaaaaaaaaaaa',
        claim_id: '01900000-0000-7000-8000-bbbbbbbbbbbb',
        generation: 1,
        phase: 'implement',
        worktree_path: join(repoRoot, '.forge', 'worktrees', taskId),
        dispatched_at: '2026-05-18T01:00:00.000Z',
      }, null, 2),
    );
  }

  return {
    repoRoot,
    forgeDir,
    taskId,
    attemptId,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

function captureStdout(t: { after: (fn: () => void) => void }): { lines: string[] } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return { lines: captured };
}

function lastEnvelope(lines: string[]) {
  const last = lines[lines.length - 1] ?? '';
  return JSON.parse(last);
}

test('render-worker-prompt: happy path returns rendered prompt with all placeholders substituted', async (t) => {
  const fix = buildFixture();
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  const prompt: string = env.data.prompt;
  assert.match(prompt, /Worker prompt — FORGE-300/);
  assert.match(prompt, /Implement the test feature/);
  assert.match(prompt, /- test passes/);
  assert.match(prompt, /- no regressions/);
  assert.match(prompt, /Test convention block/);
  assert.match(prompt, /PHASE=IMPLEMENT|phase=IMPLEMENT/);
  // Empty prior + answered render as their "none" lines.
  assert.match(prompt, /\(none — this is the first attempt\)/);
  assert.match(prompt, /\(none\)/);
});

test('render-worker-prompt: missing attempt manifest returns ATTEMPT_NOT_FOUND', async (t) => {
  const fix = buildFixture({ withManifest: false });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'ATTEMPT_NOT_FOUND');
});

test('render-worker-prompt: task not in phases.yaml returns TASK_NOT_IN_PHASES', async (t) => {
  const fix = buildFixture({ trackerIssueId: 'FORGE-DIFFERENT' });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error.code, 'TASK_NOT_IN_PHASES');
});

test('render-worker-prompt: missing template returns TEMPLATE_NOT_FOUND', async (t) => {
  const fix = buildFixture({ withTemplate: false });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error.code, 'TEMPLATE_NOT_FOUND');
});

test('render-worker-prompt: missing phases.yaml returns PHASES_NOT_FOUND', async (t) => {
  const fix = buildFixture({ withTaskInPhases: false });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error.code, 'PHASES_NOT_FOUND');
});

test('render-worker-prompt: missing CLAUDE.md/AGENTS.md falls back to empty conventions', async (t) => {
  const fix = buildFixture({ withConventions: false });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  // Conventions section exists, content is empty — section header still present.
  assert.match(env.data.prompt, /## Conventions/);
});

test('render-worker-prompt: settings.yaml absent defaults host to "claude"', async (t) => {
  const fix = buildFixture({ withSettings: false });
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.data.host, 'claude');
});

test('render-worker-prompt: malformed task_id rejected by schema (INVALID_ARGS)', async (t) => {
  const fix = buildFixture();
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: 'not-a-tracker-id',
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = lastEnvelope(lines);
  assert.equal(env.error.code, 'INVALID_ARGS');
});

// FORGE-65 / #243: the CLI verb must resolve the question budget (global
// settings, overridable per-task), count prior questions, and surface the
// soft-cap warning + counts in the envelope. Covers the verb-level
// budget-resolution branch directly (library-level coverage exists separately).
test('render-worker-prompt: soft cap exceeded surfaces soft_cap_warning + counts in envelope', async (t) => {
  const fix = buildFixture();
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  // Lower the global soft cap to 1, then seed one prior question on this attempt
  // so count(1) >= soft(1) → softExceeded.
  writeFileSync(
    join(fix.forgeDir, 'settings.yaml'),
    "primary_host_cli: 'claude'\nagents:\n  question_budget:\n    soft: 1\n    hard: 2\n",
  );
  const questionsDir = join(
    fix.forgeDir, 'orchestrator', 'tasks', fix.taskId, 'attempts', fix.attemptId, 'questions',
  );
  mkdirSync(questionsDir, { recursive: true });
  writeFileSync(join(questionsDir, '01900000-0000-7000-8000-000000000099.json'), '{}');

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data.question_count, 1);
  assert.equal(env.data.question_budget.soft, 1);
  assert.equal(env.data.question_budget.hard, 2);
  assert.match(env.data.soft_cap_warning, /Question budget/);
  assert.match(env.data.soft_cap_warning, /soft cap 1/);
});

test('render-worker-prompt: below soft cap omits soft_cap_warning', async (t) => {
  // Default budget (soft 3 / hard 6) with zero prior questions → no warning.
  const fix = buildFixture();
  const { lines } = captureStdout(t);
  t.after(fix.cleanup);

  const result = await runOrchestrateRenderWorkerPrompt({
    taskId: fix.taskId,
    attemptId: fix.attemptId,
    forgeDir: fix.forgeDir,
    repoRoot: fix.repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = lastEnvelope(lines);
  assert.equal(env.ok, true);
  assert.equal(env.data.question_count, 0);
  assert.equal(env.data.soft_cap_warning, undefined);
});
