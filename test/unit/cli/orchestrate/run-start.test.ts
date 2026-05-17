import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateRunStart } from '../../../../src/cli/orchestrate/run-start.ts';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'forge-run-start-'));
}

test('run start creates a fresh run dir, manifest, and notifications file', async (t) => {
  const stdout: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = origWrite;
  });

  const dir = tmp();
  const forgeDir = join(dir, '.forge');
  const result = await runOrchestrateRunStart({ forgeDir, json: true });
  assert.equal(result.exitCode, 0);

  const last = stdout[stdout.length - 1] ?? '';
  const env = JSON.parse(last);
  assert.equal(env.ok, true);
  assert.match(env.data.run_id, UUIDV7_RE);
  assert.ok(existsSync(env.data.manifest_path));

  const manifest = JSON.parse(readFileSync(env.data.manifest_path, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.run_id, env.data.run_id);
  assert.match(manifest.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(manifest.name, null);

  // notifications.jsonl exists (empty).
  const notif = join(forgeDir, 'orchestrator', 'runs', env.data.run_id, 'notifications.jsonl');
  assert.ok(existsSync(notif));
});

test('run start accepts --name and persists it in the manifest', async (t) => {
  const stdout: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = origWrite;
  });

  const forgeDir = join(tmp(), '.forge');
  const result = await runOrchestrateRunStart({ forgeDir, json: true, name: 'morning-session' });
  assert.equal(result.exitCode, 0);

  const last = stdout[stdout.length - 1] ?? '';
  const env = JSON.parse(last);
  const manifest = JSON.parse(readFileSync(env.data.manifest_path, 'utf8'));
  assert.equal(manifest.name, 'morning-session');
});

test('run start: --name longer than 128 fails INVALID_ARGS', async (t) => {
  const stderr: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = origWrite;
  });

  const forgeDir = join(tmp(), '.forge');
  const long = 'x'.repeat(200);
  const result = await runOrchestrateRunStart({ forgeDir, json: false, name: long });
  assert.equal(result.exitCode, 1);
});
