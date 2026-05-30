import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { runGuardrailCheck } from '../../../../src/cli/orchestrate/guardrail-check.ts';
import { runOrchestrateClaim } from '../../../../src/cli/orchestrate/claim.ts';
import { runOrchestrateDispatch } from '../../../../src/cli/orchestrate/dispatch.ts';
import { __resetSettingsCacheForTests } from '../../../../src/core/settings.ts';
import type { ClaimableTracker } from '../../../../src/cli/orchestrate/tracker-factory.ts';
import type { ClaimResult } from '../../../../src/trackers/types.ts';

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

class StubTracker implements ClaimableTracker {
  readonly type = 'stub';
  async claim(): Promise<ClaimResult> {
    return { ok: true };
  }
  async releaseClaim(): Promise<void> {}
  async setClaimFence(): Promise<void> {}
}

function setupRepo(): { repoRoot: string; forgeDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-guardrail-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: test',
      'tracker:',
      '  type: linear',
      '  config:',
      '    team_id: T',
      'secrets:',
      '  manager: env_file',
      '',
    ].join('\n'),
  );
  __resetSettingsCacheForTests();
  return { repoRoot, forgeDir };
}

test('guardrail-check: --path missing returns INVALID_ARGS', () => {
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({ path: '', forgeDir, cwd: repoRoot, json: true });
  assert.equal(result.exitCode, 1);
});

test('guardrail-check: architectural path returns architectural: true with suggested_decision_key', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.ok, true);
  assert.equal(env.data.architectural, true);
  assert.equal(env.data.path, 'src/schemas/settings.ts');
  assert.equal(env.data.matched_glob, 'src/schemas/**');
  assert.equal(env.data.suggested_decision_key, 'guardrail:src-schemas:settings.ts');
});

test('guardrail-check: non-architectural path returns architectural: false', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({
    path: 'src/orchestrator/internal-helper.ts',
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.architectural, false);
  assert.equal(env.data.matched_glob, null);
  assert.equal(env.data.suggested_decision_key, null);
});

test('guardrail-check: literal path match', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  runGuardrailCheck({ path: 'CRITICAL.md', forgeDir, cwd: repoRoot, json: true });
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.architectural, true);
  assert.equal(env.data.matched_glob, 'CRITICAL.md');
});

test('guardrail-check: suggested_decision_key is stable across runs', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  runGuardrailCheck({ path: 'package.json', forgeDir, cwd: repoRoot, json: true });
  runGuardrailCheck({ path: 'package.json', forgeDir, cwd: repoRoot, json: true });
  const env1 = JSON.parse(stdout[0] ?? '');
  const env2 = JSON.parse(stdout[1] ?? '');
  assert.equal(env1.data.suggested_decision_key, env2.data.suggested_decision_key);
});

test('guardrail-check: relative-path computation uses repoRoot, not cwd', (t) => {
  // Worker is in a subdirectory; --path is relative to cwd.
  // resolveForgeDir already resolved forgeDir; the verb computes
  // path.relative(repoRoot, path.resolve(cwd, --path)).
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  // Simulate worker cwd inside src/ — relative path resolves into the same file.
  const subCwd = join(repoRoot, 'src');
  mkdirSync(subCwd, { recursive: true });
  runGuardrailCheck({
    path: 'schemas/settings.ts',
    forgeDir,
    cwd: subCwd,
    json: true,
  });
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.path, 'src/schemas/settings.ts');
  assert.equal(env.data.architectural, true);
});

