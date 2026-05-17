import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateHeartbeat } from '../../../../src/cli/orchestrate/heartbeat.ts';
import { runOrchestrateQuestionWrite } from '../../../../src/cli/orchestrate/question-write.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

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
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.ok(env.data.question_id);
  // Question file written.
  const qDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'questions');
  const files = readdirSync(qDir);
  assert.equal(files.length, 1);
  const qData = JSON.parse(readFileSync(join(qDir, files[0]!), 'utf8'));
  assert.equal(qData.question, 'Should we do X or Y?');
  assert.equal(qData.decision_key, 'arch:foo-vs-bar:hash');
  // State transitioned.
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'blocked_on_question');
});

test('question write echoes --drift-event-id + --routing-hint into envelope', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const result = await runOrchestrateQuestionWrite({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    decisionKey: 'drift:spec-vs-impl:abc',
    question: 'SPEC and impl disagree — which wins?',
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
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_OPTIONS_FILE');
});
