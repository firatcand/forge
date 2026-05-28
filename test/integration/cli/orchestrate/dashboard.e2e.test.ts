import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  runOrchestrateDashboard,
  type DashboardData,
} from '../../../../src/cli/orchestrate/dashboard.ts';

function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-dashboard-e2e-'));
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

function seedRun(forgeDir: string, runId: string, startedAt: string): void {
  writeJson(join(forgeDir, 'orchestrator', 'runs', runId, 'manifest.json'), {
    version: 1,
    run_id: runId,
    started_at: startedAt,
    name: runId,
    host: 'test-host',
  });
}

function seedActiveTask(forgeDir: string, taskId: string, ownerRunId: string): void {
  const nowIso = new Date().toISOString();
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'state.json'), {
    version: 1,
    task_id: taskId,
    state: 'running',
    state_version: 0,
    attempt_count: 1,
    current_attempt_id: null,
    updated_at: nowIso,
    updated_by: { run_id: ownerRunId, claim_id: `claim-${taskId}`, generation: 0 },
  });
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json'), {
    version: 1,
    claim_id: `claim-${taskId}`,
    task_id: taskId,
    attempt_id: null,
    owner_run_id: ownerRunId,
    acquired_at: nowIso,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    last_heartbeat_at: nowIso,
    generation: 0,
    spec_revision: `git:${'a'.repeat(40)}`,
  });
}

function runJson(forgeDir: string): DashboardData {
  const cap = capture();
  const res = runOrchestrateDashboard({ forgeDir, json: true, stdout: cap.stream });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(cap.text().trim());
  assert.equal(env.ok, true);
  return env.data as DashboardData;
}

test('dashboard: three simultaneous runs are all visible with correct task attribution', () => {
  const forgeDir = join(repoRoot(), '.forge');
  seedRun(forgeDir, 'run-1', '2026-01-01T00:00:01.000Z');
  seedRun(forgeDir, 'run-2', '2026-01-01T00:00:02.000Z');
  seedRun(forgeDir, 'run-3', '2026-01-01T00:00:03.000Z');
  seedActiveTask(forgeDir, 'T-a', 'run-1');
  seedActiveTask(forgeDir, 'T-b', 'run-2');
  seedActiveTask(forgeDir, 'T-c', 'run-3');

  const data = runJson(forgeDir);
  assert.equal(data.active_sessions.length, 3);
  const byRun = Object.fromEntries(
    data.active_sessions.map((s) => [s.run_id, s.claimed_tasks]),
  );
  assert.deepEqual(byRun['run-1'], ['T-a']);
  assert.deepEqual(byRun['run-2'], ['T-b']);
  assert.deepEqual(byRun['run-3'], ['T-c']);
  // Most-recent run first (descending started_at).
  assert.equal(data.active_sessions[0]!.run_id, 'run-3');
  // Every lease is alive.
  assert.equal(data.lease_health.length, 3);
  assert.ok(data.lease_health.every((l) => l.status === 'alive'));
});

test('dashboard: aggregates a 50-task fixture (with attempts + questions) under a generous time bound', () => {
  const forgeDir = join(repoRoot(), '.forge');
  seedRun(forgeDir, 'run-1', '2026-01-01T00:00:01.000Z');
  for (let i = 0; i < 50; i += 1) {
    const taskId = `BIG-${i}`;
    seedActiveTask(forgeDir, taskId, 'run-1');
    // Two attempts, each with one open question, to exercise the question walk.
    for (const att of ['att-1', 'att-2']) {
      const created = new Date(Date.now() - 60_000).toISOString();
      const expires = new Date(Date.now() + 3_600_000).toISOString();
      writeJson(
        join(forgeDir, 'orchestrator', 'tasks', taskId, 'attempts', att, 'questions', `q-${att}.json`),
        {
          version: 1,
          question_id: `q-${att}`,
          run_id: 'run-1',
          task_id: taskId,
          agent_id: 'agent-1',
          decision_key: `key-${att}`,
          attempt: 1,
          max_attempts: 3,
          created_at: created,
          expires_at: expires,
          status: 'open',
          question: 'Which approach?',
          context: '',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          classification: {
            decision_type: 'architectural',
            category: 'scope',
            reversibility: 'medium',
            blast_radius: 'module',
            default_action: 'ask',
            reason: 'r',
          },
        },
      );
    }
  }

  const started = Date.now();
  const data = runJson(forgeDir);
  const elapsed = Date.now() - started;

  assert.equal(data.active_sessions.length, 1);
  assert.deepEqual(data.active_sessions[0]!.claimed_tasks.length, 50);
  assert.equal(data.lease_health.length, 50);
  // 50 tasks × 2 attempts × 1 question each = 100 open questions.
  assert.equal(data.open_questions.length, 100);
  // Generous bound — the AC target is <500ms p95; this asserts no pathological blowup.
  assert.ok(elapsed < 2000, `dashboard aggregation took ${elapsed}ms (expected < 2000ms)`);
});
