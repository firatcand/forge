import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { spawnSubprocess } from '../../../src/harnesses/subprocess.ts';
import { isHarnessError } from '../../../src/harnesses/base.ts';

const NODE = process.execPath;
const HOST = 'codex' as const;

test('spawnSubprocess returns stdout, stderr, and exit code on success', async () => {
  const result = await spawnSubprocess(
    NODE,
    ['-e', 'process.stdout.write("hi");process.stderr.write("warn")'],
    { cwd: tmpdir(), host: HOST },
  );
  assert.equal(result.stdout, 'hi');
  assert.equal(result.stderr, 'warn');
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
});

test('spawnSubprocess throws NON_ZERO_EXIT for failing process', async () => {
  await assert.rejects(
    () =>
      spawnSubprocess(
        NODE,
        ['-e', 'process.stderr.write("nope");process.exit(7)'],
        { cwd: tmpdir(), host: HOST },
      ),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'NON_ZERO_EXIT' &&
      err.details.exitCode === 7 &&
      typeof err.details.stderr_excerpt === 'string' &&
      err.details.stderr_excerpt.includes('nope'),
  );
});

test('spawnSubprocess throws BINARY_NOT_FOUND for missing binary', async () => {
  await assert.rejects(
    () =>
      spawnSubprocess('this-binary-does-not-exist-xyz123', [], {
        cwd: tmpdir(),
        host: HOST,
      }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'BINARY_NOT_FOUND' &&
      /not found on PATH/.test(err.message),
  );
});

test('spawnSubprocess throws TIMEOUT when process exceeds timeoutMs', async () => {
  await assert.rejects(
    () =>
      spawnSubprocess(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], {
        cwd: tmpdir(),
        host: HOST,
        timeoutMs: 100,
      }),
    (err: unknown) =>
      isHarnessError(err) && err.code === 'TIMEOUT',
  );
});

test('spawnSubprocess passes env additively', async () => {
  const result = await spawnSubprocess(
    NODE,
    ['-e', 'process.stdout.write(process.env.FORGE_TEST_VAR ?? "absent")'],
    {
      cwd: tmpdir(),
      host: HOST,
      env: { ...process.env, FORGE_TEST_VAR: 'present' } as Record<string, string>,
    },
  );
  assert.equal(result.stdout, 'present');
});
