// FORGE-234: ship verb outcome routing — park lifecycle (question + state),
// phase-aware answer resolution, drift regression, single-envelope contract.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Writable } from 'node:stream';
import { runOrchestrateShip } from '../../../../src/cli/orchestrate/ship.ts';
import { runOrchestrateAnswer } from '../../../../src/cli/orchestrate/answer.ts';
import { FakeRepoHost } from '../../../../src/repo-hosts/fake.ts';
import type { ShipOpDeps } from '../../../../src/orchestrator/ship-op.ts';
import type { Exec } from '../../../../src/repo-hosts/github.ts';

const SHA = 'a'.repeat(40);
const TASK = 'FORGE-S2';
const ATTEMPT = '01890000-0000-7000-8000-000000000002';
const REPO = 'octo/base';
const PR = { repo: REPO, number: 9, url: `https://github.com/${REPO}/pull/9` };

function captureStdout(t: TestContext): string[] {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const s = String(chunk);
    if (s.trimStart().startsWith('{')) lines.push(s.trim());
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return lines;
}

function fixture(): { forgeDir: string; worktree: string; repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-234v-'));
  const forgeDir = join(repoRoot, '.forge');
  const worktree = mkdtempSync(join(tmpdir(), 'forge-234v-wt-'));
  const taskDir = join(forgeDir, 'orchestrator', 'tasks', TASK);
  mkdirSync(join(taskDir, 'attempts', ATTEMPT), { recursive: true });
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'plans', 'phases.yaml'),
    [
      'project: "fx"', 'phases:', '  - id: phase-1', '    name: "P"', '    status: active',
      '    goal: "G."', '    gate_criteria: ["g"]', '    tasks:',
      '      - id: P1-T01', '        title: "S"', '        description: "s"', '        type: foundation',
      '        priority: P0', '        estimate: S', '        owner_type: backend-dev',
      `        tracker_issue_id: ${TASK}`, '        acceptance: ["ok"]', '',
    ].join('\n'),
  );
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    ['version: 1', 'project:', '  name: fx', 'tracker:', '  type: github', '  config:', '    repo: octo/base', 'secrets:', '  manager: env_file', ''].join('\n'),
  );
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      version: 1, task_id: TASK, state: 'reviewed', state_version: 4, attempt_count: 1,
      failure_count: 0, last_failure_key: null, review_attempt_count: 1, ship_attempt_count: 1,
      current_attempt_id: ATTEMPT, updated_at: new Date().toISOString(),
      updated_by: { run_id: 'run-001', claim_id: 'claim-001', generation: 0 },
    }),
  );
  writeFileSync(
    join(taskDir, 'lease.json'),
    JSON.stringify({
      version: 1, claim_id: 'claim-001', task_id: TASK, attempt_id: null, owner_run_id: 'run-001',
      acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      last_heartbeat_at: new Date().toISOString(), generation: 0, spec_revision: 'digest:empty',
    }),
  );
  writeFileSync(
    join(taskDir, 'attempts', ATTEMPT, 'manifest.json'),
    JSON.stringify({
      version: 1, attempt_id: ATTEMPT, task_id: TASK, run_id: 'run-001', claim_id: 'claim-001',
      generation: 0, phase: 'ship', worktree_path: worktree, dispatched_at: new Date().toISOString(),
      ship_target_sha: SHA,
    }),
  );
  writeFileSync(
    join(taskDir, 'ship-record.json'),
    JSON.stringify({
      version: 1, task_id: TASK, revision: 2, reviewed_head_sha: SHA, review_attempt_id: 'att-rev',
      base: { repo: REPO, branch: 'main', push_remote: 'origin' }, pr: null,
      merge_attempt: 'not_started', updated_at: new Date().toISOString(),
    }),
  );
  mkdirSync(join(worktree, '.forge'), { recursive: true });
  writeFileSync(
    join(worktree, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId: TASK, branch: `feat/${TASK}`, base_branch: 'main' }),
  );
  return { forgeDir, worktree, repoRoot };
}

const gitOk: Exec = async (args) => {
  const a = [...args];
  if (a.includes('--abbrev-ref')) return { stdout: `feat/${TASK}\n`, stderr: '', exitCode: 0 };
  if (a.includes('rev-parse')) return { stdout: `${SHA}\n`, stderr: '', exitCode: 0 };
  if (a.includes('merge-base')) return { stdout: `${'9'.repeat(40)}\n`, stderr: '', exitCode: 0 };
  if (a.includes('push')) return { stdout: '', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: 'unscripted', exitCode: 1 };
};

