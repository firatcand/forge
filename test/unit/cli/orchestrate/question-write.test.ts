import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateHeartbeat } from '../../../../src/cli/orchestrate/heartbeat.ts';
import { runOrchestrateComplete } from '../../../../src/cli/orchestrate/complete.ts';
import { runOrchestrateQuestionWrite, questionWriteHandler } from '../../../../src/cli/orchestrate/question-write.ts';
import { readLease, callerFromLease } from '../../../../src/cli/orchestrate/lease-io.ts';
import { readTaskState, writeTaskState } from '../../../../src/orchestrator/state-machine.ts';
import { writeAnswerAtomic } from '../../../../src/orchestrator/questions/index.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

const REQUIRED = {
  recommendedOptionId: 'yes',
  whatHappensIfUnanswered: 'Block the task until the supervisor answers.',
} as const;

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return buf;
}

class StubTracker implements ClaimableTracker {
  readonly type = 'stub';
  async claim(): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(): Promise<void> {}
  async setClaimFence(): Promise<void> {}
}

async function setupRunning(stdout: string[]): Promise<{
  forgeDir: string;
  repoRoot: string;
  runId: string;
  claimId: string;
  attemptId: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-qw-'));
  const forgeDir = join(repoRoot, '.forge');
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  const claimEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: claimEnv.data.claim_id,
    runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir,
    json: true,
  });
  const dispatchEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  await runOrchestrateHeartbeat({
    taskId: 'FORGE-1',
    attemptId: dispatchEnv.data.attempt_id,
    forgeDir,
    json: true,
  });
  stdout.length = 0;
  return {
    forgeDir,
    repoRoot,
    runId,
    claimId: claimEnv.data.claim_id,
    attemptId: dispatchEnv.data.attempt_id,
  };
}

test('question write succeeds, transitions to blocked_on_question', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const optionsFile = join(ctx.repoRoot, 'options.json');
  writeFileSync(
    optionsFile,
    JSON.stringify([
      { id: 'yes', label: 'Yes, do it' },
      { id: 'no', label: 'No, skip it' },
    ]),
    'utf8',
  );
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:foo-vs-bar:hash',
    question: 'Should we do X or Y?',
    optionsFile,
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'We block the task until resolved.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.outcome, 'written');
  assert.ok(env.data.question_id);
  // Question file written.
  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  const files = readdirSync(qDir);
  assert.equal(files.length, 1);
  const qData = JSON.parse(readFileSync(join(qDir, files[0]!), 'utf8'));
  assert.equal(qData.question, 'Should we do X or Y?');
  assert.equal(qData.decision_key, 'arch:foo-vs-bar:hash');
  // AC8: required fields are persisted on the written question.
  assert.equal(qData.recommended_option_id, 'yes');
  assert.equal(qData.what_happens_if_unanswered, 'We block the task until resolved.');
  // State transitioned.
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'blocked_on_question');
});

test('FORGE-216: --classification-file persists the supplied category (producer path)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const classificationFile = join(ctx.repoRoot, 'classification.json');
  writeFileSync(
    classificationFile,
    JSON.stringify({
      decision_type: 'architectural',
      category: 'schema_shape',
      reversibility: 'low',
      blast_radius: 'project',
      default_action: 'ask',
      reason: 'Schema fork consumed downstream.',
    }),
    'utf8',
  );
  // Drive through the PUBLIC handler so the new --classification-file flag
  // parsing in index.ts/question-write.ts is exercised end-to-end.
  const result = await questionWriteHandler.run(
    [
      '--task', 'FORGE-1',
      '--attempt', ctx.attemptId,
      '--decision-key', 'arch:schema-fork:hash',
      '--question', 'Fork the schema or extend it?',
      '--recommended-option-id', 'yes',
      '--what-happens-if-unanswered', 'Block until resolved.',
      '--classification-file', classificationFile,
      '--forge-dir', ctx.forgeDir,
      '--json',
    ],
    { cwd: ctx.repoRoot },
  );
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.outcome, 'written');
  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  const files = readdirSync(qDir);
  assert.equal(files.length, 1);
  const qData = JSON.parse(readFileSync(join(qDir, files[0]!), 'utf8'));
  // The supplied category is persisted — NOT the DEFAULT_CLASSIFICATION 'other'.
  assert.equal(qData.classification.category, 'schema_shape');
});

test('FORGE-216: an explicitly-supplied but invalid --classification-file fails (no fallback to other)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const bad = join(ctx.repoRoot, 'bad-classification.json');
  // Valid JSON, but an unknown category → schema rejects it.
  writeFileSync(
    bad,
    JSON.stringify({
      decision_type: 'architectural',
      category: 'not_a_real_category',
      reversibility: 'low',
      blast_radius: 'project',
      default_action: 'ask',
      reason: 'bogus',
    }),
    'utf8',
  );
  const result = await runOrchestrateQuestionWrite(
    {
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      decisionKey: 'arch:bad:hash',
      question: 'Q?',
      recommendedOptionId: 'yes',
      whatHappensIfUnanswered: 'Block.',
      forgeDir: ctx.forgeDir,
      json: true,
    },
    { classificationFile: bad },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_CLASSIFICATION');
});

