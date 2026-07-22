import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRepoHost } from '../../../src/repo-hosts/index.ts';
import { OrchestratorError } from '../../../src/core/errors.ts';

const SHA = 'a'.repeat(40);
const PR = { repo: 'o/r', number: 1, url: 'https://example.test/1' };

test('FakeRepoHost: scripted results validate through the shared schemas and are call-logged', async () => {
  const host = new FakeRepoHost({
    base: { repo: 'o/r', branch: 'main', push_remote: 'origin' },
    probe: {
      ok: true,
      blocking_check_count: 3,
      squash_allowed: true,
      write_permission: true,
      bypass_rules_present: false,
      merge_queue_enabled: false,
    },
    pullRequest: PR,
    checks: { status: 'green' },
    mergeAttempt: { ok: true, merge_commit_sha: SHA },
    mergeResult: { merged: true, base_ref: 'main', merge_commit_sha: SHA, merged_head_sha: SHA },
    headSha: { ok: true, sha: SHA },
  });

  assert.equal((await host.resolveBase()).branch, 'main');
  assert.equal((await host.probe()).ok, true);
  assert.equal((await host.createOrGetPullRequest('feat/x', 'main')).number, 1);
  assert.equal((await host.requiredChecksGreen(PR)).status, 'green');
  assert.equal((await host.mergeAtomic(PR, SHA)).ok, true);
  assert.equal((await host.mergeResult(PR)).merged, true);
  assert.equal((await host.headSha(PR)).ok, true);
  assert.deepEqual(
    host.calls.map((c) => c.op),
    ['resolveBase', 'probe', 'createOrGetPullRequest', 'requiredChecksGreen', 'mergeAtomic', 'mergeResult', 'headSha'],
  );
});

test('FakeRepoHost: a scripted result with an invalid SHA is rejected at the boundary', async () => {
  const host = new FakeRepoHost({ headSha: { ok: true, sha: 'ABC123' } });
  await assert.rejects(
    () => host.headSha(PR),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'SCHEMA_INVALID',
  );
});

test('FakeRepoHost: an unscripted operation fails typed (never a silent default)', async () => {
  const host = new FakeRepoHost({});
  await assert.rejects(
    () => host.probe(),
    (err: unknown) => err instanceof OrchestratorError && err.code === 'IO_ERROR',
  );
});
