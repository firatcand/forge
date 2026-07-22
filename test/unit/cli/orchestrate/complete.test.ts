import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { execaSync } from 'execa';

import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { runOrchestrateHeartbeat } from '../../../../src/cli/orchestrate/heartbeat.ts';
import { runOrchestrateComplete } from '../../../../src/cli/orchestrate/complete.ts';
import type { RunCommand } from '../../../../src/orchestrator/verify-runner.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    // Keep only envelope-shaped lines: the test runner's own spec-reporter
    // output (ANSI + ✔ glyphs) can land in this capture asynchronously and
    // must never be mistaken for the last envelope.
    const s = String(chunk);
    if (s.trimStart().startsWith('{')) buf.push(s);
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
  async setClaimFence(): Promise<void> {}
}

async function setupRunning(
  stdout: string[],
  opts: { worktreePath?: string } = {},
): Promise<{
  forgeDir: string;
  repoRoot: string;
  attemptId: string;
  worktreePath: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-complete-'));
  const forgeDir = join(repoRoot, '.forge');
  const worktreePath = opts.worktreePath ?? '/tmp/wt';
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
    worktreePath,
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
  return { forgeDir, repoRoot, attemptId: dispatchEnv.data.attempt_id, worktreePath };
}

// FORGE-188: write a settings.yaml with a `verify` block into the forge dir so
// the implement-phase completion re-runs it. The block must satisfy
// SettingsSchema (version 1 + project + tracker + agents + ...). We write only
// the fields the schema requires plus `verify`; loadSettings validates the rest
// via defaults.
function writeSettingsWithVerify(forgeDir: string, commands: string[]): void {
  mkdirSync(forgeDir, { recursive: true });
  const yaml = [
    'version: 1',
    'project:',
    '  name: forge-test',
    'tracker:',
    '  type: github',
    '  config:',
    '    repo: owner/repo',
    'secrets:',
    '  manager: env_file',
    'verify:',
    '  commands:',
    ...commands.map((c) => `    - ${JSON.stringify(c)}`),
    '',
  ].join('\n');
  writeFileSync(join(forgeDir, 'settings.yaml'), yaml, 'utf8');
}

// FORGE-188 (F2): the worktree must carry the `.forge/worktree-task.json` binding
// marker (taskId === the task) before `complete` will trust it as a verify cwd.
// create() writes this in production; tests that drive verification with a
// hand-rolled mkdtemp worktree must stamp it themselves.
function writeWorktreeMarker(worktreePath: string, taskId: string): void {
  mkdirSync(join(worktreePath, '.forge'), { recursive: true });
  writeFileSync(
    join(worktreePath, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId, branch: `feat/${taskId}` }, null, 2) + '\n',
    'utf8',
  );
}

// FORGE-231: a REAL git worktree with the frozen-base marker — the pinned
// review flow resolves SHAs and derives criticality against actual git.
function makeGitWorktree(repoRoot: string, taskId: string): { worktree: string; headSha: string; baseSha: string } {
  const worktree = join(repoRoot, 'git-wt');
  mkdirSync(worktree, { recursive: true });
  const git = (...args: string[]): string =>
    String(execaSync('git', args, { cwd: worktree, env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }).stdout ?? '').trim();
  git('init', '-q');
  writeFileSync(join(worktree, 'a.txt'), 'base\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', baseSha);
  writeFileSync(join(worktree, 'a.txt'), 'work\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
  const headSha = git('rev-parse', 'HEAD');
  mkdirSync(join(worktree, '.forge'), { recursive: true });
  writeFileSync(
    join(worktree, '.forge', 'worktree-task.json'),
    JSON.stringify({ version: 1, taskId, branch: `feat/${taskId}`, base_branch: 'main' }) + '\n',
    'utf8',
  );
  return { worktree, headSha, baseSha };
}

function writePinnedVerdict(repoRoot: string, verdict: string, targetSha: string): string {
  const p = join(repoRoot, 'pinned-verdict.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      verdict,
      summary: 'Task done',
      tests: { ran: false, passed: 0, failed: 0, skipped: 0, duration_ms: 0, output_excerpt: '' },
      lint: { ran: false, clean: true, violations: 0, output_excerpt: '' },
      branch: 'feat/foo',
      save_point: '',
      target_sha: targetSha,
    }),
    'utf8',
  );
  return p;
}

