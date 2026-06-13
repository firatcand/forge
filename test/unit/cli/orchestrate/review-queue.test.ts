import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runOrchestrateReviewQueue } from '../../../../src/cli/orchestrate/review-queue.ts';

function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-review-queue-'));
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

function writePhases(repo: string, yaml: string): void {
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(join(repo, 'plans/phases.yaml'), yaml, 'utf8');
}

function taskStateJson(
  forgeDir: string,
  taskId: string,
  state: string,
  attemptId: string | null = null,
): void {
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'state.json'), {
    version: 1,
    task_id: taskId,
    state,
    state_version: 0,
    attempt_count: 1,
    current_attempt_id: attemptId,
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'run-seed', claim_id: 'claim-seed', generation: 0 },
  });
}

function leaseJson(forgeDir: string, taskId: string): void {
  const nowIso = new Date().toISOString();
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json'), {
    version: 1,
    claim_id: `claim-${taskId}`,
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-1',
    acquired_at: nowIso,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    last_heartbeat_at: nowIso,
    generation: 0,
    spec_revision: `git:${'a'.repeat(40)}`,
  });
}

const PHASES = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        title: First task
        description: First task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        write_globs: ["src/a/**"]
      - id: P1-T02
        title: Second task
        description: Second task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        write_globs: ["src/b/**"]
`;

test('review-queue lists only ready_for_review tasks with title/globs/attempt/lease', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, PHASES);
  taskStateJson(forgeDir, 'P1-T01', 'ready_for_review', 'att-1');
  leaseJson(forgeDir, 'P1-T01');
  taskStateJson(forgeDir, 'P1-T02', 'running', 'att-2'); // not ready_for_review

  const out = capture();
  const res = runOrchestrateReviewQueue({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data.tasks.length, 1);
  const t = env.data.tasks[0];
  assert.equal(t.task_id, 'P1-T01');
  assert.equal(t.title, 'First task');
  assert.deepEqual(t.write_globs, ['src/a/**']);
  assert.equal(t.current_attempt_id, 'att-1');
  assert.equal(t.lease_present, true);
});

test('review-queue: lease_present false when no lease file', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, PHASES);
  taskStateJson(forgeDir, 'P1-T01', 'ready_for_review', 'att-1');

  const out = capture();
  runOrchestrateReviewQueue({ forgeDir, json: true, stdout: out.stream });
  const env = JSON.parse(out.text());
  assert.equal(env.data.tasks[0].lease_present, false);
});

test('review-queue: corrupt state.json is skipped', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, PHASES);
  taskStateJson(forgeDir, 'P1-T01', 'ready_for_review', 'att-1');
  writeJson(join(forgeDir, 'orchestrator', 'tasks', 'P1-T02', 'state.json'), {}); // schema-invalid
  // raw corrupt file
  mkdirSync(join(forgeDir, 'orchestrator', 'tasks', 'P1-T03'), { recursive: true });
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'P1-T03', 'state.json'), 'nope', 'utf8');

  const out = capture();
  runOrchestrateReviewQueue({ forgeDir, json: true, stdout: out.stream });
  const env = JSON.parse(out.text());
  assert.deepEqual(env.data.tasks.map((t: { task_id: string }) => t.task_id), ['P1-T01']);
});

test('review-queue: empty → { tasks: [] }', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, PHASES);
  const out = capture();
  const res = runOrchestrateReviewQueue({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.deepEqual(env.data.tasks, []);
});

test('review-queue: missing phases.yaml degrades to empty queue', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  // No phases.yaml. Seed a ready_for_review task; with no phases join, title is ''.
  taskStateJson(forgeDir, 'P1-T01', 'ready_for_review', 'att-1');
  const out = capture();
  const res = runOrchestrateReviewQueue({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(out.text());
  assert.equal(env.ok, true);
  assert.equal(env.data.tasks.length, 1);
  assert.equal(env.data.tasks[0].title, '');
});
