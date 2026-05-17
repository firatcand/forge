import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateDoctor } from '../../../../src/cli/orchestrate/doctor.ts';

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

function makeRepoWithSpec(specBody: string, srcFiles: string[]): { repo: string; forgeDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'forge-doctor-'));
  mkdirSync(join(repo, 'spec'), { recursive: true });
  writeFileSync(join(repo, 'spec/SPEC.md'), specBody, 'utf8');
  if (srcFiles.length > 0) {
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (const rel of srcFiles) {
      const full = join(repo, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '// placeholder\n', 'utf8');
    }
  }
  return { repo, forgeDir: join(repo, '.forge') };
}

test('doctor --scope spec-code exits 0 on clean repo', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/cli/init.ts` and `src/orchestrator/leases.ts` for details.\n',
    ['src/cli/init.ts', 'src/orchestrator/leases.ts'],
  );
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 0);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true);
  assert.deepEqual(env.data.drift, []);
});

test('doctor --scope spec-code exits 2 when SPEC mentions a missing src path', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec(
    'See `src/cli/init.ts` and `src/orchestrator/leases.ts` for details.\n',
    ['src/cli/init.ts'], // leases.ts intentionally absent
  );
  const result = await runOrchestrateDoctor({
    scope: 'spec-code',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 2);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, true); // doctor reports drift via data, not error envelope
  assert.ok(env.data.drift.length > 0);
  assert.equal(env.data.drift[0].target, 'src/orchestrator/leases.ts');
});

test('doctor --scope adr-drafts is deferred to v0.5 and fails with SCOPE_NOT_IMPLEMENTED', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec('# spec\n', []);
  const result = await runOrchestrateDoctor({
    scope: 'adr-drafts',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'SCOPE_NOT_IMPLEMENTED');
});

test('doctor --scope apply-journal is deferred to v0.5 and fails with SCOPE_NOT_IMPLEMENTED', async (t) => {
  const stdout = captureStdout(t);
  const { repo, forgeDir } = makeRepoWithSpec('# spec\n', []);
  const result = await runOrchestrateDoctor({
    scope: 'apply-journal',
    forgeDir,
    json: true,
    repoRoot: repo,
  });
  assert.equal(result.exitCode, 1);
  const env = JSON.parse(stdout[stdout.length - 1] ?? '');
  assert.equal(env.error.code, 'SCOPE_NOT_IMPLEMENTED');
});
