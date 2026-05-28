import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end test: spawn dist/bin/forge.cjs as a subprocess and drive the
// full v2 orchestrate lifecycle against a 3-task fixture. Asserts on the
// JSON envelope returned by each verb invocation, mirroring the spec
// acceptance criterion "3-task fixture run end-to-end via CLI verbs from
// shell script". The actual shell is `node`; spawnSync drives it.
//
// FORGE_NOOP_TRACKER=1 forces NoopTracker on every claim call so the test
// is hermetic (no Linear/GitHub/Notion dependencies).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const distBin = resolve(repoRoot, 'dist', 'bin', 'forge.cjs');
const fixturePath = resolve(repoRoot, 'test', 'fixtures', 'orchestrator', '3-task-phases.yaml');

before(() => {
  if (!existsSync(distBin)) {
    // Build if the artifact is missing. spawnSync inherits stdio so build output
    // surfaces in the test runner.
    const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    if (build.status !== 0) {
      throw new Error(`npm run build failed (status ${build.status})`);
    }
  }
});

function runVerb(args: readonly string[], cwd: string, extraEnv: Record<string, string> = {}): {
  envelope: Record<string, unknown>;
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_NOOP_TRACKER: '1',
    ...extraEnv,
  };
  const res = spawnSync('node', [distBin, ...args, '--json'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '').trim();
  const stderr = String(res.stderr ?? '');
  let envelope: Record<string, unknown> = {};
  if (stdout) {
    const lastNewline = stdout.lastIndexOf('\n');
    const lastLine = lastNewline >= 0 ? stdout.slice(lastNewline + 1) : stdout;
    try {
      envelope = JSON.parse(lastLine);
    } catch {
      envelope = {};
    }
  }
  return { envelope, status: res.status ?? 1, stdout, stderr };
}

