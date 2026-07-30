import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  runOrchestrateDashboard,
  type DashboardData,
} from '../../../../src/cli/orchestrate/dashboard.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-dashboard-'));
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

function leaseJson(
  forgeDir: string,
  taskId: string,
  ownerRunId: string,
  expiresAt: string,
): void {
  const nowIso = new Date().toISOString();
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'lease.json'), {
    version: 1,
    claim_id: `claim-${taskId}`,
    task_id: taskId,
    attempt_id: null,
    owner_run_id: ownerRunId,
    acquired_at: nowIso,
    expires_at: expiresAt,
    last_heartbeat_at: nowIso,
    generation: 0,
    spec_revision: `git:${'a'.repeat(40)}`,
  });
}

function manifestJson(
  forgeDir: string,
  runId: string,
  startedAt: string,
  name: string | null,
): void {
  writeJson(join(forgeDir, 'orchestrator', 'runs', runId, 'manifest.json'), {
    version: 1,
    run_id: runId,
    started_at: startedAt,
    name,
    host: 'test-host',
  });
}

function questionJson(
  forgeDir: string,
  taskId: string,
  attemptId: string,
  questionId: string,
  decisionKey: string,
): void {
  const created = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  writeJson(
    join(
      forgeDir,
      'orchestrator',
      'tasks',
      taskId,
      'attempts',
      attemptId,
      'questions',
      `${questionId}.json`,
    ),
    {
      version: 1,
      question_id: questionId,
      run_id: 'run-q',
      task_id: taskId,
      agent_id: 'agent-1',
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
        { id: 'b', label: 'Option B', description: 'the other one' },
      ],
      classification: {
        decision_type: 'architectural',
        category: 'scope',
        reversibility: 'medium',
        blast_radius: 'module',
        default_action: 'ask',
        reason: 'needs a human call',
      },
    },
  );
}

// phases.yaml with two tasks; T02 depends on T01.
const TWO_DEP = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
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

// Two independent tasks that both write package.json (a hard-lock glob).
const TWO_HARD_OVERLAP = `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
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
        write_globs: [package.json]
      - id: P1-T02
        tracker_issue_id: FOO-2
        title: Second
        description: Second task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        write_globs: [package.json]
`;

function runJson(forgeDir: string, now?: Date): DashboardData {
  const cap = capture();
  const res = runOrchestrateDashboard({
    forgeDir,
    json: true,
    stdout: cap.stream,
    ...(now ? { now } : {}),
  });
  assert.equal(res.exitCode, 0);
  const env = JSON.parse(cap.text().trim());
  assert.equal(env.ok, true);
  return env.data as DashboardData;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('dashboard: empty tree → ok with empty arrays + source unavailable', () => {
  const forgeDir = join(repoRoot(), '.forge');
  const data = runJson(forgeDir);
  assert.deepEqual(data.active_sessions, []);
  assert.deepEqual(data.open_questions, []);
  assert.deepEqual(data.ready_tasks, []);
  assert.deepEqual(data.blocked_tasks, []);
  assert.deepEqual(data.overlap_warnings, []);
  assert.deepEqual(data.lease_health, []);
  assert.equal(data.source.ready_blocked, 'unavailable');
  assert.ok(data.warnings.some((w) => /phases\.yaml not found/.test(w)));
});

test('dashboard: ready/blocked derived from phases.yaml dep graph', () => {
  const repo = repoRoot();
  writePhases(repo, TWO_DEP);
  const data = runJson(join(repo, '.forge'));
  assert.equal(data.source.ready_blocked, 'local-cache');
  assert.deepEqual(data.ready_tasks, ['FOO-1']);
  assert.equal(data.blocked_tasks.length, 1);
  assert.deepEqual(data.blocked_tasks[0], { task_id: 'FOO-2', blocked_by: ['P1-T01'] });
});

test('dashboard: claimed task is excluded from ready + attributed to its session', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, TWO_DEP);
  manifestJson(forgeDir, 'run-1', '2026-01-01T00:00:00.000Z', 'alpha');
  taskStateJson(forgeDir, 'FOO-1', 'running');
  leaseJson(forgeDir, 'FOO-1', 'run-1', new Date(Date.now() + 3_600_000).toISOString());

  const data = runJson(forgeDir);
  // FOO-1 is claimed → not ready; FOO-2 still blocked on P1-T01.
  assert.deepEqual(data.ready_tasks, []);
  assert.deepEqual(data.blocked_tasks, [{ task_id: 'FOO-2', blocked_by: ['P1-T01'] }]);
  assert.equal(data.active_sessions.length, 1);
  assert.deepEqual(data.active_sessions[0], {
    run_id: 'run-1',
    started_at: '2026-01-01T00:00:00.000Z',
    claimed_tasks: ['FOO-1'],
  });
  assert.deepEqual(data.lease_health, [{ task_id: 'FOO-1', status: 'alive' }]);
});

test('dashboard: a run manifest with no live claims is NOT reported as active', () => {
  const forgeDir = join(repoRoot(), '.forge');
  // A run exists on disk but holds no in-flight task.
  manifestJson(forgeDir, 'run-old', '2025-01-01T00:00:00.000Z', 'quiesced');
  const data = runJson(forgeDir);
  assert.deepEqual(data.active_sessions, []);
});

