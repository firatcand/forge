// FORGE-228 (Loom I4): the memory-backend factory + non-creating existence probe
// dispatch on `memory.backend`. The neon path is exercised here only at the
// dispatch/guard level (a missing NEON_DATABASE_URL fails loud) — the full neon
// behaviour is covered against PGlite in remote-backend.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backendExists, createBackend } from '../../../src/memory/factory.ts';

test('factory: local backend opens + status works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-factory-'));
  try {
    const backend = await createBackend({ backend: 'local' }, join(dir, 'loom.db'));
    const s = await backend.status();
    assert.equal(s.node_count, 0);
    await backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory: backendExists(local) is non-creating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loom-factory-'));
  try {
    const dbPath = join(dir, 'loom.db');
    // No file yet → false, and the probe must NOT create it.
    assert.equal(await backendExists({ backend: 'local' }, dbPath), false);
    // After opening (which creates the file) → true.
    const backend = await createBackend({ backend: 'local' }, dbPath);
    await backend.close();
    assert.equal(await backendExists({ backend: 'local' }, dbPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory: neon dispatch fails loud without NEON_DATABASE_URL', async () => {
  delete process.env.NEON_DATABASE_URL;
  await assert.rejects(createBackend({ backend: 'neon' }, ''), /NEON_DATABASE_URL/);
  await assert.rejects(backendExists({ backend: 'neon' }, ''), /NEON_DATABASE_URL/);
});