test('question write echoes --drift-event-id + --routing-hint into envelope', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'drift:spec-vs-impl:abc',
    question: 'SPEC and impl disagree — which wins?',
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'Default to SPEC and proceed.',
    forgeDir: ctx.forgeDir,
    json: true,
    driftEventId: 'evt-7',
    routingHint: 'amend-roadmap',
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.drift_event_id, 'evt-7');
  assert.equal(env.data.routing_hint, 'amend-roadmap');
});

test('question write fails when options-file is malformed', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const bad = join(ctx.repoRoot, 'bad.json');
  writeFileSync(bad, 'not-json', 'utf8');
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:x:y',
    question: 'Q?',
    optionsFile: bad,
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'Block until resolved.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_OPTIONS_FILE');
});

// --- AC8: required fields enforced at the verb -------------------------------

test('AC8: missing --recommended-option-id is rejected with MISSING_REQUIRED_FIELD', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:x:y',
    question: 'Q?',
    whatHappensIfUnanswered: 'Block until resolved.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'MISSING_REQUIRED_FIELD');
});

test('AC8: missing --what-happens-if-unanswered is rejected with MISSING_REQUIRED_FIELD', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:x:y',
    question: 'Q?',
    recommendedOptionId: 'yes',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'MISSING_REQUIRED_FIELD');
});

test('AC8: --recommended-option-id that is not one of the options → INVALID_RECOMMENDED_OPTION', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:x:y',
    question: 'Q?',
    recommendedOptionId: 'maybe', // default options are yes/no
    whatHappensIfUnanswered: 'Block until resolved.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_RECOMMENDED_OPTION');
});

test('a malformed settings.yaml surfaces SETTINGS_LOAD_ERROR (not silently defaulted)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Present-but-invalid settings.yaml → must surface, not fall back to defaults.
  writeFileSync(join(ctx.forgeDir, 'settings.yaml'), 'tracker:\n  type: bogus\n', 'utf8');
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:x:y',
    question: 'Q?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'SETTINGS_LOAD_ERROR');
});

// --- AC4 / AC5 / AC7: gate outcomes through the verb -------------------------

test('AC4: a second call for an answered decision_key returns outcome=reused, no new file', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const write1 = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:reuse',
    question: 'First ask?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(write1.exitCode, 0);
  const env1 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env1.data.outcome, 'written');

  // Supervisor answers it.
  writeAnswerAtomic(
    {
      version: 1,
      question_id: env1.data.question_id,
      answered_at: new Date().toISOString(),
      answered_by: 'supervisor',
      option_id: 'yes',
    },
    { forgeDir: ctx.forgeDir, taskId: 'FORGE-1', attemptId: ctx.attemptId },
  );

  // Respawned worker re-encounters the same decision_key.
  const write2 = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:reuse',
    question: 'First ask?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(write2.exitCode, 0);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.data.outcome, 'reused');
  assert.equal(env2.data.option_id, 'yes');

  // Still exactly one question file — no duplicate write.
  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  assert.equal(readdirSync(qDir).length, 1);
});

test('AC5: a second call for an open decision_key returns outcome=blocked_on_existing, no new file', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:pending',
    question: 'Pending ask?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  const env1 = JSON.parse(stdout[stdout.length - 1] ?? '');
  const firstId = env1.data.question_id;

  const write2 = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:pending',
    question: 'Pending ask?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(write2.exitCode, 0);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.data.outcome, 'blocked_on_existing');
  assert.equal(env2.data.question_id, firstId);

  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  assert.equal(readdirSync(qDir).length, 1);
});

test('DECISION_KEY_EXHAUSTED: prior closed max attempt marks task failed', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const first = await runOrchestrateQuestionWrite(
    {
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      decisionKey: 'arch:exhaust',
      question: 'First ask?',
      ...REQUIRED,
      forgeDir: ctx.forgeDir,
      json: true,
    },
    { maxAttempts: 1 },
  );
  assert.equal(first.exitCode, 0);
  const env1 = JSON.parse(stdout[stdout.length - 1] ?? '');
  const qPath = join(
    ctx.forgeDir,
    'orchestrator/tasks/FORGE-1/attempts',
    ctx.attemptId,
    'questions',
    `${env1.data.question_id}.json`,
  );
  const qData = JSON.parse(readFileSync(qPath, 'utf8'));
  writeFileSync(qPath, JSON.stringify({ ...qData, status: 'expired' }), 'utf8');

  const second = await runOrchestrateQuestionWrite(
    {
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      decisionKey: 'arch:exhaust',
      question: 'Second ask?',
      ...REQUIRED,
      forgeDir: ctx.forgeDir,
      json: true,
    },
    { maxAttempts: 1 },
  );
  assert.equal(second.exitCode, 0);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.data.outcome, 'decision_key_exhausted');
  assert.equal(env2.data.failure_reason, 'decision_key_budget');

  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'failed');
  assert.equal(state.failure_reason, 'decision_key_budget');
  assert.equal(typeof state.last_failed_at, 'string');
});

