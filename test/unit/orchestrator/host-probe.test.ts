import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_CLI_BIN,
  probeBinVersion,
} from '../../../src/orchestrator/host-probe.ts';
import type { ExecaLike } from '../../../src/cli/init/validate.ts';

test('HOST_CLI_BIN maps cursor → agent and others to their own name', () => {
  assert.equal(HOST_CLI_BIN.claude, 'claude');
  assert.equal(HOST_CLI_BIN.codex, 'codex');
  assert.equal(HOST_CLI_BIN.gemini, 'gemini');
  assert.equal(HOST_CLI_BIN.cursor, 'agent');
});

test('probeBinVersion → true on exitCode 0', async () => {
  const exec = (async () => ({ exitCode: 0, stdout: 'x 1.0', stderr: '' })) as unknown as ExecaLike;
  assert.equal(await probeBinVersion('x', exec, 100), true);
});

test('probeBinVersion → false on ENOENT (exitCode undefined)', async () => {
  const exec = (async () => ({
    exitCode: undefined,
    stdout: '',
    stderr: '',
    code: 'ENOENT',
  })) as unknown as ExecaLike;
  assert.equal(await probeBinVersion('x', exec, 100), false);
});

test('probeBinVersion → false on timeout', async () => {
  const exec = (async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })) as unknown as ExecaLike;
  assert.equal(await probeBinVersion('x', exec, 100), false);
});

test('probeBinVersion → false on non-zero exit', async () => {
  const exec = (async () => ({ exitCode: 1, stdout: '', stderr: 'bad' })) as unknown as ExecaLike;
  assert.equal(await probeBinVersion('x', exec, 100), false);
});

test('probeBinVersion → false when exec throws', async () => {
  const exec = (async () => {
    throw new Error('boom');
  }) as unknown as ExecaLike;
  assert.equal(await probeBinVersion('x', exec, 100), false);
});

test('probeBinVersion calls <bin> --version with stdin:ignore and a timeout', async () => {
  let seen: { cmd: string; args: readonly string[]; opts: Record<string, unknown> } | undefined;
  const exec = (async (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    seen = { cmd, args, opts };
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as unknown as ExecaLike;
  await probeBinVersion('codex', exec, 250);
  assert.equal(seen?.cmd, 'codex');
  assert.deepEqual(seen?.args, ['--version']);
  assert.equal(seen?.opts.timeout, 250);
  assert.equal(seen?.opts.reject, false);
  assert.equal(seen?.opts.stdin, 'ignore');
});