test('dashboard: lease health buckets (alive / expiring_soon / stale)', () => {
  const forgeDir = join(repoRoot(), '.forge');
  const now = new Date('2026-06-01T12:00:00.000Z');
  const t = now.getTime();
  taskStateJson(forgeDir, 'A-1', 'running');
  leaseJson(forgeDir, 'A-1', 'run-x', new Date(t + 60_000).toISOString()); // future → alive
  taskStateJson(forgeDir, 'A-2', 'running');
  leaseJson(forgeDir, 'A-2', 'run-x', new Date(t - 1_000).toISOString()); // expired <grace → expiring_soon
  taskStateJson(forgeDir, 'A-3', 'running');
  leaseJson(forgeDir, 'A-3', 'run-x', new Date(t - 10 * 60_000).toISOString()); // expired+grace → stale

  const data = runJson(forgeDir, now);
  const byId = Object.fromEntries(data.lease_health.map((l) => [l.task_id, l.status]));
  assert.equal(byId['A-1'], 'alive');
  assert.equal(byId['A-2'], 'expiring_soon');
  assert.equal(byId['A-3'], 'stale');
});

test('dashboard: hard overlap between two in-flight tasks on a hard-lock glob', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, TWO_HARD_OVERLAP);
  taskStateJson(forgeDir, 'FOO-1', 'running');
  taskStateJson(forgeDir, 'FOO-2', 'running');

  const data = runJson(forgeDir);
  assert.equal(data.overlap_warnings.length, 1);
  const w = data.overlap_warnings[0]!;
  assert.equal(w.severity, 'hard');
  assert.deepEqual([w.task_a, w.task_b].sort(), ['FOO-1', 'FOO-2']);
  assert.ok(w.globs.includes('package.json'));
});

test('dashboard: open questions are surfaced from the task tree', () => {
  const forgeDir = join(repoRoot(), '.forge');
  questionJson(forgeDir, 'FOO-1', 'att-1', 'q-1', 'pick-approach');
  const data = runJson(forgeDir);
  assert.equal(data.open_questions.length, 1);
  assert.deepEqual(
    {
      question_id: data.open_questions[0]!.question_id,
      task_id: data.open_questions[0]!.task_id,
      decision_key: data.open_questions[0]!.decision_key,
      optionCount: data.open_questions[0]!.options.length,
    },
    { question_id: 'q-1', task_id: 'FOO-1', decision_key: 'pick-approach', optionCount: 2 },
  );
});

test('dashboard: corrupt state.json is skipped, not fatal', () => {
  const forgeDir = join(repoRoot(), '.forge');
  // Valid task with a lease.
  taskStateJson(forgeDir, 'A-1', 'running');
  leaseJson(forgeDir, 'A-1', 'run-x', new Date(Date.now() + 60_000).toISOString());
  // Corrupt task — invalid JSON state.
  const corruptDir = join(forgeDir, 'orchestrator', 'tasks', 'A-2');
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, 'state.json'), '{ not json', 'utf8');

  const data = runJson(forgeDir);
  assert.deepEqual(data.lease_health, [{ task_id: 'A-1', status: 'alive' }]);
});

test('dashboard: pretty (non-json) output writes to the injected stream', () => {
  const repo = repoRoot();
  writePhases(repo, TWO_DEP);
  const cap = capture();
  const res = runOrchestrateDashboard({
    forgeDir: join(repo, '.forge'),
    json: false,
    stdout: cap.stream,
  });
  assert.equal(res.exitCode, 0);
  const text = cap.text();
  assert.match(text, /Active workers/);
  assert.match(text, /Ready vs blocked/);
  assert.match(text, /from local cache/);
});

// ── FORGE-235: the awaiting-merge section ────────────────────────────────────

const M_SHA = 'a'.repeat(40);
const M_COMMIT = 'c'.repeat(40);
const M_PR = { repo: 'octo/base', number: 21, url: 'https://github.com/octo/base/pull/21' };

function shipRecordJson(forgeDir: string, taskId: string): void {
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'ship-record.json'), {
    version: 1, task_id: taskId, revision: 2, reviewed_head_sha: M_SHA, review_attempt_id: 'att-rev',
    cycle: 1, base: { repo: 'octo/base', branch: 'main', push_remote: 'origin' }, pr: M_PR,
    merge_attempt: 'submitted', updated_at: new Date().toISOString(),
  });
}

function journalJson(forgeDir: string, taskId: string, over: Record<string, unknown> = {}): void {
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'reconciliation.json'), {
    version: 1, task_id: taskId, revision: 1,
    subject: { cycle: 1, pr: M_PR, reviewed_head_sha: M_SHA, ship_record_revision: 2 },
    last_probed_at: new Date().toISOString(), last_probe_outcome: 'open, awaiting human merge',
    probe_failure_streak: 0, pending_since: null, merge_failure_streak: 0, last_merge_failure_at: null,
    merge_reservation: null, tracker_sync: { status: 'pending', attempts: 0, last_error: null },
    updated_at: new Date().toISOString(), ...over,
  });
}