function parkingDeps(): { shipOpDeps: Partial<ShipOpDeps> } {
  // No RepoHost → unsupported_host park.
  return { shipOpDeps: { repoHost: null, git: gitOk, gitleaks: async () => ({ clean: true, detail: '' }), sleepMs: async () => {} } };
}

const sink = new Writable({ write(_c, _e, cb) { cb(); } });

test('park lifecycle: question written with origin, state → blocked_on_question; same-incident replay dedupes; retry_ship answer → reviewed', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();

  const r1 = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    parkingDeps(),
  );
  assert.equal(r1.exitCode, 1);
  const env1 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env1.error.code, 'SHIP_PARKED');
  assert.equal(env1.error.details.park_reason, 'unsupported_host');
  const questionId = env1.error.details.question_id;
  assert.ok(questionId);
  const state1 = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state1.state, 'blocked_on_question');
  const qRaw = JSON.parse(
    readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'attempts', ATTEMPT, 'questions', `${questionId}.json`), 'utf8'),
  );
  assert.equal(qRaw.origin.phase, 'ship');
  assert.equal(qRaw.origin.park_reason, 'unsupported_host');
  stdout.length = 0;

  // Same unresolved incident → replayed, NO duplicate question, state untouched.
  const r2 = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    parkingDeps(),
  );
  assert.equal(r2.exitCode, 1);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.error.details.replayed, true);
  assert.equal(env2.error.details.question_id, questionId);
  stdout.length = 0;

  // Operator answers retry_ship → the ANSWER VERB owns the transition back to reviewed.
  const ans = runOrchestrateAnswer({
    questionId,
    optionId: 'retry_ship',
    forgeDir: fx.forgeDir,
    stdout: sink,
    stderr: sink,
  });
  assert.equal(ans.exitCode, 0);
  const state2 = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state2.state, 'reviewed', 'retry_ship resolves to reviewed for re-ship');
  assert.equal(state2.failure_count, 0, 'parks consume no budget');
});

test('cancel_task answer cancels WHILE blocked (never violates the operator answer)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const questionId = env.error.details.question_id;

  const ans = runOrchestrateAnswer({ questionId, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(ans.exitCode, 0);
  const state = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state.state, 'cancelled');
});

test('stale answer after supersession refuses; replay of the same answer repairs a missing transition', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const questionId = env.error.details.question_id;

  // Supersede the parked attempt: the pointer moves on.
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...s, current_attempt_id: 'att-successor', state_version: s.state_version + 1 }));
  const stale = runOrchestrateAnswer({ questionId, optionId: 'retry_ship', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(stale.exitCode, 1, 'stale answer must not move the task');

  // Restore the parked pointer; the answer FILE already exists → replay path
  // must repair the missing transition instead of dead-ending.
  writeFileSync(statePath, JSON.stringify({ ...s, state_version: s.state_version + 2 }));
  const repair = runOrchestrateAnswer({ questionId, optionId: 'retry_ship', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(repair.exitCode, 0);
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.state, 'reviewed');
});

test('drift outcome regresses reviewed → ready_for_review with ZERO budget consumption', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  const driftGit: Exec = async (args) => {
    const a = [...args];
    if (a.includes('--abbrev-ref')) return { stdout: `feat/${TASK}\n`, stderr: '', exitCode: 0 };
    if (a.includes('rev-parse')) return { stdout: `${'c'.repeat(40)}\n`, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const host = new FakeRepoHost({ base: { repo: REPO, branch: 'main', push_remote: 'origin' } });
  const r = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    { shipOpDeps: { repoHost: host, git: driftGit, gitleaks: async () => ({ clean: true, detail: '' }), sleepMs: async () => {}, runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) } },
  );
  assert.equal(r.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'VERIFICATION_FAILED');
  assert.match(env.error.message, /no fault/);
  const state = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state.state, 'ready_for_review');
  assert.equal(state.failure_count, 0, 'drift never consumes budget');
});

