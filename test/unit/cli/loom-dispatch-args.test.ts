// FORGE-227: dispatcher-level flag validation for the new loom verbs. These
// cases reject BEFORE touching the db, so no fixture/db is needed — they assert
// the strict value parsing (a flag-like value is not silently consumed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchLoom } from '../../../src/cli/loom/index.ts';

const cwd = process.cwd();

test('traverse without --node is INVALID_ARGS', async () => {
  const { exitCode } = await dispatchLoom(['traverse', '--json'], { cwd });
  assert.equal(exitCode, 1);
});

test('traverse --node with a flag-like value is rejected (not bound to --json)', async () => {
  const { exitCode } = await dispatchLoom(['traverse', '--node', '--json'], { cwd });
  assert.equal(exitCode, 1);
});

test('traverse --node=--json (equals form) with a flag-like value is rejected', async () => {
  const { exitCode } = await dispatchLoom(['traverse', '--node=--json'], { cwd });
  assert.equal(exitCode, 1);
});

test('traverse --depth with a non-integer is INVALID_ARGS', async () => {
  const { exitCode } = await dispatchLoom(['traverse', '--node', 'task:A', '--depth', 'x', '--json'], {
    cwd,
  });
  assert.equal(exitCode, 1);
});

test('query with no filter is INVALID_ARGS', async () => {
  const { exitCode } = await dispatchLoom(['query', '--json'], { cwd });
  assert.equal(exitCode, 1);
});

test('query --kind with an unknown kind is INVALID_ARGS', async () => {
  const { exitCode } = await dispatchLoom(['query', '--kind', 'bogus', '--json'], { cwd });
  assert.equal(exitCode, 1);
});

test('unknown loom verb is rejected', async () => {
  const { exitCode } = await dispatchLoom(['frobnicate', '--json'], { cwd });
  assert.equal(exitCode, 1);
});