test('dashboard surfaces merge_pending tasks with their PR and last probe outcome', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  taskStateJson(forgeDir, 'FORGE-MP1', 'merge_pending');
  shipRecordJson(forgeDir, 'FORGE-MP1');
  journalJson(forgeDir, 'FORGE-MP1');
  const out = capture();

  const res = runOrchestrateDashboard({ forgeDir, json: true, stdout: out.stream });
  assert.equal(res.exitCode, 0);
  const data = JSON.parse(out.text()).data as DashboardData;

  assert.equal(data.merge_pending.length, 1);
  const entry = data.merge_pending[0]!;
  assert.equal(entry.task_id, 'FORGE-MP1');
  assert.equal(entry.pr_url, M_PR.url);
  assert.equal(entry.reviewed_head_sha, M_SHA);
  assert.equal(entry.attested, false);
  assert.equal(entry.tracker_sync, 'pending');
  assert.match(entry.last_probe_outcome ?? '', /awaiting human merge/);
});

test('a proven-but-unpromoted task is marked attested', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  taskStateJson(forgeDir, 'FORGE-MP2', 'merge_pending');
  shipRecordJson(forgeDir, 'FORGE-MP2');
  writeJson(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-MP2', 'merge-attestation.json'), {
    version: 1, task_id: 'FORGE-MP2', cycle: 1, pr: M_PR, base_repo: 'octo/base', base_branch: 'main',
    reviewed_head_sha: M_SHA, merged_head_sha: M_SHA, merge_commit_sha: M_COMMIT,
    ship_record_revision: 2, attested_at: new Date().toISOString(),
  });
  const out = capture();

  runOrchestrateDashboard({ forgeDir, json: true, stdout: out.stream });
  const data = JSON.parse(out.text()).data as DashboardData;
  assert.equal(data.merge_pending[0]!.attested, true);
});

test('a corrupt attestation becomes a dashboard warning, never a silent pass', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  taskStateJson(forgeDir, 'FORGE-MP3', 'merge_pending');
  shipRecordJson(forgeDir, 'FORGE-MP3');
  mkdirSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-MP3'), { recursive: true });
  writeFileSync(join(forgeDir, 'orchestrator', 'tasks', 'FORGE-MP3', 'merge-attestation.json'), 'garbage', 'utf8');
  const out = capture();

  runOrchestrateDashboard({ forgeDir, json: true, stdout: out.stream });
  const data = JSON.parse(out.text()).data as DashboardData;
  assert.equal(data.merge_pending[0]!.attested, false);
  assert.ok(data.warnings.some((w) => w.includes('attestation invalid for FORGE-MP3')));
});

test('the text view names the merge-tick verb and flags an unsynced tracker', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  // Tracker sync only runs AFTER the promotion CAS, so a sync failure always
  // belongs to a `shipped` task — the section must cover that shape or the
  // warning is unreachable in practice.
  taskStateJson(forgeDir, 'FORGE-MP4', 'shipped');
  shipRecordJson(forgeDir, 'FORGE-MP4');
  journalJson(forgeDir, 'FORGE-MP4', {
    tracker_sync: { status: 'failed', attempts: 5, last_error: 'tracker down' },
    probe_failure_streak: 3,
  });
  const out = capture();

  runOrchestrateDashboard({ forgeDir, json: false, stdout: out.stream });
  const text = out.text();
  assert.match(text, /Awaiting merge/);
  assert.match(text, /FORGE-MP4/);
  assert.match(text, /merge-tick/);
  assert.match(text, /merged — tracker sync unfinished/);
  assert.match(text, /close the issue manually/);
});

test('a fully reconciled shipped task is NOT in the awaiting-merge queue', () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  taskStateJson(forgeDir, 'FORGE-MP7', 'shipped');
  shipRecordJson(forgeDir, 'FORGE-MP7');
  journalJson(forgeDir, 'FORGE-MP7', { tracker_sync: { status: 'done', attempts: 1, last_error: null } });
  const out = capture();

  runOrchestrateDashboard({ forgeDir, json: true, stdout: out.stream });
  const data = JSON.parse(out.text()).data as DashboardData;
  assert.deepEqual(data.merge_pending, []);
});

test('in-flight states never appear, and a shipped task with NO sync evidence still does', () => {
  // Only a positive tracker_sync 'done' retires a shipped task: a crash between
  // the promotion CAS and the first sync write leaves no journal at all, and
  // treating that as "finished" would hide real unfinished bookkeeping.
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  taskStateJson(forgeDir, 'FORGE-MP5', 'running');
  taskStateJson(forgeDir, 'FORGE-MP6', 'shipped');
  shipRecordJson(forgeDir, 'FORGE-MP6');
  const out = capture();

  runOrchestrateDashboard({ forgeDir, json: true, stdout: out.stream });
  const data = JSON.parse(out.text()).data as DashboardData;
  assert.deepEqual(
    data.merge_pending.map((m) => m.task_id),
    ['FORGE-MP6'],
  );
  assert.equal(data.merge_pending[0]!.state, 'shipped');
});
