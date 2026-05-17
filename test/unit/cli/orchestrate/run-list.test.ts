import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateRunStart } from '../../../../src/cli/orchestrate/run-start.ts';
import { runOrchestrateRunList } from '../../../../src/cli/orchestrate/run-list.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-run-list-'));
}

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

test('run list returns empty when runs dir does not exist', async (t) => {
  const stdout = captureStdout(t);
  const forgeDir = join(tmp(), '.forge');
  const result = await runOrchestrateRunList({ forgeDir, json: true, active: false });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.deepEqual(env.data.runs, []);
});

test('run list returns runs after run start, sorted most-recent first', async (t) => {
  const stdout = captureStdout(t);
  const forgeDir = join(tmp(), '.forge');
  await runOrchestrateRunStart({ forgeDir, json: false, name: 'one' });
  // Tiny gap to ensure started_at ordering is stable.
  await new Promise((r) => setTimeout(r, 5));
  await runOrchestrateRunStart({ forgeDir, json: false, name: 'two' });
  stdout.length = 0;
  const result = await runOrchestrateRunList({ forgeDir, json: true, active: false });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.runs.length, 2);
  assert.equal(env.data.runs[0].name, 'two');
  assert.equal(env.data.runs[1].name, 'one');
});

test('run list --active filters out runs with no notifications', async (t) => {
  const stdout = captureStdout(t);
  const forgeDir = join(tmp(), '.forge');
  await runOrchestrateRunStart({ forgeDir, json: false });
  stdout.length = 0;
  const result = await runOrchestrateRunList({ forgeDir, json: true, active: true });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.data.runs.length, 0);
});