test('AC7: hard_cap reached → outcome=forced_autonomous + autonomous_decision event logged', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Default budget (no settings.yaml in fixture) is soft 3 / hard 6.
  for (let i = 0; i < 6; i++) {
    const r = await runOrchestrateQuestionWrite({
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      decisionKey: `arch:k${i}`,
      question: `Ask ${i}?`,
      ...REQUIRED,
      forgeDir: ctx.forgeDir,
      json: true,
    });
    assert.equal(r.exitCode, 0, `write ${i} should succeed`);
    const env = JSON.parse(stdout[stdout.length - 1] ?? '');
    assert.equal(env.data.outcome, 'written');
  }

  // 7th distinct question — over the hard cap → forced autonomous.
  const forced = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:over-cap',
    question: 'One too many?',
    ...REQUIRED,
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(forced.exitCode, 0);
  const fenv = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(fenv.data.outcome, 'forced_autonomous');
  assert.equal(fenv.data.chosen_option_id, 'yes');

  // Still only 6 question files — the 7th was NOT written.
  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  assert.equal(readdirSync(qDir).length, 6);

  // The autonomous decision is logged in the attempt event stream.
  const eventsPath = join(
    ctx.forgeDir,
    'orchestrator/tasks/FORGE-1/attempts',
    ctx.attemptId,
    'events.jsonl',
  );
  const events = readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const auto = events.find((e) => e.type === 'autonomous_decision');
  assert.ok(auto, 'expected an autonomous_decision event');
  assert.equal(auto.decision_key, 'arch:over-cap');
  assert.equal(auto.chosen_option_id, 'yes');
  assert.match(auto.reason, /hard_cap/);
});

// --- FORGE-184: park architectural escalations from ready_for_review ----------

function readyForReviewVerdict(branch: string): unknown {
  return {
    version: 1,
    verdict: 'ready_for_review',
    summary: 'implement phase complete',
    tests: { ran: true, passed: 1, failed: 0, skipped: 0, duration_ms: 1, output_excerpt: '' },
    lint: { ran: true, clean: true, violations: 0, output_excerpt: '' },
    branch,
    save_point: '',
  };
}

// Drive a freshly-running task to ready_for_review via `complete --phase implement`.
async function completeToReadyForReview(
  ctx: { forgeDir: string; repoRoot: string; attemptId: string },
): Promise<void> {
  const verdictFile = join(ctx.repoRoot, 'verdict.json');
  writeFileSync(verdictFile, JSON.stringify(readyForReviewVerdict('feat/FORGE-1')), 'utf8');
  await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
}

test('FORGE-184: a ready_for_review task parks on question_written', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  await completeToReadyForReview(ctx);
  // Sanity: we are in ready_for_review before the question.
  {
    const pre = JSON.parse(
      readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
    );
    assert.equal(pre.state, 'ready_for_review');
  }
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:review-escalation:abc',
    question: 'This change needs an architectural decision — escalate?',
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'Block review until the supervisor decides.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'blocked_on_question');
});

test('FORGE-184 regression: a running task still parks on question_written', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:running-park:def',
    question: 'Should we do X or Y?',
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'Block the task until resolved.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'blocked_on_question');
});

test('FORGE-184: a reviewed task does NOT transition on question_written', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  await completeToReadyForReview(ctx);
  // Advance ready_for_review → reviewed. We hold the lease (claim never
  // released through ready_for_review), so write the state transition directly
  // via the state machine rather than minting a second attempt's verdict.json.
  {
    const lease = readLease(ctx.forgeDir, 'FORGE-1');
    const cur = readTaskState(ctx.forgeDir, 'FORGE-1');
    writeTaskState(
      ctx.forgeDir,
      {
        ...cur,
        state: 'reviewed',
        state_version: cur.state_version + 1,
        updated_at: new Date().toISOString(),
        updated_by: callerFromLease(lease),
      },
      callerFromLease(lease),
    );
  }
  {
    const pre = JSON.parse(
      readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
    );
    assert.equal(pre.state, 'reviewed');
  }
  // The question still writes, but the best-effort transition is a no-op from
  // 'reviewed' (only running/ready_for_review park).
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'arch:reviewed-noop:ghi',
    question: 'Late question — should not move a reviewed task.',
    recommendedOptionId: 'yes',
    whatHappensIfUnanswered: 'No transition expected.',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'reviewed');
});

test('FORGE-216: --classification-file that is not a regular file (a directory) fails the capped read', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // A directory at the classification-file path → readSidecarCapped rejects
  // (lstat !isFile) before any read, no crash.
  const dirPath = join(ctx.repoRoot, 'classification-dir');
  mkdirSync(dirPath, { recursive: true });
  const result = await runOrchestrateQuestionWrite(
    {
      taskId: 'FORGE-1',
      attemptId: ctx.attemptId,
      decisionKey: 'arch:dir:hash',
      question: 'Q?',
      recommendedOptionId: 'yes',
      whatHappensIfUnanswered: 'Block.',
      forgeDir: ctx.forgeDir,
      json: true,
    },
    { classificationFile: dirPath },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'CLASSIFICATION_FILE_READ_FAILED');
  assert.match(env.error.message, /not a regular file/);
});