function writeRawWitness(
  forgeDir: string,
  attemptId: string,
  opts: { verdict?: string; host?: string; targetSha: string },
): void {
  const dir = join(forgeDir, 'orchestrator/tasks/FORGE-1/attempts', attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review_verdict.json'),
    JSON.stringify({
      version: 1,
      verdict: opts.verdict ?? 'pass',
      findings: [],
      host: opts.host ?? 'codex',
      target_sha: opts.targetSha,
    }),
    'utf8',
  );
}

// Drive a task through implement-pass then dispatch a first-class REVIEW
// attempt against a real worktree. Returns the review attempt id + SHAs.
async function advanceToReviewAttempt(
  stdout: string[],
  ctx: { forgeDir: string; repoRoot: string; attemptId: string },
): Promise<{ reviewAttemptId: string; worktree: string; headSha: string; baseSha: string }> {
  const implVerdict = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const r = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: implVerdict,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(r.exitCode, 0, 'implement complete should succeed');
  const wt = makeGitWorktree(ctx.repoRoot, 'FORGE-1');
  const claim = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'), 'utf8'));
  stdout.length = 0;
  const d = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: claim.claim_id,
    runId: claim.owner_run_id,
    worktreePath: wt.worktree,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(d.exitCode, 0, 'review dispatch should succeed');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  stdout.length = 0;
  return { reviewAttemptId: env.data.attempt_id, ...wt };
}

function writeVerdict(repoRoot: string, verdict: string): string {
  const path = join(repoRoot, 'verdict.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      verdict,
      summary: 'Task done',
      tests: { ran: true, passed: 5, failed: 0, skipped: 0, duration_ms: 1000, output_excerpt: 'ok' },
      lint: { ran: true, clean: true, violations: 0, output_excerpt: 'ok' },
      branch: 'feat/foo',
      save_point: 'completed step X',
    }),
    'utf8',
  );
  return path;
}

test('complete with verdict=ready_for_review + phase=implement → state ready_for_review', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.verdict, 'ready_for_review');
  assert.equal(env.data.next_state, 'ready_for_review');
  // Both verdict files present.
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  const vv = JSON.parse(readFileSync(join(dir, 'verdict.verified.json'), 'utf8'));
  assert.equal(v.verdict, 'ready_for_review');
  assert.ok(vv.verified_by);
});

test('FORGE-231: pinned review flow — witness + gateway + ship-record write-ahead → reviewed', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const rv = await advanceToReviewAttempt(stdout, ctx);

  writeRawWitness(ctx.forgeDir, rv.reviewAttemptId, { targetSha: rv.headSha });
  const composed = writePinnedVerdict(ctx.repoRoot, 'ready_for_review', rv.headSha);
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: rv.reviewAttemptId,
    verdictFile: composed,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0, 'review complete should succeed');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'reviewed');
  assert.match(env.data.verdict_path, /verdict\.review\.json$/);

  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'reviewed');

  // §C3 write-ahead: the ship record carries the reviewed binding.
  const record = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/ship-record.json'), 'utf8'),
  );
  assert.equal(record.reviewed_head_sha, rv.headSha);
  assert.equal(record.review_attempt_id, rv.reviewAttemptId);
  assert.equal(record.merge_attempt, 'not_started');
  assert.equal(record.base, null);
  assert.equal(record.pr, null);
});

