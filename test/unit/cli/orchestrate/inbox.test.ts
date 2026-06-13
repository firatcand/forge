import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runOrchestrateInbox } from '../../../../src/cli/orchestrate/inbox.ts';

function forgeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'forge-inbox-')), '.forge');
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (c: unknown) => {
      chunks.push(String(c));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => chunks.join('') };
}

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj), 'utf8');
}

function taskStateJson(forgeDir: string, taskId: string, state: string): void {
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'state.json'), {
    version: 1,
    task_id: taskId,
    state,
    state_version: 0,
    attempt_count: 1,
    current_attempt_id: null,
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'run-seed', claim_id: 'claim-seed', generation: 0 },
  });
}

function questionJson(
  forgeDir: string,
  taskId: string,
  attemptId: string,
  questionId: string,
  decisionKey: string,
  decisionType: 'routine' | 'architectural' = 'architectural',
): void {
  const created = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  writeJson(
    join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', attemptId, 'questions', `${questionId}.json`),
    {
      version: 1,
      question_id: questionId,
      run_id: 'run-q',
      task_id: taskId,
      agent_id: 'worker',
      decision_key: decisionKey,
      attempt: 1,
      max_attempts: 3,
      created_at: created,
      expires_at: expires,
      status: 'open',
      question: 'Which approach?',
      context: '',
      options: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
      recommended_option_id: 'a',
      what_happens_if_unanswered: 'Block until answered.',
      classification: {
        decision_type: decisionType,
        category: 'scope',
        reversibility: 'medium',
        blast_radius: 'module',
        default_action: 'ask',
        reason: 'needs human input',
      },
    },
  );
}

test('inbox lists only blocked_on_question tasks with correlated, classified questions', () => {
  const forgeDir = forgeRoot();
  taskStateJson(forgeDir, 'P1-T1', 'blocked_on_question');
  questionJson(forgeDir, 'P1-T1', 'att-1', '00000000-0000-7000-8000-000000000001', 'arch:x', 'architectural');
  taskStateJson(forgeDir, 'P1-T2', 'running'); // not parked
  questionJson(forgeDir, 'P1-T2', 'att-1', '00000000-0000-7000-8000-000000000002', 'arch:y');

  const out = capture();
  const res = runOrchestrateInbox({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data.parked_tasks.length, 1);
  const t = env.data.parked_tasks[0];
  assert.equal(t.task_id, 'P1-T1');
  assert.equal(t.state, 'blocked_on_question');
  assert.equal(t.open_questions.length, 1);
  const q = t.open_questions[0];
  assert.equal(q.decision_key, 'arch:x');
  assert.equal(q.recommended_option_id, 'a');
  assert.equal(q.classification.decision_type, 'architectural');
  assert.ok(q.created_at);
});

test('inbox: a parked task with no open questions still lists with open_questions: []', () => {
  const forgeDir = forgeRoot();
  taskStateJson(forgeDir, 'P1-T1', 'blocked_on_question');
  const out = capture();
  runOrchestrateInbox({ forgeDir, json: true, stdout: out.stream });
  const env = JSON.parse(out.text());
  assert.equal(env.data.parked_tasks.length, 1);
  assert.deepEqual(env.data.parked_tasks[0].open_questions, []);
});

test('inbox: corrupt state.json is tolerated (skipped)', () => {
  const forgeDir = forgeRoot();
  taskStateJson(forgeDir, 'P1-T1', 'blocked_on_question');
  mkdirSync(join(forgeDir, 'orchestrator', 'tasks', 'P1-T2'), { recursive: true });
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'P1-T2', 'state.json'), 'not-json', 'utf8');
  const out = capture();
  const res = runOrchestrateInbox({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.deepEqual(
    env.data.parked_tasks.map((t: { task_id: string }) => t.task_id),
    ['P1-T1'],
  );
});

test('inbox: empty → { parked_tasks: [] }', () => {
  const forgeDir = forgeRoot();
  const out = capture();
  const res = runOrchestrateInbox({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.deepEqual(env.data.parked_tasks, []);
});
