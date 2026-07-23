// FORGE-233: createDependencyObserver + forObservation — persisted-record-only
// construction; the observation path must NEVER touch git or acquire write
// authority.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDependencyObserver } from '../../../src/repo-hosts/detect.ts';
import {
  HOLDER,
  REPO,
  SHA_A,
  TASK,
  forgeDirWithRecord,
  graphqlObservation,
  graphqlRoute,
  scriptedExec,
  tempForgeDir,
} from './helpers.ts';
import { upsertBaseResolution } from '../../../src/orchestrator/ship-record.ts';

const SHA_M = 'd'.repeat(40);

function recordedForgeDir(): string {
  const fd = forgeDirWithRecord();
  upsertBaseResolution(fd, TASK, {
    base: { repo: REPO, branch: 'main', push_remote: 'origin' },
    expectedReviewAttemptId: 'attempt-r1',
    expectedReviewedHeadSha: SHA_A,
    holder: HOLDER,
  });
  return fd;
}

test('observer constructed from the persisted record probes via gh ONLY (no git, no worktree)', async () => {
  const fd = recordedForgeDir();
  // Persist a pr into the record so the observer has an identity.
  const { readShipRecord } = await import('../../../src/orchestrator/ship-record.ts');
  const { writeFileSync } = await import('node:fs');
  const { shipRecordFilePath } = await import('../../../src/orchestrator/questions/paths.ts');
  const record = readShipRecord(fd, TASK)!;
  writeFileSync(
    shipRecordFilePath(fd, TASK),
    JSON.stringify({
      ...record,
      revision: record.revision + 1,
      pr: { repo: REPO, number: 9, url: `https://github.com/${REPO}/pull/9` },
    }),
    'utf8',
  );

  const gh = scriptedExec([
    graphqlRoute(() =>
      graphqlObservation({ state: 'MERGED', mergedAt: '2026-07-23T00:00:00Z', headRefOid: SHA_A, mergeCommit: { oid: SHA_M } }),
    ),
  ]);
  const observer = await createDependencyObserver(fd, TASK, gh);
  assert.ok(observer !== null);
  const result = await observer!.mergeResult({ repo: REPO, number: 9, url: `https://github.com/${REPO}/pull/9` });
  assert.equal(result.merged, true);
  if (result.merged) assert.equal(result.merged_head_sha, SHA_A);
  assert.ok(gh.calls.every((c) => c[0] === 'api' && c[1] === 'graphql'), 'gh-only observation');
});

test('no record / no pr / unreadable record → null (gate maps to its taxonomy)', async () => {
  const gh = scriptedExec([]);
  assert.equal(await createDependencyObserver(tempForgeDir(), 'NO-TASK', gh), null);
  assert.equal(await createDependencyObserver(recordedForgeDir(), TASK, gh), null, 'record without pr → null');
  const fd = forgeDirWithRecord();
  const { writeFileSync } = await import('node:fs');
  const { shipRecordFilePath } = await import('../../../src/orchestrator/questions/paths.ts');
  writeFileSync(shipRecordFilePath(fd, TASK), 'corrupt{', 'utf8');
  assert.equal(await createDependencyObserver(fd, TASK, gh), null);
  assert.equal(gh.calls.length, 0, 'no gh calls without a usable identity');
});