test('FORGE-231: pinned review gate rejects a substituted composed carrier (witness says changes_requested)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const rv = await advanceToReviewAttempt(stdout, ctx);

  // Raw witness FAILS the review; a forged ready_for_review carrier must die.
  writeRawWitness(ctx.forgeDir, rv.reviewAttemptId, { verdict: 'changes_requested', targetSha: rv.headSha });
  const forged = writePinnedVerdict(ctx.repoRoot, 'ready_for_review', rv.headSha);
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: rv.reviewAttemptId,
    verdictFile: forged,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_VERDICT');
  assert.match(env.error.message, /does not match the trusted recomposition/);
  // Nothing advanced.
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'ready_for_review');
});
test('FORGE-231: ship completion → merge_pending ONLY behind a complete ship record', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const rv = await advanceToReviewAttempt(stdout, ctx);
  writeRawWitness(ctx.forgeDir, rv.reviewAttemptId, { targetSha: rv.headSha });
  const composed = writePinnedVerdict(ctx.repoRoot, 'ready_for_review', rv.headSha);
  let result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: rv.reviewAttemptId,
    verdictFile: composed,
    phase: 'review',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  stdout.length = 0;

  // Dispatch a first-class SHIP attempt from reviewed.
  const claim = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'), 'utf8'));
  const d = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: claim.claim_id,
    runId: claim.owner_run_id,
    worktreePath: rv.worktree,
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(d.exitCode, 0);
  const shipAttempt = JSON.parse(stdout[stdout.length - 1] ?? '').data.attempt_id;
  stdout.length = 0;

  // Incomplete record (base/pr null) → refused.
  const shipVerdict = writeVerdict(ctx.repoRoot, 'ready_for_review');
  result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: shipAttempt,
    verdictFile: shipVerdict,
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  let env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'SHIP_RECORD_INCOMPLETE');
  stdout.length = 0;

  // Populate base + pr (the FORGE-234 write-ahead stages, hand-rolled here)…
  const recordPath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/ship-record.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(
    recordPath,
    JSON.stringify({
      ...record,
      revision: record.revision + 1,
      base: { repo: 'o/r', branch: 'main', push_remote: 'origin' },
      pr: { repo: 'o/r', number: 7, url: 'https://example.test/pr/7' },
      merge_attempt: 'submitted',
    }),
    'utf8',
  );

  // …then the ship completion enters the ASYNC merge wait — merge_pending,
  // never shipped (the platform merge is the only proof).
  result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: shipAttempt,
    verdictFile: writeVerdict(ctx.repoRoot, 'ready_for_review'),
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'merge_pending');
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'merge_pending');

  // impl R1 MAJ-5: the worker lease is RELEASED (tombstoned) after entering
  // merge_pending — no heartbeat source exists while the platform merges.
  const leaseAfter = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'), 'utf8'),
  );
  assert.equal(leaseAfter.status, 'released', 'ship completion must release the worker lease');

  // impl R1 MAJ-6: the ADVISORY merge_pending event was appended.
  const notifPath = join(ctx.forgeDir, 'orchestrator/runs', claim.owner_run_id, 'notifications.jsonl');
  const events = readFileSync(notifPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const mp = events.find((e) => e.type === 'merge_pending');
  assert.ok(mp, 'merge_pending event emitted');
  assert.equal(mp.pr_url, 'https://example.test/pr/7');
});

test('FORGE-231: retry exhaustion commits failed AND appends the fatal notification (impl R1 MAJ-6)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // One failure away from the default budget (10).
  const statePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  const cur = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(
    statePath,
    JSON.stringify({ ...cur, failure_count: 9, state_version: cur.state_version + 1 }),
    'utf8',
  );

  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'failed');
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.state, 'failed');
  assert.equal(after.failure_reason, 'retries_exhausted');
  assert.equal(after.failure_count, 10);

  const lease = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'), 'utf8'));
  const notifPath = join(ctx.forgeDir, 'orchestrator/runs', lease.owner_run_id ?? lease.released_by?.run_id, 'notifications.jsonl');
  const events = readFileSync(notifPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const fatal = events.find((e) => e.type === 'fatal');
  assert.ok(fatal, 'fatal notification appended on exhaustion');
  assert.match(fatal.reason, /retry budget exhausted/);
});
test('FORGE-231: changes_needed → awaiting_respawn with ONE budget increment + failure key', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const vf = writeVerdict(ctx.repoRoot, 'changes_needed');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: vf,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'awaiting_respawn');
  const state = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(state.state, 'awaiting_respawn');
  assert.equal(state.failure_count, 1);
  assert.equal(state.last_failure_key, `${ctx.attemptId}:implement`);
  assert.ok(state.last_failed_at, 'last_failed_at recorded');

  // Crash-replay: the SAME completion short-circuits BEFORE any transition —
  // no double-count, no illegal transition.
  stdout.length = 0;
  const replay = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(replay.exitCode, 0);
  const replayEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(replayEnv.data.replayed, true);
  const after = JSON.parse(
    readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'),
  );
  assert.equal(after.failure_count, 1, 'replay must not re-increment the budget');
});
test('complete --phase ship against an implement attempt refuses with PHASE_MISMATCH', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const vf = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: vf,
    phase: 'ship',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'PHASE_MISMATCH');
});
test('complete with malformed verdict file fails INVALID_VERDICT', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const bad = join(ctx.repoRoot, 'bad.json');
  writeFileSync(bad, JSON.stringify({ verdict: 'unknown' }), 'utf8');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: bad,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'INVALID_VERDICT');
});

