import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tsxBin, forgeBinEntry as entry } from '../../../helpers/spawn-tsx.ts';
import { runOrchestrateSecondOpinion } from '../../../../src/cli/orchestrate/second-opinion.ts';
import type {
  SpawnOpts,
  SpawnResult,
  SpawnSubprocess,
} from '../../../../src/harnesses/index.ts';

// FORGE-187 integration: drive the auto-review CLI surface end-to-end through
// spawned verbs (the runVerb idiom; FORGE_NOOP_TRACKER=1 keeps it hermetic):
//   - PASS path:     ready_for_review → review-compose(kind=verdict) →
//                    complete --phase review → reviewed.
//   - ESCALATE path: ready_for_review + critical block → review-compose(escalate)
//                    → question → blocked_on_question (the 184 transition).
//   - SECOND-OPINION seam: the second opinion is produced via
//     runOrchestrateSecondOpinion(..., { spawnSubprocess: fakeSpawn('codex') })
//     — the documented test seam — then fed into review-compose.
//
// R4: runOrchestrateSecondOpinion loads .forge/settings.yaml and requires
// agents.review_host_cli ∈ {codex,gemini}; this test writes a valid one first,
// mirroring test/integration/cli/orchestrate-second-opinion.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const fixturePath = resolve(repoRoot, 'test', 'fixtures', 'orchestrator', '3-task-phases.yaml');

function runVerb(args: readonly string[], cwd: string): {
  envelope: Record<string, unknown>;
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, FORGE_NOOP_TRACKER: '1' };
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

