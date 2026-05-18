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

// /review H1: AI subprocesses must NOT inherit parent secrets.
test('spawnSubprocess strips sensitive env vars when opts.env is undefined', async () => {
  const prior = process.env.FORGE_FAKE_SECRET;
  process.env.FORGE_FAKE_SECRET = 'should-not-leak';
  try {
    const result = await spawnSubprocess(
      NODE,
      [
        '-e',
        'process.stdout.write(process.env.FORGE_FAKE_SECRET ? "leaked" : "safe")',
      ],
      { cwd: tmpdir(), host: HOST },
    );
    assert.equal(result.stdout, 'safe');
  } finally {
    if (prior === undefined) delete process.env.FORGE_FAKE_SECRET;
    else process.env.FORGE_FAKE_SECRET = prior;
  }
});

test('spawnSubprocess keeps PATH/HOME in the safe baseline', async () => {
  const result = await spawnSubprocess(
    NODE,
    [
      '-e',
      'process.stdout.write([process.env.HOME ? "h" : "", process.env.PATH ? "p" : ""].join(""))',
    ],
    { cwd: tmpdir(), host: HOST },
  );
  assert.equal(result.stdout, 'hp');
});

// /review I2: cwd must be absolute.
test('spawnSubprocess rejects a relative cwd with actionable error', async () => {
  await assert.rejects(
    () =>
      spawnSubprocess(NODE, ['--version'], {
        cwd: './relative',
        host: HOST,
      }),
    (err: unknown) =>
      isHarnessError(err) &&
      err.code === 'SPAWN_FAILED' &&
      /cwd must be an absolute path/.test(err.message),
  );
});

// FORGE-135: child stdin must be /dev/null (immediate EOF), not an open pipe.
// codex-cli 0.130.0 (and some gemini versions) reads stdin before processing
// the prompt argument; an inherited open pipe causes an indefinite 0% CPU hang.
// We assert the *behaviour* (child sees EOF on stdin) rather than the execa
// option name, so the test survives any future refactor of how we close stdin.
test('spawnSubprocess hands the child an already-closed stdin (immediate EOF)', async () => {
  const result = await spawnSubprocess(
    NODE,
    [
      '-e',
      'let n=0;process.stdin.on("data",c=>n+=c.length).on("end",()=>process.stdout.write(`eof:${n}`))',
    ],
    { cwd: tmpdir(), host: HOST, timeoutMs: 5_000 },
  );
  assert.equal(result.stdout, 'eof:0');
  assert.equal(result.exitCode, 0);
});

// /review I3: HarnessError.details holds an excerpt of the last arg, not the full
// rendered prompt — prevents leaking subprocess context to PR descriptions / logs.
test('spawnSubprocess truncates args_excerpt at 200 bytes on failure', async () => {
  const longPrompt = 'A'.repeat(5000);
  await assert.rejects(
    () =>
      spawnSubprocess(
        NODE,
        ['-e', `console.log(${JSON.stringify(longPrompt)}); process.exit(2)`],
        { cwd: tmpdir(), host: HOST },
      ),
    (err: unknown) => {
      if (!isHarnessError(err) || err.code !== 'NON_ZERO_EXIT') return false;
      const excerpt = err.details.args_excerpt;
      return typeof excerpt === 'string' && excerpt.length <= 200;
    },
  );
});