// Review-fix #3: if the verified-file write fails after the verdict file was
// created (wx), the orphan verdict file must be rolled back so the phase can be
// retried without an EEXIST collision.
test('complete: verified-write failure rolls back the verdict file', async (t) => {
  const { mkdirSync } = await import('node:fs');
  const { attemptDir } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Pre-create verdict.verified.json so its `wx` write fails (EEXIST) while
  // verdict.json (fresh) succeeds first.
  const dir = attemptDir(ctx.forgeDir, 'FORGE-1', ctx.attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict.verified.json'), '{"pre":"existing"}', 'utf8');
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile,
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'IO_ERROR');
  // The just-written verdict.json must have been rolled back.
  assert.equal(existsSync(join(dir, 'verdict.json')), false, 'orphan verdict.json should be cleaned up');
});

// ── FORGE-188: independent CLI re-verification in `complete` ─────────────────

test('FORGE-188: ready_for_review + implement + settings.verify PASS → cli@live, verification.ran', async (t) => {
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test', 'npm run lint']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');

  const calls: string[] = [];
  const run: RunCommand = async (command, opts) => {
    calls.push(`${command}@${opts.cwd}`);
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'ready_for_review');

  // Verify ran in the dispatch-manifest worktree, both commands.
  assert.deepEqual(calls, [`npm test@${worktreePath}`, `npm run lint@${worktreePath}`]);

  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  const vv = JSON.parse(readFileSync(join(dir, 'verdict.verified.json'), 'utf8'));
  assert.equal(vv.verified_by, 'cli@live');
  assert.equal(vv.verification.ran, true);
  assert.equal(vv.verification.passed, true);
  assert.equal(vv.verification.results.length, 2);
});

test('FORGE-188: ready_for_review + implement + settings.verify FAIL → VERIFICATION_FAILED, no writes, stays running', async (t) => {
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test', 'npm run lint']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');

  const run: RunCommand = async (command) => ({ exitCode: command === 'npm run lint' ? 1 : 0 });

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'VERIFICATION_FAILED');
  assert.equal(env.error.details.reason, 'commands_failed');
  assert.deepEqual(env.error.details.failed_commands, ['npm run lint']);

  // No orphan verdict files; state untouched.
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false, 'no verdict.json on verification failure');
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false, 'no verdict.verified.json on verification failure');
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188: ready_for_review + implement + NO settings.verify → self-attest, verification.ran=false', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // No settings.yaml written → FILE_NOT_FOUND → unconfigured → skip.
  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(invoked, false, 'verify must not run when unconfigured');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.next_state, 'ready_for_review');

  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  const vv = JSON.parse(readFileSync(join(dir, 'verdict.verified.json'), 'utf8'));
  assert.equal(vv.verified_by, 'cli@self-attest');
  assert.equal(vv.verification.ran, false);
  assert.equal(typeof vv.verification.skipped_reason, 'string');
});

test('FORGE-188 (R1): settings.verify present but worktree MISSING → VERIFICATION_FAILED (worktree_missing), fail closed', async (t) => {
  const stdout = captureStdout(t);
  // Dispatch into a path that does NOT exist on disk → resolved worktree missing.
  const missing = join(tmpdir(), `forge-missing-wt-${uuidv7()}`);
  const ctx = await setupRunning(stdout, { worktreePath: missing });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run when the worktree is missing');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'VERIFICATION_FAILED');
  assert.equal(env.error.details.reason, 'worktree_missing');
  assert.equal(env.error.details.path, missing);

  // Fail closed: NEITHER verdict file written, state untouched.
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188: changes_needed + settings.verify present → verify NOT run (only implement/ready_for_review verifies)', async (t) => {
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'changes_needed');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(invoked, false, 'verify must not run on the failure path');
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'awaiting_respawn');
});

