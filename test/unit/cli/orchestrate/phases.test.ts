import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestratePhases } from '../../../../src/cli/orchestrate/phases.ts';

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

function makeRepoWithPhases(phasesYaml: string): { repo: string; forgeDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'forge-phases-'));
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(join(repo, 'plans/phases.yaml'), phasesYaml, 'utf8');
  return { repo, forgeDir: join(repo, '.forge') };
}

const ONE_TASK = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build foundation
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        tracker_issue_id: FOO-1
        title: First task
        description: Implement the first task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
`;

const TWO_TASKS_WITH_DEP = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build foundation
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        tracker_issue_id: FOO-1
        title: First
        description: First task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
      - id: P1-T02
        tracker_issue_id: FOO-2
        title: Second
        description: Depends on first
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: [P1-T01]
        acceptance: [done]
`;

const TWO_TASKS_FIRST_DEFERRED = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build foundation
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        tracker_issue_id: FOO-1
        status: deferred-v0.5
        title: First (deferred)
        description: Deferred task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
      - id: P1-T02
        tracker_issue_id: FOO-2
        title: Second (depends on deferred)
        description: Depends on first
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: [P1-T01]
        acceptance: [done]
`;

test('phases (no --ready) lists all tasks projected', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithPhases(ONE_TASK);
  const result = await runOrchestratePhases({ ready: false, forgeDir: join(repo, '.forge'), json: true });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.tasks.length, 1);
  assert.equal(env.data.tasks[0].title, 'First task');
  void forgeDir;
});

test('phases --ready returns tasks with no deps, ignoring deferred', async (t) => {
  const stdout = captureStdout(t);
  const { repo } = makeRepoWithPhases(TWO_TASKS_WITH_DEP);
  const result = await runOrchestratePhases({
    ready: true,
    forgeDir: join(repo, '.forge'),
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.overlap_check, 'enabled');
  // Only the one with no deps is "ready" — second depends on the first which is not done.
  assert.equal(env.data.tasks.length, 1);
  assert.equal(env.data.tasks[0].title, 'First');
});

test('phases --ready skips tasks with status=deferred-v0.5', async (t) => {
  const stdout = captureStdout(t);
  const { repo } = makeRepoWithPhases(TWO_TASKS_FIRST_DEFERRED);
  const result = await runOrchestratePhases({
    ready: true,
    forgeDir: join(repo, '.forge'),
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  // Both tasks should be skipped: T01 deferred, T02 depends on T01 (which is not done).
  assert.equal(env.data.tasks.length, 0);
});

test('phases fails clearly when phases.yaml is missing', async (t) => {
  const stdout = captureStdout(t);
  const repo = mkdtempSync(join(tmpdir(), 'forge-phases-missing-'));
  const result = await runOrchestratePhases({
    ready: true,
    forgeDir: join(repo, '.forge'),
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'PHASES_NOT_FOUND');
});

test('phases --ready --limit N caps the output', async (t) => {
  const stdout = captureStdout(t);
  // Build a phases.yaml with three independent tasks.
  const yaml = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        tracker_issue_id: A-1
        title: A
        description: A
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
      - id: P1-T02
        tracker_issue_id: A-2
        title: B
        description: B
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
      - id: P1-T03
        tracker_issue_id: A-3
        title: C
        description: C
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
`;
  const { repo } = makeRepoWithPhases(yaml);
  const result = await runOrchestratePhases({
    ready: true,
    forgeDir: join(repo, '.forge'),
    json: true,
    limit: 2,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.tasks.length, 2);
});

test('phases --ready excludes running tasks until retry backoff elapses', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithPhases(ONE_TASK);
  const taskDir = join(forgeDir, 'orchestrator/tasks/FOO-1');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: 'FOO-1',
      state: 'running',
      state_version: 2,
      attempt_count: 1,
      current_attempt_id: null,
      last_failed_at: new Date(Date.now() + 60_000).toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'run', claim_id: 'claim', generation: 0 },
    }),
    'utf8',
  );
  const result = await runOrchestratePhases({
    ready: true,
    forgeDir: join(repo, '.forge'),
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.tasks.length, 0);
});