test('success path routes through complete: merge_pending + released lease + receipt (single envelope)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  const host = new FakeRepoHost({
    base: { repo: REPO, branch: 'main', push_remote: 'origin' },
    pullRequest: PR,
    headSha: { ok: true, sha: SHA },
    mergeResult: { merged: false, state: 'open' },
  });
  const r = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    {
      shipOpDeps: {
        repoHost: host,
        git: gitOk,
        gitleaks: async () => ({ clean: true, detail: '' }),
        sleepMs: async () => {},
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        tracker: { updateState: async () => ({ ok: true as const }) },
      },
    },
  );
  assert.equal(r.exitCode, 0);
  const envelopes = stdout.filter((l) => {
    try {
      return 'ok' in JSON.parse(l);
    } catch {
      return false;
    }
  });
  assert.equal(envelopes.length, 1, 'exactly ONE envelope (complete owns it)');
  const env = JSON.parse(envelopes[0]!);
  assert.equal(env.ok, true);
  assert.equal(env.data.next_state, 'merge_pending');
  const state = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state.state, 'merge_pending');
  const lease = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'lease.json'), 'utf8'));
  assert.equal(lease.status, 'released', 'lease released at merge_pending');
});

// ─── impl-R1 fix-round additions ─────────────────────────────────────────────

test('ship failure routes through complete and consumes budget (task stays reviewed, failure_count+1)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  const host = new FakeRepoHost({ base: { repo: REPO, branch: 'main', push_remote: 'origin' } });
  const r = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    {
      shipOpDeps: {
        repoHost: host,
        git: gitOk,
        gitleaks: async () => ({ clean: false, detail: 'aws key found' }),
        sleepMs: async () => {},
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        tracker: { updateState: async () => ({ ok: true as const }) },
      },
    },
  );
  assert.equal(r.exitCode, 0, 'failure completion is a SUCCESSFUL complete invocation (budget accounted)');
  const state = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json'), 'utf8'));
  assert.equal(state.state, 'reviewed', 'budgeted ship failure returns to reviewed');
  assert.equal(state.failure_count, 1, 'one budget unit consumed');
});

test('orphan park (question written, transition crashed) is REPAIRED on replay (impl-R1 MAJ #3)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const questionId = env.error.details.question_id;
  // Simulate the crash: revert the park transition, keeping the open question.
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...s, state: 'reviewed', state_version: s.state_version + 1 }));
  stdout.length = 0;

  const r2 = await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  assert.equal(r2.exitCode, 1);
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env2.error.details.repaired, true);
  assert.equal(env2.error.details.question_id, questionId);
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.state, 'blocked_on_question', 'the mandatory park is blocking again');
});

test('cancel_task releases the lease (full transaction, impl-R1 MAJ #4)', async (t) => {
  const stdout = captureStdout(t);
  void stdout;
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const ans = runOrchestrateAnswer({ questionId: env.error.details.question_id, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(ans.exitCode, 0);
  const lease = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'lease.json'), 'utf8'));
  assert.equal(lease.status, 'released', 'cancel answer releases the lease');
});

test('completion observer WITHOUT headSha refuses (impl-R1 MAJ #2)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  const host = new FakeRepoHost({
    base: { repo: REPO, branch: 'main', push_remote: 'origin' },
    pullRequest: PR,
    headSha: { ok: true, sha: SHA },
  });
  const r = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    {
      shipOpDeps: {
        repoHost: host, git: gitOk, gitleaks: async () => ({ clean: true, detail: '' }),
        sleepMs: async () => {}, runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
        tracker: { updateState: async () => ({ ok: true as const }) },
      },
      // Force complete to use a mergeResult-only observer (no headSha).
      runComplete: (args) =>
        import('../../../../src/cli/orchestrate/complete.ts').then((m) =>
          m.runOrchestrateComplete(args, {
            observerFor: async () => ({ mergeResult: async () => ({ merged: false as const, state: 'open' as const }) }),
          }),
        ),
    },
  );
  assert.equal(r.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'VERIFICATION_FAILED');
  assert.match(env.error.message, /headSha capability/);
});

