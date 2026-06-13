import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectTasksByState } from '../../../src/orchestrator/readiness.ts';

function forgeDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'forge-readiness-')), '.forge');
}

function writeState(fd: string, taskId: string, state: string, taskIdInPayload = taskId): void {
  const p = join(fd, 'orchestrator', 'tasks', taskId, 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      task_id: taskIdInPayload,
      state,
      state_version: 0,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'run-seed', claim_id: 'claim-seed', generation: 0 },
    }),
    'utf8',
  );
}

function writeRaw(fd: string, taskId: string, raw: string): void {
  const p = join(fd, 'orchestrator', 'tasks', taskId, 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, raw, 'utf8');
}

test('collectTasksByState: filters by predicate', () => {
  const fd = forgeDir();
  writeState(fd, 'P1-T1', 'ready_for_review');
  writeState(fd, 'P1-T2', 'running');
  writeState(fd, 'P1-T3', 'ready_for_review');
  const got = collectTasksByState(fd, (s) => s === 'ready_for_review');
  assert.deepEqual(got.map((g) => g.taskId).sort(), ['P1-T1', 'P1-T3']);
  // The full record is returned.
  assert.equal(got[0]!.record.state, 'ready_for_review');
  assert.equal(got[0]!.state, 'ready_for_review');
});

test('collectTasksByState: missing tasks dir → []', () => {
  const fd = forgeDir();
  assert.deepEqual(collectTasksByState(fd, () => true), []);
});

test('collectTasksByState: skips corrupt JSON and schema-invalid state.json', () => {
  const fd = forgeDir();
  writeState(fd, 'P1-T1', 'blocked_on_question');
  writeRaw(fd, 'P1-T2', 'not-json');
  writeRaw(fd, 'P1-T3', JSON.stringify({ version: 1, state: 'bogus' }));
  const got = collectTasksByState(fd, () => true);
  assert.deepEqual(got.map((g) => g.taskId), ['P1-T1']);
});

test('collectTasksByState: skips dir/payload task_id mismatch', () => {
  const fd = forgeDir();
  // Directory name is the canonical id; payload disagrees → skipped.
  writeState(fd, 'P1-T1', 'running', 'SOMETHING-ELSE');
  writeState(fd, 'P1-T2', 'running');
  const got = collectTasksByState(fd, () => true);
  assert.deepEqual(got.map((g) => g.taskId), ['P1-T2']);
});

test('collectTasksByState: skips hostile / malformed directory names', () => {
  const fd = forgeDir();
  writeState(fd, 'P1-T1', 'running');
  // A directory name that fails validateIdSegment must be skipped, not joined.
  writeRaw(fd, '..evil', JSON.stringify({ version: 1, task_id: '..evil', state: 'running' }));
  const got = collectTasksByState(fd, () => true);
  assert.deepEqual(got.map((g) => g.taskId), ['P1-T1']);
});

// Review-fix #3: the scanner is exported + consumed by read verbs, so it must
// not traverse symlinks (path-traversal vector) or read unbounded files.
test('collectTasksByState: skips a symlinked task directory', () => {
  const fd = forgeDir();
  writeState(fd, 'P1-T1', 'running');
  // A valid-named task dir whose entry is a symlink to an outside dir.
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  writeFileSync(
    join(outside, 'state.json'),
    JSON.stringify({
      version: 1,
      task_id: 'P9-EVIL',
      state: 'running',
      state_version: 0,
      attempt_count: 1,
      current_attempt_id: null,
      updated_at: new Date().toISOString(),
      updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
    }),
    'utf8',
  );
  const tasksRoot = join(fd, 'orchestrator', 'tasks');
  mkdirSync(tasksRoot, { recursive: true });
  symlinkSync(outside, join(tasksRoot, 'P9-EVIL'), 'dir');
  const got = collectTasksByState(fd, () => true);
  assert.deepEqual(got.map((g) => g.taskId), ['P1-T1']);
});

test('collectTasksByState: skips an oversized state.json (> cap)', () => {
  const fd = forgeDir();
  writeState(fd, 'P1-T1', 'running');
  // A schema-valid-looking but >1MB state.json must be skipped before parse.
  const huge = `${' '.repeat(1024 * 1024 + 10)}{}`;
  writeRaw(fd, 'P1-T2', huge);
  const got = collectTasksByState(fd, () => true);
  assert.deepEqual(got.map((g) => g.taskId), ['P1-T1']);
});
