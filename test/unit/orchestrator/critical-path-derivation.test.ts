import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execaSync } from 'execa';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeTrustedReviewOutcome,
  deriveCriticalPath,
} from '../../../src/orchestrator/review-compose.ts';
import { OrchestratorError } from '../../../src/core/errors.ts';

// Real-git fixtures: deriveCriticalPath's contract is about revision-pinned
// content, so these tests exercise actual git plumbing.

let repo: string;

function git(...args: string[]): string {
  const r = execaSync('git', args, { cwd: repo, env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } });
  return String(r.stdout ?? '').trim();
}

function commitAll(msg: string): string {
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg, '--allow-empty');
  return git('rev-parse', 'HEAD');
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'forge-critpath-'));
  git('init', '-q');
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test('deriveCriticalPath: glob match on an unchanged policy classifies critical', async () => {
  writeFileSync(join(repo, 'CRITICAL.md'), '# critical\n- `src/core/**`\n');
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'src', 'core', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'docs', 'y.md'), 'docs\n');
  const base = commitAll('base');

  writeFileSync(join(repo, 'src', 'core', 'x.ts'), 'export const x = 2;\n');
  const target = commitAll('touch core');

  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, true);
  assert.equal(d.reason, 'glob_match');
});

test('deriveCriticalPath: non-matching change is not critical', async () => {
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'docs', 'y.md'), 'docs v2\n');
  const target = commitAll('touch docs');
  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, false);
  assert.equal(d.reason, 'none');
});

test('deriveCriticalPath: editing CRITICAL.md itself is intrinsically critical', async () => {
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'CRITICAL.md'), '# critical\n- `other/**`\n');
  const target = commitAll('weaken policy');
  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, true);
  assert.equal(d.reason, 'policy_file_changed');
});

test('deriveCriticalPath: RENAMING the policy file away cannot dodge the gate (R8 CRIT-2 regression)', async () => {
  const base = git('rev-parse', 'HEAD');
  // `git mv CRITICAL.md POLICY.md` + weaken: with rename detection the diff
  // would list only POLICY.md; --no-renames + the presence probe catch it.
  renameSync(join(repo, 'CRITICAL.md'), join(repo, 'POLICY.md'));
  writeFileSync(join(repo, 'POLICY.md'), '# nothing critical here\n');
  const target = commitAll('rename policy away');
  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, true);
  assert.equal(d.reason, 'policy_file_changed');
});

test('deriveCriticalPath: rename-plus-replacement (weakened CRITICAL.md reappears) is critical', async () => {
  const base = git('rev-parse', 'HEAD');
  // Bring back a CRITICAL.md whose blob differs from the base end.
  writeFileSync(join(repo, 'CRITICAL.md'), '# empty policy\n');
  const target = commitAll('replace policy with weak one');
  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, true);
  assert.equal(d.reason, 'policy_file_changed');
});

test('deriveCriticalPath: verified absence at BOTH endpoints is not critical and not an error', async () => {
  unlinkSync(join(repo, 'CRITICAL.md'));
  unlinkSync(join(repo, 'POLICY.md'));
  const base = commitAll('no policy at all');
  writeFileSync(join(repo, 'docs', 'y.md'), 'docs v3\n');
  const target = commitAll('touch docs again');
  const d = await deriveCriticalPath(repo, base, target);
  assert.equal(d.critical, false);
});

test('deriveCriticalPath: fail-closed — a bad revision throws instead of reading as non-critical', async () => {
  const good = git('rev-parse', 'HEAD');
  await assert.rejects(
    () => deriveCriticalPath(repo, 'f'.repeat(40), good),
    (err: unknown) => err instanceof OrchestratorError,
  );
});

test('deriveCriticalPath: non-40-hex endpoints are rejected', async () => {
  const good = git('rev-parse', 'HEAD');
  await assert.rejects(
    () => deriveCriticalPath(repo, 'main', good),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'INVALID_ID',
  );
});

// ---- composeTrustedReviewOutcome ----

const SHA = 'a'.repeat(40);
const PASS_REVIEW = { version: 1, verdict: 'pass', findings: [], host: 'codex' };

test('gateway: pinned mode rejects an unpinned primary', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: PASS_REVIEW,
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: false },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: false,
  });
  assert.equal(outcome.kind, 'invalid');
});

test('gateway: host provenance mismatch is invalid', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    expectedPrimaryHost: 'gemini',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: false },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: false,
  });
  assert.equal(outcome.kind, 'invalid');
});

test('gateway: same-host second opinion is invalid (dual lineage)', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    secondOpinionRaw: { ...PASS_REVIEW },
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: false },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: true,
  });
  assert.equal(outcome.kind, 'invalid');
});

test('gateway: second opinion pinned to a DIFFERENT commit is invalid', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    secondOpinionRaw: { ...PASS_REVIEW, host: 'claude', target_sha: 'b'.repeat(40) },
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: false },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: true,
  });
  assert.equal(outcome.kind, 'invalid');
});

test('gateway: the criticality flag is strictly tightening — forces the second-opinion requirement', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: true },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: true,
  });
  assert.equal(outcome.kind, 'park');
});

test('gateway: clean dual-host pinned pass composes ready_for_review', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    secondOpinionRaw: { ...PASS_REVIEW, host: 'claude', target_sha: SHA },
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: true },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: true,
  });
  assert.equal(outcome.kind, 'verdict');
  if (outcome.kind === 'verdict' && outcome.result.kind === 'verdict') {
    assert.equal(outcome.result.verdict.verdict, 'ready_for_review');
    assert.equal(outcome.hasCriticalPath, true);
  }
});

test('gateway: pinned mode rejects an UNPINNED second opinion (impl R1 CRIT-1 regression)', async () => {
  const outcome = await composeTrustedReviewOutcome({
    primaryRaw: { ...PASS_REVIEW, target_sha: SHA },
    // No target_sha — an old unrelated artifact must never satisfy the
    // critical-path second-opinion requirement.
    secondOpinionRaw: { ...PASS_REVIEW, host: 'claude' },
    expectedPrimaryHost: 'codex',
    expectedTargetSha: SHA,
    criticality: { derive: null, flag: true },
    branch: 'b',
    summary: 's',
    secondOpinionAvailable: true,
  });
  assert.equal(outcome.kind, 'invalid');
});