test("attempt B never repairs itself onto A's orphaned park (impl-R2 MAJ #2)", async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  // A parks, then crashes pre-transition; B is dispatched (pointer moves).
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  const B = '01890000-0000-7000-8000-00000000000b';
  writeFileSync(statePath, JSON.stringify({ ...s, state: 'reviewed', current_attempt_id: B, state_version: s.state_version + 1 }));
  // B's manifest so admission-side reads resolve.
  const bDir = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'attempts', B);
  mkdirSync(bDir, { recursive: true });
  writeFileSync(join(bDir, 'manifest.json'), JSON.stringify({
    version: 1, attempt_id: B, task_id: TASK, run_id: 'run-001', claim_id: 'claim-001',
    generation: 0, phase: 'ship', worktree_path: fx.worktree, dispatched_at: new Date().toISOString(),
    ship_target_sha: SHA,
  }));
  stdout.length = 0;

  const r = await runOrchestrateShip({ taskId: TASK, attemptId: B, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env2 = JSON.parse(stdout[stdout.length - 1] ?? '');
  // B must NOT adopt A's question: it parks FRESH (new question) — never repaired:true on A's id.
  assert.notEqual(env2.error.details?.question_id, env.error.details.question_id, "B must not block itself on A's question");

  // And answering A's stale question refuses BEFORE persisting.
  const ans = runOrchestrateAnswer({ questionId: env.error.details.question_id, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(ans.exitCode, 1, "A's stale park answer is refused (pre-write)");
});

test('stale failure never mints a carrier; complete refuses a version-moved failure (impl-R3 MAJ #1)', async (t) => {
  const stdout = captureStdout(t);
  void stdout;
  const fx = fixture();
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const original = JSON.parse(readFileSync(statePath, 'utf8'));
  const host = new FakeRepoHost({ base: { repo: REPO, branch: 'main', push_remote: 'origin' } });
  const r = await runOrchestrateShip(
    { taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true },
    {
      shipOpDeps: {
        repoHost: host, git: gitOk, sleepMs: async () => {},
        runCommand: async () => {
          writeFileSync(statePath, JSON.stringify({ ...original, state_version: original.state_version + 2 }));
          return { exitCode: 1, stdout: '', stderr: 'fail', timedOut: false };
        },
        gitleaks: async () => ({ clean: true, detail: '' }),
        tracker: { updateState: async () => ({ ok: true as const }) },
      },
    },
  );
  assert.equal(r.exitCode, 1);
  // NO carrier minted for the stale invocation.
  const { existsSync } = await import('node:fs');
  assert.equal(
    existsSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'attempts', ATTEMPT, 'ship_op_verdict.input.json')),
    false,
    'stale failure leaves no consumable carrier',
  );
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.failure_count, 0, 'no budget consumed by the stale invocation');
});

test('cancel answer on a same-attempt ORPHAN park cancels via the full transaction (impl-R3 MAJ #2)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const questionId = env.error.details.question_id;
  // Crash BETWEEN question publication and the park transition: state reviewed, same attempt.
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...s, state: 'reviewed', state_version: s.state_version + 1 }));

  const ans = runOrchestrateAnswer({ questionId, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(ans.exitCode, 0, 'the operator cancellation is honored, not consumed-and-lost');
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.state, 'cancelled');
  const lease = JSON.parse(readFileSync(join(fx.forgeDir, 'orchestrator/tasks', TASK, 'lease.json'), 'utf8'));
  assert.equal(lease.status, 'released');
});

test('a LOST cancellation race consumes NOTHING: no answer file, question stays answerable (impl-R4 MAJ)', async (t) => {
  const stdout = captureStdout(t);
  const fx = fixture();
  await runOrchestrateShip({ taskId: TASK, attemptId: ATTEMPT, forgeDir: fx.forgeDir, json: true }, parkingDeps());
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  const questionId = env.error.details.question_id;

  // Crash between question publication and the park transition…
  const statePath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'state.json');
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  // …and a concurrent SHIP dispatch WINS the state CAS, installing attempt B
  // before the operator's cancel answer commits.
  const B = '01890000-0000-7000-8000-00000000000c';
  writeFileSync(
    statePath,
    JSON.stringify({ ...s, state: 'reviewed', current_attempt_id: B, state_version: s.state_version + 1 }),
  );

  const ans = runOrchestrateAnswer({ questionId, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(ans.exitCode, 1, 'the lost race refuses');

  // The invariant: NOTHING was consumed — no durable answer, so the question
  // remains answerable once the operator re-targets the live attempt.
  const answerPath = join(fx.forgeDir, 'orchestrator/tasks', TASK, 'attempts', ATTEMPT, 'answers', `${questionId}.json`);
  assert.equal(existsSync(answerPath), false, 'no answer file may be published when the CAS is lost');

  // Restoring the parked attempt lets the same answer succeed — proof the
  // operator's cancellation was never swallowed.
  writeFileSync(statePath, JSON.stringify({ ...s, state: 'reviewed', state_version: s.state_version + 2 }));
  const retry = runOrchestrateAnswer({ questionId, optionId: 'cancel_task', forgeDir: fx.forgeDir, stdout: sink, stderr: sink });
  assert.equal(retry.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).state, 'cancelled');
  assert.equal(existsSync(answerPath), true, 'the honored answer IS durable');
});
