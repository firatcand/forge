import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateDoctor } from '../../../../src/cli/orchestrate/doctor.ts';
import { HOSTS } from '../../../../src/schemas/hosts.ts';

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

function lastEnvelope(buf: string[]): { ok: boolean; data?: Record<string, unknown> } {
  return JSON.parse(buf[buf.length - 1] ?? '');
}

// `--scope hosts` is a NON-BLOCKING preflight: it ALWAYS exits 0 and reports an
// availability entry for every host. A gated/missing host is a reason, not drift.
test('doctor --scope hosts: exit 0 with a per-host availability report', async (t) => {
  const forgeDir = join(mkdtempSync(join(tmpdir(), 'forge-doctor-hosts-')), '.forge');
  const buf = captureStdout(t);

  const { exitCode } = await runOrchestrateDoctor({
    scope: 'hosts',
    forgeDir,
    json: true,
  });

  assert.equal(exitCode, 0);
  const env = lastEnvelope(buf);
  assert.equal(env.ok, true);
  assert.equal(env.data?.scope, 'hosts');
  const hosts = env.data?.hosts as Record<string, { available: boolean; reasons: string[] }>;
  assert.deepEqual(Object.keys(hosts).sort(), [...HOSTS].sort());
  for (const h of HOSTS) {
    assert.equal(typeof hosts[h]!.available, 'boolean');
    assert.ok(Array.isArray(hosts[h]!.reasons));
  }
});