// Set up a forge project from the 3-task fixture + a valid settings.yaml
// (review_host_cli: codex) for the second-opinion seam.
function setupProject(): { work: string; forgeDir: string; runId: string } {
  const work = mkdtempSync(join(tmpdir(), 'forge-autoreview-'));
  const forgeDir = join(work, '.forge');
  mkdirSync(join(work, 'plans'), { recursive: true });
  copyFileSync(fixturePath, join(work, 'plans/phases.yaml'));
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    `version: 1
project:
  name: auto-review-integration
tracker:
  type: linear
  config:
    team_id: T
secrets:
  manager: env_file
agents:
    primary_host_cli: claude
    review_host_cli: codex
`,
    'utf8',
  );

  const res = runVerb(['orchestrate', 'run', 'start', '--name', 'ar', '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0, `run start failed: ${res.stderr}`);
  const runId = (res.envelope.data as { run_id: string }).run_id;
  return { work, forgeDir, runId };
}

// Drive one fixture task from ready (claim → dispatch → heartbeat →
// complete --phase implement) to ready_for_review with a held lease.
function driveToReadyForReview(work: string, forgeDir: string, runId: string, taskId: string): string {
  let res = runVerb(['orchestrate', 'claim', taskId, '--run', runId, '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0, `claim ${taskId} failed: ${res.stderr}`);
  const claimId = (res.envelope.data as { claim_id: string }).claim_id;

  const wt = join(work, `wt-${taskId}`);
  mkdirSync(wt, { recursive: true });
  res = runVerb(
    ['orchestrate', 'dispatch', taskId, '--claim', claimId, '--run', runId, '--worktree', wt, '--phase', 'implement', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `dispatch ${taskId} failed: ${res.stderr}`);
  const attemptId = (res.envelope.data as { attempt_id: string }).attempt_id;

  res = runVerb(['orchestrate', 'heartbeat', taskId, '--attempt', attemptId, '--forge-dir', forgeDir], work);
  assert.equal(res.status, 0, `heartbeat ${taskId} failed: ${res.stderr}`);

  const implVerdict = join(work, `verdict-impl-${taskId}.json`);
  writeFileSync(
    implVerdict,
    JSON.stringify({
      version: 1,
      verdict: 'ready_for_review',
      summary: 'Implemented.',
      tests: { ran: true, passed: 1, failed: 0, skipped: 0, duration_ms: 10, output_excerpt: 'ok' },
      lint: { ran: true, clean: true, violations: 0, output_excerpt: 'ok' },
      branch: `feat/${taskId}`,
      save_point: 'done',
    }),
    'utf8',
  );
  res = runVerb(
    ['orchestrate', 'complete', taskId, '--attempt', attemptId, '--verdict-file', implVerdict, '--phase', 'implement', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `implement complete ${taskId} failed: ${res.stderr}`);
  assert.equal((res.envelope.data as { next_state: string }).next_state, 'ready_for_review');
  return attemptId;
}

function writeReviewVerdict(work: string, name: string, value: unknown): string {
  const p = join(work, name);
  writeFileSync(p, JSON.stringify(value), 'utf8');
  return p;
}

function taskState(forgeDir: string, taskId: string): string {
  return JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator', 'tasks', taskId, 'state.json'), 'utf8'),
  ).state;
}

// fakeSpawn echoes a fenced ReviewVerdict JSON block — the second-opinion test
// seam (mirrors orchestrate-second-opinion.test.ts).
function fakeSpawn(host: 'codex' | 'gemini'): SpawnSubprocess {
  return async (_c: string, _a: readonly string[], _o: SpawnOpts): Promise<SpawnResult> => ({
    stdout: `preamble\n\n\`\`\`json\n${JSON.stringify({
      version: 1,
      verdict: 'pass',
      findings: [],
      host,
    })}\n\`\`\`\n`,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  });
}

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return lines;
}

test('auto-review PASS path: first-class review attempt → witness + pinned compose → complete --phase review → reviewed', () => {
  const { work, forgeDir, runId } = setupProject();
  driveToReadyForReview(work, forgeDir, runId, 'ETOE-1');
  assert.equal(taskState(forgeDir, 'ETOE-1'), 'ready_for_review');

  // FORGE-231: REVIEW is a first-class attempt against a REAL worktree whose
  // marker freezes the base branch; dispatch pins BOTH diff endpoints.
  const wt = join(work, 'review-wt');
  mkdirSync(wt, { recursive: true });
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return String(r.stdout ?? '').trim();
  };
  git('init', '-q');
  writeFileSync(join(wt, 'a.txt'), 'base\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', baseSha);
  writeFileSync(join(wt, 'a.txt'), 'work\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
  const headSha = git('rev-parse', 'HEAD');
  mkdirSync(join(wt, '.forge'), { recursive: true });
  writeFileSync(
    join(wt, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId: 'ETOE-1', branch: 'feat/ETOE-1', base_branch: 'main' }) + '\n',
    'utf8',
  );

  const lease = JSON.parse(readFileSync(join(forgeDir, 'orchestrator/tasks/ETOE-1/lease.json'), 'utf8'));
  let res = runVerb(
    ['orchestrate', 'dispatch', 'ETOE-1', '--claim', lease.claim_id, '--run', runId, '--worktree', wt, '--phase', 'review', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `review dispatch failed: ${res.stderr}`);
  const reviewAttempt = (res.envelope.data as { attempt_id: string }).attempt_id;

  // The RAW witness (the review host's verdict, pinned to the reviewed SHA)
  // lands in the attempt dir — settings review_host_cli is codex here.
  const witness = {
    version: 1,
    verdict: 'pass',
    findings: [],
    host: 'codex',
    target_sha: headSha,
  };
  const attemptDirPath = join(forgeDir, 'orchestrator/tasks/ETOE-1/attempts', reviewAttempt);
  mkdirSync(attemptDirPath, { recursive: true });
  writeFileSync(join(attemptDirPath, 'review_verdict.json'), JSON.stringify(witness), 'utf8');
  const primary = writeReviewVerdict(work, 'primary-1.json', witness);

  // Pinned composition: --expected-target-sha carries the pin onto the
  // composed carrier the completion gate verifies.
  res = runVerb(
    ['orchestrate', 'review-compose', '--primary', primary, '--branch', 'feat/ETOE-1', '--summary', 'Review passed.', '--expected-primary-host', 'codex', '--expected-target-sha', headSha, '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `review-compose failed: ${res.stderr}`);
  const composed = res.envelope.data as { kind: string; verdict: Record<string, unknown> };
  assert.equal(composed.kind, 'verdict');
  assert.equal(composed.verdict.verdict, 'ready_for_review');
  assert.equal(composed.verdict.target_sha, headSha, 'composed carrier must carry the pin');

  const verdictFile = writeReviewVerdict(work, 'composed-1.json', composed.verdict);
  res = runVerb(
    ['orchestrate', 'complete', 'ETOE-1', '--attempt', reviewAttempt, '--verdict-file', verdictFile, '--phase', 'review', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `complete --phase review failed: ${res.stderr}`);
  assert.equal((res.envelope.data as { next_state: string }).next_state, 'reviewed');
  assert.equal(taskState(forgeDir, 'ETOE-1'), 'reviewed');

  // §C3 write-ahead: the ship record was minted with the reviewed binding.
  const record = JSON.parse(
    readFileSync(join(forgeDir, 'orchestrator/tasks/ETOE-1/ship-record.json'), 'utf8'),
  );
  assert.equal(record.reviewed_head_sha, headSha);
  assert.equal(record.review_attempt_id, reviewAttempt);
});

test('auto-review ESCALATE path: critical block → review-compose escalate → question → blocked_on_question', () => {
  const { work, forgeDir, runId } = setupProject();
  const attemptId = driveToReadyForReview(work, forgeDir, runId, 'ETOE-2');
  assert.equal(taskState(forgeDir, 'ETOE-2'), 'ready_for_review');

  // Primary review carries a block finding; --critical-path forces escalation.
  const primary = writeReviewVerdict(work, 'primary-2.json', {
    version: 1,
    verdict: 'changes_requested',
    findings: [{ severity: 'block', path: 'src/core/state-machine.ts', message: 'Breaks the transition table.' }],
    host: 'claude',
  });

  let res = runVerb(
    ['orchestrate', 'review-compose', '--primary', primary, '--branch', 'feat/ETOE-2', '--summary', 'Architectural concern.', '--critical-path', '--expected-primary-host', 'claude', '--forge-dir', forgeDir],
    work,
  );
  assert.equal(res.status, 0, `review-compose failed: ${res.stderr}`);
  const composed = res.envelope.data as { kind: string; reason: string };
  assert.equal(composed.kind, 'escalate');
  assert.equal(typeof composed.reason, 'string');

  // Escalate → write a question, which parks the task (184 transition).
  res = runVerb(
    [
      'orchestrate', 'question', 'ETOE-2',
      '--attempt', attemptId,
      '--decision-key', 'arch:auto-review:etoe-2',
      '--question', 'Architectural block on a critical path — how should we proceed?',
      '--recommended-option-id', 'yes',
      '--what-happens-if-unanswered', 'Task stays parked until you decide.',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `question write failed: ${res.stderr}`);
  assert.ok((res.envelope.data as { question_id: string }).question_id);
  assert.equal(taskState(forgeDir, 'ETOE-2'), 'blocked_on_question');
});

test('auto-review SECOND-OPINION seam: runOrchestrateSecondOpinion(fakeSpawn) verdict feeds review-compose', async (t) => {
  const { work, forgeDir, runId } = setupProject();
  driveToReadyForReview(work, forgeDir, runId, 'ETOE-3');

  // Produce the second opinion through the documented test seam (R4: settings
  // .yaml with review_host_cli: codex was written in setupProject).
  const diffPath = join(work, 'diff.txt');
  const promptPath = join(work, 'prompt.txt');
  writeFileSync(diffPath, 'diff --git a/src/core/x.ts b/src/core/x.ts\n+change\n', 'utf8');
  writeFileSync(promptPath, 'Review for architectural risk.\n', 'utf8');

  const lines = captureStdout(t);
  const soResult = await runOrchestrateSecondOpinion(
    { taskId: 'ETOE-3', diffPath, promptPath, forgeDir, json: true },
    { spawnSubprocess: fakeSpawn('codex') },
  );
  assert.equal(soResult.exitCode, 0);
  const soEnvelope = lines[lines.length - 1] ?? '';

  // The second-opinion envelope is fed straight into review-compose (R3: the
  // verb unwraps {ok,data:{verdict}}). Write it to a file as the skill would.
  const secondFile = join(work, 'second-3.json');
  writeFileSync(secondFile, soEnvelope.trim(), 'utf8');

  const primary = writeReviewVerdict(work, 'primary-3.json', {
    version: 1,
    verdict: 'pass',
    findings: [],
    host: 'claude',
  });

  const res = runVerb(
    [
      'orchestrate', 'review-compose',
      '--primary', primary,
      '--second-opinion', secondFile,
      '--branch', 'feat/ETOE-3',
      '--summary', 'Both reviews passed.',
      '--critical-path',
      '--second-opinion-available',
      '--expected-primary-host', 'claude',
      '--forge-dir', forgeDir,
    ],
    work,
  );
  assert.equal(res.status, 0, `review-compose failed: ${res.stderr}`);
  const composed = res.envelope.data as { kind: string; verdict: Record<string, unknown> };
  // Critical path WITH a real second opinion → a machine verdict, not park.
  assert.equal(composed.kind, 'verdict');
  assert.equal(composed.verdict.verdict, 'ready_for_review');
});
