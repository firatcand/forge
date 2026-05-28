import { test } from 'node:test';
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
import { join, resolve } from 'node:path';

import { tsxBin, forgeBinEntry as entry, repoRoot } from '../../../helpers/spawn-tsx.ts';

// Integration test for the /forge orchestrate dispatch skill flow (FORGE-98).
//
// Spawns src/bin/forge.ts via tsx (FORGE-122 helper) so the test always runs
// against current source — no stale-dist false-pass risk (Codex review-impl #5).
// Drives what the SKILL.md does at runtime:
//   1. run start              → mint run_id
//   2. phases --ready --run --json → list tasks
//   3. ensure-worktree (NEW)  → idempotent worktree + hydrate
//   4. claim                  → CAS-protected claim
//   5. dispatch               → write manifest, transition to dispatched
//   6. render-worker-prompt (NEW) → render the prompt for spawn
//   7. (skill spawns via host Task tool — mocked here; we don't fork claude)
//   8. question (worker)      → write a question
//   9. questions --open --run --json (NEW) → skill polls scoped to run
//  10. answer                 → user answers via skill
//
// FORGE_NOOP_TRACKER=1 forces NoopTracker on every claim call so the test
// is hermetic (no Linear/GitHub/Notion dependencies).

const fixturePath = resolve(repoRoot, 'test', 'fixtures', 'orchestrator', '3-task-phases.yaml');
const templateSrc = resolve(repoRoot, 'templates', 'worker-prompt.template.md');

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
  // Run against source via tsx (FORGE-122 spawn-tsx helper). Avoids the
  // stale-dist false-pass that bit Codex review-impl #5 — tests would
  // silently pass against an out-of-date dist binary if the rebuild
  // condition (only-if-missing) wasn't triggered.
  const res = spawnSync(tsxBin, [entry, ...args, '--json'], { cwd, env, encoding: 'utf8' });
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

// Bootstrap a git repo in the work dir so ensure-worktree can run
// `git worktree add` against it. The fixture phases.yaml and a CLAUDE.md
// are placed at the repo root before the first commit so render-worker-prompt
// has sources for both task description and conventions.
function bootstrapRepo(work: string): void {
  // node:child_process.spawnSync is fine; this is test infra, not user input.
  for (const cmd of [
    ['git', ['init', '-b', 'main', work]],
    ['git', ['-C', work, 'config', 'user.email', 'test@example.com']],
    ['git', ['-C', work, 'config', 'user.name', 'Test']],
    ['git', ['-C', work, 'config', 'commit.gpgsign', 'false']],
  ] as const) {
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd.join(' ')} → ${r.stderr}`);
  }
  // Plant CLAUDE.md + phases.yaml + a copy of the template so the verbs find
  // their inputs when invoked from `work` as cwd.
  writeFileSync(join(work, 'CLAUDE.md'), '# Test project conventions.\n');
  mkdirSync(join(work, 'plans'), { recursive: true });
  copyFileSync(fixturePath, join(work, 'plans', 'phases.yaml'));
  mkdirSync(join(work, 'templates'), { recursive: true });
  copyFileSync(templateSrc, join(work, 'templates', 'worker-prompt.template.md'));
  // Initial commit so subsequent `worktree add main` has a base.
  for (const cmd of [
    ['git', ['-C', work, 'add', '.']],
    ['git', ['-C', work, 'commit', '-m', 'bootstrap', '--allow-empty']],
  ] as const) {
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd.join(' ')} → ${r.stderr}`);
  }
}