test('orchestrate e2e: 3-task fixture end-to-end via CLI verbs', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-e2e-'));
  const forgeDir = join(work, '.forge');
  mkdirSync(join(work, 'plans'), { recursive: true });
  copyFileSync(fixturePath, join(work, 'plans/phases.yaml'));

  // 1. run start
  let res = runVerb(['orchestrate', 'run', 'start', '--name', 'e2e', '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0, `run start failed: ${res.stderr}`);
  assert.equal(res.envelope.ok, true);
  const runData = res.envelope.data as { run_id: string };
  const runId = runData.run_id;
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/i);

  // 2. phases --ready --phase implement → 3 ready tasks
  res = runVerb(
    ['orchestrate', 'phases', '--ready', '--phase', 'implement', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `phases --ready failed: ${res.stderr}`);
  const phasesData = res.envelope.data as { tasks: Array<{ task_id: string }>; overlap_check: string };
  assert.equal(phasesData.overlap_check, 'enabled');
  assert.equal(phasesData.tasks.length, 3);
  const trackerIds = phasesData.tasks.map((t) => t.task_id).sort();
  assert.deepEqual(trackerIds, ['ETOE-1', 'ETOE-2', 'ETOE-3']);

  // ── Task 1 (ETOE-1): full happy path → ready_for_review ────────────────────
  res = runVerb(
    ['orchestrate', 'claim', 'ETOE-1', '--run', runId, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `claim ETOE-1 failed: ${res.stderr}`);
  const claim1 = res.envelope.data as { claim_id: string };

  const wt1 = join(work, 'wt-1');
  mkdirSync(wt1, { recursive: true });
  res = runVerb(
    [
      'orchestrate', 'dispatch', 'ETOE-1',
      '--claim', claim1.claim_id,
      '--run', runId,
      '--worktree', wt1,
      '--phase', 'implement',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `dispatch ETOE-1 failed: ${res.stderr}`);
  const dispatch1 = res.envelope.data as { attempt_id: string };

  res = runVerb(
    ['orchestrate', 'heartbeat', 'ETOE-1', '--attempt', dispatch1.attempt_id, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `heartbeat ETOE-1 failed: ${res.stderr}`);
  const hb1 = res.envelope.data as { first_heartbeat: boolean };
  assert.equal(hb1.first_heartbeat, true);

  // Write a verdict file then complete.
  const verdictFile = join(work, 'verdict.json');
  writeFileSync(
    verdictFile,
    JSON.stringify({
      version: 1,
      verdict: 'ready_for_review',
      summary: 'Done',
      tests: { ran: true, passed: 1, failed: 0, skipped: 0, duration_ms: 100, output_excerpt: 'ok' },
      lint: { ran: true, clean: true, violations: 0, output_excerpt: 'ok' },
      branch: 'feat/etoe-1',
      save_point: 'finished',
    }),
    'utf8',
  );
  res = runVerb(
    [
      'orchestrate', 'complete', 'ETOE-1',
      '--attempt', dispatch1.attempt_id,
      '--verdict-file', verdictFile,
      '--phase', 'implement',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `complete ETOE-1 failed: ${res.stderr}`);
  const c1 = res.envelope.data as { next_state: string };
  assert.equal(c1.next_state, 'ready_for_review');

  // ── Task 2 (ETOE-2): claim, dispatch, heartbeat, question, cancel ──────────
  res = runVerb(
    ['orchestrate', 'claim', 'ETOE-2', '--run', runId, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `claim ETOE-2 failed: ${res.stderr}`);
  const claim2 = res.envelope.data as { claim_id: string };

  const wt2 = join(work, 'wt-2');
  mkdirSync(wt2);
  res = runVerb(
    [
      'orchestrate', 'dispatch', 'ETOE-2',
      '--claim', claim2.claim_id,
      '--run', runId,
      '--worktree', wt2,
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `dispatch ETOE-2 failed: ${res.stderr}`);
  const dispatch2 = res.envelope.data as { attempt_id: string };

  res = runVerb(
    ['orchestrate', 'heartbeat', 'ETOE-2', '--attempt', dispatch2.attempt_id, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0);

  res = runVerb(
    [
      'orchestrate', 'question', 'ETOE-2',
      '--attempt', dispatch2.attempt_id,
      '--decision-key', 'arch:test:question',
      '--question', 'Which path to take?',
      // FORGE-65: the question verb now requires these on every write (AC8).
      '--recommended-option-id', 'yes',
      '--what-happens-if-unanswered', 'Block the task until the supervisor answers.',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `question write failed: ${res.stderr}`);
  const q2 = res.envelope.data as { question_id: string };
  assert.ok(q2.question_id);

  res = runVerb(
    ['orchestrate', 'cancel', 'ETOE-2', '--reason', 'e2e test cancel', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `cancel ETOE-2 failed: ${res.stderr}`);
  const cancel2 = res.envelope.data as { state: string };
  assert.equal(cancel2.state, 'cancelled');

  // ── Task 3 (ETOE-3): claim, dispatch, cancel without heartbeat ─────────────
  res = runVerb(
    ['orchestrate', 'claim', 'ETOE-3', '--run', runId, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0);
  const claim3 = res.envelope.data as { claim_id: string };
  const wt3 = join(work, 'wt-3');
  mkdirSync(wt3);
  res = runVerb(
    [
      'orchestrate', 'dispatch', 'ETOE-3',
      '--claim', claim3.claim_id,
      '--run', runId,
      '--worktree', wt3,
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0);
  res = runVerb(
    ['orchestrate', 'cancel', 'ETOE-3', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0);

  // ── Final assertions ───────────────────────────────────────────────────────
  // ETOE-1: ready_for_review
  const state1 = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks/ETOE-1/state.json'), 'utf8'),
  );
  assert.equal(state1.state, 'ready_for_review');
  // ETOE-2: cancelled
  const state2 = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks/ETOE-2/state.json'), 'utf8'),
  );
  assert.equal(state2.state, 'cancelled');
  // ETOE-3: cancelled
  const state3 = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks/ETOE-3/state.json'), 'utf8'),
  );
  assert.equal(state3.state, 'cancelled');

  // ETOE-2 + ETOE-3 lease files removed; ETOE-1 lease retained until
  // separate ship/gc step (out of scope for this fixture).
  assert.ok(!existsSync(join(forgeDir, 'orchestrator/tasks/ETOE-2/lease.json')));
  assert.ok(!existsSync(join(forgeDir, 'orchestrator/tasks/ETOE-3/lease.json')));

  // run list shows the run.
  res = runVerb(['orchestrate', 'run', 'list', '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0);
  const runs = (res.envelope.data as { runs: Array<{ run_id: string }> }).runs;
  assert.ok(runs.some((r) => r.run_id === runId));
});

test('orchestrate e2e: unknown verb returns UNKNOWN_VERB envelope', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-e2e-unknown-'));
  const res = runVerb(['orchestrate', 'nope', '--forge-dir', join(work, '.forge')], work);
  assert.equal(res.status, 1);
  assert.equal(res.envelope.ok, false);
  assert.equal((res.envelope.error as { code: string }).code, 'UNKNOWN_VERB');
});

test('orchestrate e2e: missing verb after run prints sub-tree usage', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-e2e-run-help-'));
  const res = runVerb(['orchestrate', 'run', '--help', '--forge-dir', join(work, '.forge')], work);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /start\b.*list\b/s);
});