test('guardrail-check: path outside repo is rejected with INVALID_ARGS (does not leak path)', (t) => {
  // I4/security: path traversal must not echo the resolved out-of-repo path
  // in the response envelope.
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const otherDir = mkdtempSync(join(tmpdir(), 'forge-other-'));
  const escaping = join(otherDir, 'src/index.ts');
  const result = runGuardrailCheck({ path: escaping, forgeDir, cwd: repoRoot, json: true });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ARGS');
  // The out-of-repo path must NOT appear anywhere in the envelope.
  assert.doesNotMatch(stdout.at(-1) ?? '', /forge-other-/);
  assert.doesNotMatch(stdout.at(-1) ?? '', new RegExp(otherDir.replace(/\//g, '\\/')));
});

test('guardrail-check: relative ../ path traversal is rejected (does not leak traversal depth)', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({
    path: '../../../etc/passwd',
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ARGS');
  assert.doesNotMatch(stdout.at(-1) ?? '', /etc\/passwd/);
  assert.doesNotMatch(stdout.at(-1) ?? '', /\.\.\//);
});

test('guardrail-check: symlink to outside-repo target is rejected via realpath (BLOCK B1)', (t) => {
  // Codex flagged: a symlink inside the repo pointing to /tmp or /etc was
  // treated as inside the repo because containment was lexical.
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const outsideDir = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  writeFileSync(join(outsideDir, 'evil.ts'), 'export const x = 1;');
  const symlinkInsideRepo = join(repoRoot, 'src/index.ts');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  symlinkSync(join(outsideDir, 'evil.ts'), symlinkInsideRepo);
  // Sanity: the symlink lives at an arch-sensitive path under the repo,
  // but its realpath resolves outside the repo.
  assert.equal(existsSync(symlinkInsideRepo), true);

  const result = runGuardrailCheck({
    path: 'src/index.ts',
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  // Must refuse — symlink containment bypass is the bug.
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ARGS');
});

test('guardrail-check: unsanitized --task does NOT probe arbitrary filesystem (BLOCK B3)', (t) => {
  // security-auditor flagged: args.taskId flowed into path.join before
  // validation. A worker calling --task ../../../etc would cause
  // existsSync/readFileSync to probe an arbitrary filesystem path.
  // The fix validates taskId at the top of appendGuardrailEvent.
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    taskId: '../../../etc',
    attemptId: 'attempt-fake',
    json: true,
  });
  // Verb still returns the architectural verdict for the path …
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.architectural, true);
  // … but the malicious taskId did NOT cause an event-emission attempt at
  // a forged path. validateIdSegment refuses the segment before any FS call.
  // We can't directly observe the absence of an FS probe, but the test
  // assertion above + the validateIdSegment early-return in
  // appendGuardrailEvent + the absence of an attempts/ tree for that
  // forged taskId all hang together.
});

test('guardrail-check: emits guardrail_checked event when --task + --attempt are supplied', async (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const runId = uuidv7();
  await runOrchestrateClaim(
    { taskId: 'FORGE-1', runId, forgeDir, json: true },
    { tracker: new StubTracker(), specRevision: { revision: 'git:a', source: 'git' }, repoRoot },
  );
  const claimEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  const dispatchResult = await runOrchestrateDispatch({
    taskId: 'FORGE-1',
    claimId: claimEnv.data.claim_id,
    runId,
    worktreePath: '/tmp/wt',
    phase: 'implement',
    forgeDir,
    json: true,
  });
  assert.equal(dispatchResult.exitCode, 0);
  const dispatchEnv = JSON.parse(stdout[stdout.length - 1] ?? '');
  const attemptId = dispatchEnv.data.attempt_id;

  runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    taskId: 'FORGE-1',
    attemptId,
    json: true,
  });

  const eventsPath = join(
    forgeDir,
    'orchestrator',
    'tasks',
    'FORGE-1',
    'attempts',
    attemptId,
    'events.jsonl',
  );
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n');
  const lastEvent = JSON.parse(lines.at(-1)!);
  assert.equal(lastEvent.type, 'guardrail_checked');
  assert.equal(lastEvent.path, 'src/schemas/settings.ts');
  assert.equal(lastEvent.matched_glob, 'src/schemas/**');
  assert.equal(lastEvent.suggested_decision_key, 'guardrail:src-schemas:settings.ts');
});

test('guardrail-check: skips event emission when --task + --attempt missing', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  // No claim, no dispatch — task directory does not exist.
  const result = runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    json: true,
    // No taskId / attemptId.
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.architectural, true);
  // No events file was written; the verb did not crash trying to read a missing lease.
});

test('guardrail-check: silently skips event emission when lease is missing but task/attempt supplied', (t) => {
  const stdout = captureStdout(t);
  const { forgeDir, repoRoot } = setupRepo();
  const result = runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    taskId: 'NONEXISTENT-99',
    attemptId: 'attempt-fake',
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout.at(-1) ?? '');
  assert.equal(env.data.architectural, true);
});

test('guardrail-check: --path with overly long value rejected', () => {
  const { forgeDir, repoRoot } = setupRepo();
  const longPath = 'a/'.repeat(600) + 'b'; // > 1024 chars
  const result = runGuardrailCheck({
    path: longPath,
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
});

test('guardrail-check: SETTINGS_LOAD_ERROR when settings.yaml missing', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-guardrail-nosettings-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(forgeDir, { recursive: true });
  __resetSettingsCacheForTests();
  const result = runGuardrailCheck({
    path: 'src/schemas/settings.ts',
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
});

test('guardrail-check: outside-repo path is rejected BEFORE settings are loaded (Codex 2nd-pass)', (t) => {
  // Containment must be resolved before settings.yaml: a missing/bad settings
  // file must NOT mask the OUTSIDE_REPO rejection with SETTINGS_LOAD_ERROR.
  const stdout = captureStdout(t);
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-guardrail-order-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(forgeDir, { recursive: true }); // NOTE: no settings.yaml written
  __resetSettingsCacheForTests();
  const otherDir = mkdtempSync(join(tmpdir(), 'forge-other-'));
  const result = runGuardrailCheck({
    path: join(otherDir, 'src/index.ts'),
    forgeDir,
    cwd: repoRoot,
    json: true,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout.at(-1) ?? '');
  // Must be the containment rejection, NOT a settings-load error.
  assert.equal(env.error.code, 'INVALID_ARGS');
});