test('dispatch-skill-flow: full per-round flow drives one task to dispatched state', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-dispatch-flow-'));
  bootstrapRepo(work);
  const forgeDir = join(work, '.forge');

  // 1. run start
  let res = runVerb(
    ['orchestrate', 'run', 'start', '--name', 'dispatch-flow', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `run start failed: ${res.stderr}`);
  const runData = res.envelope.data as { run_id: string };
  const runId = runData.run_id;

  // 2. phases --ready (with --run for scoping)
  res = runVerb(
    ['orchestrate', 'phases', '--ready', '--run', runId, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `phases --ready failed: ${res.stderr}`);
  const phasesData = res.envelope.data as { tasks: Array<{ task_id: string }> };
  assert.equal(phasesData.tasks.length, 3);
  const taskId = 'ETOE-1';

  // 3. ensure-worktree — NEW verb, idempotent
  res = runVerb(
    ['orchestrate', 'ensure-worktree', '--task', taskId, '--base', 'main', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `ensure-worktree failed: ${res.stderr}`);
  const wtData = res.envelope.data as { worktree_path: string; created: boolean };
  assert.equal(wtData.created, true);
  assert.ok(existsSync(wtData.worktree_path));
  assert.ok(existsSync(join(wtData.worktree_path, '.forge', 'worktree-task.json')));

  // 3b. Second ensure-worktree call is a no-op (idempotence).
  res = runVerb(
    ['orchestrate', 'ensure-worktree', '--task', taskId, '--base', 'main', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0);
  const wt2 = res.envelope.data as { created: boolean };
  assert.equal(wt2.created, false, 'idempotent re-call should not re-create');

  // 4. claim
  res = runVerb(
    ['orchestrate', 'claim', taskId, '--run', runId, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `claim failed: ${res.stderr}`);
  const claimData = res.envelope.data as { claim_id: string };

  // 5. dispatch
  res = runVerb(
    [
      'orchestrate', 'dispatch', taskId,
      '--claim', claimData.claim_id,
      '--run', runId,
      '--worktree', wtData.worktree_path,
      '--phase', 'implement',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `dispatch failed: ${res.stderr}`);
  const dispatchData = res.envelope.data as { attempt_id: string };

  // 6. render-worker-prompt — NEW verb. Returns the full prompt the skill
  //    would inject into the host's Task tool.
  res = runVerb(
    [
      'orchestrate', 'render-worker-prompt',
      '--task', taskId,
      '--attempt', dispatchData.attempt_id,
      '--repo-root', work,
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `render-worker-prompt failed: ${res.stderr}`);
  const renderData = res.envelope.data as { prompt: string; host: string; phase: string; task_id: string };
  assert.equal(renderData.task_id, taskId);
  assert.equal(renderData.phase, 'IMPLEMENT');
  assert.match(renderData.prompt, new RegExp(taskId));
  // Acceptance bullet from fixture phases.yaml.
  assert.match(renderData.prompt, /- happy-path-runs/);
  // Conventions content from the CLAUDE.md we planted.
  assert.match(renderData.prompt, /Test project conventions/);

  // 7. Final state assertion: task is 'dispatched'.
  const state = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks', taskId, 'state.json'), 'utf8'),
  );
  assert.equal(state.state, 'dispatched');
  assert.equal(state.current_attempt_id, dispatchData.attempt_id);
});

test('dispatch-skill-flow: question round — workers write, skill polls --run --json, answers', () => {
  const work = mkdtempSync(join(tmpdir(), 'forge-dispatch-q-'));
  bootstrapRepo(work);
  const forgeDir = join(work, '.forge');

  // Mint two runs in the same .forge tree so we can prove --run actually filters.
  let res = runVerb(['orchestrate', 'run', 'start', '--forge-dir', forgeDir], work);
  const runA = (res.envelope.data as { run_id: string }).run_id;
  res = runVerb(['orchestrate', 'run', 'start', '--forge-dir', forgeDir], work);
  const runB = (res.envelope.data as { run_id: string }).run_id;

  // Dispatch ETOE-1 under runA, ETOE-2 under runB. Both will write questions
  // tagged with their respective run_ids; the skill's --run filter must
  // surface only runA's question when called with --run runA.
  // `runVerb` is spawnSync-backed, so all work here is synchronous — the
  // helper is non-async on purpose, no promise wrapping or await needed.
  function dispatchAndQuestion(taskId: string, runId: string): string {
    let r = runVerb(
      ['orchestrate', 'ensure-worktree', '--task', taskId, '--base', 'main', '--forge-dir', forgeDir],
      work,
    );
    assert.equal(r.status, 0, `ensure-worktree ${taskId}: ${r.stderr}`);
    const wt = (r.envelope.data as { worktree_path: string }).worktree_path;

    r = runVerb(['orchestrate', 'claim', taskId, '--run', runId, '--forge-dir', forgeDir], work);
    assert.equal(r.status, 0, `claim ${taskId}: ${r.stderr}`);
    const claimId = (r.envelope.data as { claim_id: string }).claim_id;

    r = runVerb(
      [
        'orchestrate', 'dispatch', taskId,
        '--claim', claimId, '--run', runId, '--worktree', wt,
        '--forge-dir', forgeDir,
      ],
      work,
    );
    assert.equal(r.status, 0, `dispatch ${taskId}: ${r.stderr}`);
    const attemptId = (r.envelope.data as { attempt_id: string }).attempt_id;

    r = runVerb(
      [
        'orchestrate', 'question', taskId,
        '--attempt', attemptId,
        '--decision-key', `decide-${taskId.toLowerCase()}`,
        '--question', `Which path for ${taskId}?`,
        // FORGE-65: the question verb now requires these on every write (AC8).
        '--recommended-option-id', 'yes',
        '--what-happens-if-unanswered', 'Block the task until the supervisor answers.',
        '--forge-dir', forgeDir,
      ],
      work,
    );
    assert.equal(r.status, 0, `question write ${taskId}: ${r.stderr}`);
    return (r.envelope.data as { question_id: string }).question_id;
  }

  // We don't actually need the returned IDs — the verb writes them to disk
  // and the questions --open call below rediscovers them. Just drive the
  // side effects.
  dispatchAndQuestion('ETOE-1', runA);
  dispatchAndQuestion('ETOE-2', runB);

  // Sanity: without --run filter, both questions are visible.
  res = runVerb(['orchestrate', 'questions', '--open', '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0);
  const allOpen = res.envelope.data as { questions: Array<{ question_id: string }> };
  assert.equal(allOpen.questions.length, 2, 'both runs should have open questions');

  // FORGE-98 / Codex #9: --run scopes the listing to one run only.
  res = runVerb(
    ['orchestrate', 'questions', '--open', '--run', runA, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0);
  const onlyA = res.envelope.data as { questions: Array<{ question_id: string; run_id: string }> };
  assert.equal(onlyA.questions.length, 1, 'filter must trim to runA only');
  assert.equal(onlyA.questions[0]?.run_id, runA);
  // Skill would now AskUserQuestion(this), then call `answer`.
  const targetQid = onlyA.questions[0]!.question_id;
  const targetOption = onlyA.questions[0]!['options' as keyof typeof onlyA.questions[0]] as unknown as Array<{ id: string }>;
  const optionId = targetOption[0]!.id;

  res = runVerb(
    [
      'orchestrate', 'answer', targetQid,
      '--option', optionId,
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `answer failed: ${res.stderr}`);

  // After answer, runA's open list is empty; runB's still has its question.
  res = runVerb(
    ['orchestrate', 'questions', '--open', '--run', runA, '--forge-dir', forgeDir],
    work,
  );
  const afterA = res.envelope.data as { questions: unknown[] };
  assert.equal(afterA.questions.length, 0, 'runA question is no longer open after answer');

  res = runVerb(
    ['orchestrate', 'questions', '--open', '--run', runB, '--forge-dir', forgeDir],
    work,
  );
  const stillB = res.envelope.data as { questions: unknown[] };
  assert.equal(stillB.questions.length, 1, 'runB question untouched');
});