// ── FORGE-188 hardening: adversarial bypass-surface tests (F1–F4) ────────────

test('FORGE-188 (F1): stale attemptId (≠ current_attempt_id) → STALE_ATTEMPT, no writes, stays running', async (t) => {
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  // A worktree that WOULD pass binding+verify, to prove F1 fires first regardless.
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');

  const staleAttemptId = uuidv7(); // valid shape, but never the current attempt
  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: staleAttemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run for a non-current attempt');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'STALE_ATTEMPT');
  assert.equal(env.error.retriable, false);
  assert.equal(env.error.details.current_attempt_id, ctx.attemptId);
  assert.equal(env.error.details.supplied_attempt_id, staleAttemptId);

  // NEITHER verdict file for EITHER attempt; state unchanged (still running).
  const curDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  const staleDir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', staleAttemptId);
  assert.equal(existsSync(join(curDir, 'verdict.json')), false);
  assert.equal(existsSync(join(curDir, 'verdict.verified.json')), false);
  assert.equal(existsSync(join(staleDir, 'verdict.json')), false);
  assert.equal(existsSync(join(staleDir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
  assert.equal(state.current_attempt_id, ctx.attemptId);
});

test("FORGE-188 (F2): manifest worktree_path points at ANOTHER task's marked worktree → VERIFICATION_FAILED marker_mismatch", async (t) => {
  const { manifestFilePath } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  // Real worktree, but its marker binds it to a DIFFERENT task.
  const otherWorktree = mkdtempSync(join(tmpdir(), 'forge-wt-other-'));
  writeWorktreeMarker(otherWorktree, 'FORGE-999');
  const ctx = await setupRunning(stdout, { worktreePath: otherWorktree });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  // Confirm the dispatch manifest points at the foreign worktree.
  const manifest = JSON.parse(
    readFileSync(manifestFilePath(ctx.forgeDir, 'FORGE-1', ctx.attemptId), 'utf8'),
  );
  assert.equal(manifest.worktree_path, otherWorktree);

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run in a foreign-bound worktree');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'VERIFICATION_FAILED');
  assert.equal(env.error.details.reason, 'marker_mismatch');

  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188 (F3): malformed manifest.json (present, unparseable) → SCHEMA_INVALID at the phase-binding gate', async (t) => {
  const { manifestFilePath } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');
  // Corrupt the dispatch manifest: present but NOT valid JSON. This must NOT be
  // masked as a legacy-absent record and silently fall back to the canonical path.
  writeFileSync(manifestFilePath(ctx.forgeDir, 'FORGE-1', ctx.attemptId), '{ not json', 'utf8');

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run with a corrupt dispatch manifest');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  // FORGE-231: an unparseable/shape-invalid manifest dies at the phase-binding
  // gate (SCHEMA_INVALID), before verification is even considered.
  assert.equal(env.error.code, 'SCHEMA_INVALID');

  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188 (R2 re-review): manifest PRESENT-but-unreadable (EISDIR) → STALE_ATTEMPT at the identity gate, no fallback', async (t) => {
  const { manifestFilePath } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');
  // Manifest path is a DIRECTORY → readFileSync throws EISDIR (NOT ENOENT). A
  // present-but-unreadable dispatch record must NOT be masked as legacy-absent and
  // fall back to the canonical worktree — it must fail closed.
  const mp = manifestFilePath(ctx.forgeDir, 'FORGE-1', ctx.attemptId);
  rmSync(mp, { force: true }); // remove the dispatch-written manifest file…
  mkdirSync(mp, { recursive: true }); // …and replace it with a directory → EISDIR on read

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run when the dispatch manifest is unreadable');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'STALE_ATTEMPT');
    const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188 (3rd-pass): manifest ABSENT (ENOENT) → STALE_ATTEMPT at the identity gate, NO canonical fallback', async (t) => {
  const { manifestFilePath } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');
  // Also seed the CANONICAL worktree with a valid matching marker — if a fallback
  // existed, verification would wrongly run+pass there. Deleting the manifest must
  // NOT redirect to it.
  const canonical = join(ctx.forgeDir, 'worktrees', 'FORGE-1');
  writeWorktreeMarker(canonical, 'FORGE-1');
  rmSync(manifestFilePath(ctx.forgeDir, 'FORGE-1', ctx.attemptId), { force: true });

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must NOT run against a canonical fallback when the manifest is absent');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'STALE_ATTEMPT');
    const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188 (3rd-pass): manifest present but {} → SCHEMA_INVALID at the phase-binding gate', async (t) => {
  const { manifestFilePath } = await import('../../../../src/orchestrator/questions/paths.ts');
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeSettingsWithVerify(ctx.forgeDir, ['npm test']);
  writeWorktreeMarker(worktreePath, 'FORGE-1');
  const canonical = join(ctx.forgeDir, 'worktrees', 'FORGE-1');
  writeWorktreeMarker(canonical, 'FORGE-1');
  writeFileSync(manifestFilePath(ctx.forgeDir, 'FORGE-1', ctx.attemptId), '{}', 'utf8');

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };
  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must NOT run against a canonical fallback when worktree_path is missing');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  // FORGE-231: a shape-invalid manifest dies at the phase-binding gate.
  assert.equal(env.error.code, 'SCHEMA_INVALID');
  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-188 (F4): invalid settings.yaml (schema fail, non-FILE_NOT_FOUND SettingsError) → clean fail before writes', async (t) => {
  const stdout = captureStdout(t);
  const worktreePath = mkdtempSync(join(tmpdir(), 'forge-wt-'));
  const ctx = await setupRunning(stdout, { worktreePath });
  writeWorktreeMarker(worktreePath, 'FORGE-1');
  // settings.yaml exists but fails schema validation (missing required fields /
  // bad shape) → a SettingsError that is NOT FILE_NOT_FOUND. Must fail cleanly,
  // never silently self-attest, and never write.
  mkdirSync(ctx.forgeDir, { recursive: true });
  writeFileSync(join(ctx.forgeDir, 'settings.yaml'), 'version: 1\nproject: not-an-object\n', 'utf8');

  let invoked = false;
  const run: RunCommand = async () => {
    invoked = true;
    return { exitCode: 0 };
  };

  const verdictFile = writeVerdict(ctx.repoRoot, 'ready_for_review');
  const result = await runOrchestrateComplete(
    { taskId: 'FORGE-1', attemptId: ctx.attemptId, verdictFile, phase: 'implement', forgeDir: ctx.forgeDir, json: true },
    { run },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(invoked, false, 'verify must not run when settings are unreadable');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.notEqual(env.error.code, 'FILE_NOT_FOUND');

  const dir = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  assert.equal(existsSync(join(dir, 'verdict.json')), false);
  assert.equal(existsSync(join(dir, 'verdict.verified.json')), false);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-231: completion refuses when the lease is not the identity the attempt was dispatched under (impl R2 CRIT-1)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Simulate the steal crash window: the successor published a new-generation
  // lease but the state reset never landed — current_attempt_id still points
  // at the stale attempt.
  const leasePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json');
  const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  writeFileSync(
    leasePath,
    JSON.stringify({
      ...lease,
      claim_id: 'successor-claim',
      owner_run_id: 'successor-run',
      generation: lease.generation + 1,
      lease_version: (lease.lease_version ?? 1) + 1,
    }),
    'utf8',
  );

  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'ready_for_review'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'LEASE_STOLEN');
  assert.match(env.error.message, /never complete under a successor/);
  // Nothing advanced.
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running');
});

test('FORGE-231: exhaustion-fatal replay repairs a lost notification (impl R2 MAJ-4)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const statePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  const cur = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...cur, failure_count: 9, state_version: cur.state_version + 1 }), 'utf8');

  let result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const lease = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json'), 'utf8'));
  const runId = lease.owner_run_id ?? lease.released_by?.run_id;
  const notifPath = join(ctx.forgeDir, 'orchestrator/runs', runId, 'notifications.jsonl');
  // Simulate the crash window: the fatal append was lost after the state CAS.
  writeFileSync(notifPath, '', 'utf8');

  stdout.length = 0;
  result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.replayed, true);
  const events = readFileSync(notifPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fatal = events.find((e) => e.type === 'fatal');
  assert.ok(fatal, 'replay must repair the lost fatal notification');
  assert.equal(fatal.id, `FORGE-1:${ctx.attemptId}:implement:fatal`);
});

test('FORGE-231: MANIFESTLESS attempts are refused outright — no event-log fallback (impl R4 CRIT-1)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Remove the manifest (legacy pre-FORGE-231 shape). The attempt_started
  // event EXISTS — but events are worker-writable and rotatable, so they are
  // never an authorization record: the completion must refuse regardless.
  const manifestPath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId, 'manifest.json');
  unlinkSync(manifestPath);

  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'STALE_ATTEMPT');
  assert.match(env.error.message, /re-dispatch/);
  const state = JSON.parse(readFileSync(join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json'), 'utf8'));
  assert.equal(state.state, 'running', 'nothing may advance without a verifiable dispatch identity');
});
test('FORGE-231: manifestless refusal holds with the event log deleted too (fail closed)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const attemptDirPath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/attempts', ctx.attemptId);
  unlinkSync(join(attemptDirPath, 'manifest.json'));
  try {
    unlinkSync(join(attemptDirPath, 'events.jsonl'));
  } catch {
    // may not exist — the refusal must hold either way
  }
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'ready_for_review'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'STALE_ATTEMPT');
});
test('FORGE-231: fatal repair works even after the lease is TOMBSTONED (impl R3 MAJ-2)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  const statePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  const cur = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...cur, failure_count: 9, state_version: cur.state_version + 1 }), 'utf8');
  let result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);

  // gc released the terminal task's lease (tombstone) AND the fatal was lost.
  const leasePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/lease.json');
  const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  const runId = lease.owner_run_id;
  writeFileSync(
    leasePath,
    JSON.stringify({
      version: 1,
      status: 'released',
      task_id: 'FORGE-1',
      lease_version: (lease.lease_version ?? 1) + 1,
      last_generation: lease.generation,
      released_at: new Date().toISOString(),
      released_by: { run_id: runId, claim_id: lease.claim_id, generation: lease.generation },
    }),
    'utf8',
  );
  const notifPath = join(ctx.forgeDir, 'orchestrator/runs', runId, 'notifications.jsonl');
  writeFileSync(notifPath, '', 'utf8');

  stdout.length = 0;
  result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'changes_needed'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0, 'terminal replay must succeed WITHOUT an active lease');
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.replayed, true);
  const events = readFileSync(notifPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.find((e) => e.type === 'fatal'), 'fatal repaired without a lease');
});

test('FORGE-231: a concurrent state change returns a typed envelope, never an unhandled throw (impl R6)', async (t) => {
  const stdout = captureStdout(t);
  const ctx = await setupRunning(stdout);
  // Supervisor cancelled the task between dispatch and this completion: the
  // state is now terminal, so the implement transition is illegal.
  const statePath = join(ctx.forgeDir, 'orchestrator/tasks/FORGE-1/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(
    statePath,
    JSON.stringify({ ...state, state: 'cancelled', state_version: state.state_version + 1 }),
    'utf8',
  );

  // Must RESOLVE with a typed failure envelope, not reject.
  const result = await runOrchestrateComplete({
    taskId: 'FORGE-1',
    attemptId: ctx.attemptId,
    verdictFile: writeVerdict(ctx.repoRoot, 'ready_for_review'),
    phase: 'implement',
    forgeDir: ctx.forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  // A concurrent terminal state trips the current-attempt guard first (also a
  // typed refusal) or the transition guard — either way, NEVER an unhandled throw.
  assert.ok(['STALE_ATTEMPT', 'INVALID_STATE_FOR_PHASE'].includes(env.error.code), `unexpected code ${env.error.code}`);
});
