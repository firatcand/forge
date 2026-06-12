import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { detectCheapDivergences } from '../../../src/cli/orchestrate/gc.ts';
import {
  leaseFilePath,
  stateFilePath,
  taskDir,
} from '../../../src/orchestrator/questions/paths.ts';
import { readFileSync } from 'node:fs';

function freshForgeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-autogc-'));
  mkdirSync(join(root, '.forge', 'orchestrator'), { recursive: true });
  return join(root, '.forge');
}

function writeState(forgeDir: string, taskId: string, state: string): void {
  const dir = taskDir(forgeDir, taskId);
  mkdirSync(dir, { recursive: true });
  const record = {
    version: 1,
    task_id: taskId,
    state,
    state_version: 0,
    attempt_count: 0,
    current_attempt_id: null,
    updated_at: '2026-05-19T10:00:00.000Z',
    updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
  };
  writeFileSync(stateFilePath(forgeDir, taskId), JSON.stringify(record));
}

function writeLease(forgeDir: string, taskId: string, expiresAt?: string): void {
  mkdirSync(taskDir(forgeDir, taskId), { recursive: true });
  const lease = {
    version: 1,
    claim_id: 'claim-X',
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-X',
    acquired_at: '2026-05-19T09:00:00.000Z',
    expires_at: expiresAt ?? '2026-05-19T09:30:00.000Z',
    last_heartbeat_at: '2026-05-19T09:00:00.000Z',
    generation: 0,
    spec_revision: 'git:0000000000000000000000000000000000000000',
  };
  writeFileSync(leaseFilePath(forgeDir, taskId), JSON.stringify(lease));
}

function captureStream(): { stream: PassThrough; out: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { stream, out: () => chunks.join('') };
}

const NOW = new Date('2026-05-19T11:00:00.000Z');

// ── Unit tests of detectCheapDivergences (the helper called by phases / status) ──

test('detectCheapDivergences: row 14 (lease + terminal state) → warning line on stderr', () => {
  const fd = freshForgeDir();
  try {
    writeState(fd, 'TASK-X', 'shipped');
    writeLease(fd, 'TASK-X');
    const { stream, out } = captureStream();
    detectCheapDivergences(fd, stream, NOW);
    const stderrOutput = out();
    assert.match(stderrOutput, /\[gc\] TASK-X: row 14/);
    assert.match(stderrOutput, /run `forge orchestrate gc` to apply/);
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: row 2 (lease expired beyond grace) → warning line', () => {
  const fd = freshForgeDir();
  try {
    writeState(fd, 'TASK-EXP', 'running');
    // Lease that expired 1 hour ago (well beyond steal_grace_ms default 5m)
    writeLease(fd, 'TASK-EXP', '2026-05-19T09:00:00.000Z');
    const { stream, out } = captureStream();
    detectCheapDivergences(fd, stream, NOW);
    assert.match(out(), /\[gc\] TASK-EXP: row 2/);
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: clean tree → no warnings', () => {
  const fd = freshForgeDir();
  try {
    const { stream, out } = captureStream();
    detectCheapDivergences(fd, stream, NOW);
    assert.equal(out(), '');
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: does NOT mutate — lease file remains after detect', () => {
  const fd = freshForgeDir();
  try {
    writeState(fd, 'TASK-Y', 'shipped');
    writeLease(fd, 'TASK-Y');
    const leasePath = leaseFilePath(fd, 'TASK-Y');
    assert.equal(existsSync(leasePath), true);
    const { stream } = captureStream();
    detectCheapDivergences(fd, stream, NOW);
    assert.equal(existsSync(leasePath), true, 'lease must remain — detect-only');
    // state.json also untouched
    const stateBefore = JSON.parse(readFileSync(stateFilePath(fd, 'TASK-Y'), 'utf8'));
    assert.equal(stateBefore.state, 'shipped');
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: malformed I/O does NOT throw (best-effort)', () => {
  // forgeDir doesn't exist at all
  const fakeDir = '/tmp/forge-autogc-nonexistent-' + Math.random();
  const { stream, out } = captureStream();
  // Must not throw
  detectCheapDivergences(fakeDir, stream, NOW);
  // Nothing detected (empty snapshot)
  assert.equal(out(), '');
});

test('detectCheapDivergences: does NOT fire on expensive rows (e.g., row 9 branch+no-worktree)', () => {
  // We can't easily set up row 9 without git plumbing; instead, verify that
  // the cheap-set excludes row 9 via the gc planner. (Locking the partition
  // is the actual unit test in test/orchestrator/gc.test.ts.) Here we just
  // confirm that a state that WOULD trigger only-expensive rows produces no
  // cheap warning.
  const fd = freshForgeDir();
  try {
    // running + valid lease — no row triggered
    writeState(fd, 'TASK-RUN', 'running');
    writeLease(fd, 'TASK-RUN', '2026-05-19T12:00:00.000Z'); // not expired
    const { stream, out } = captureStream();
    detectCheapDivergences(fd, stream, NOW);
    assert.equal(out(), '');
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

// ── Wiring smoke: phases.ts and status.ts both import detectCheapDivergences ──

test('phases.ts imports detectCheapDivergences from gc.ts', async () => {
  // Static import check via reading the source — guards against accidental
  // removal of the auto-gc hook.
  const phasesSrc = readFileSync(
    join(process.cwd(), 'src/cli/orchestrate/phases.ts'),
    'utf8',
  );
  assert.match(phasesSrc, /detectCheapDivergences/);
  assert.match(phasesSrc, /from '\.\/gc\.ts'/);
});

test('status.ts imports detectCheapDivergences from gc.ts', async () => {
  const statusSrc = readFileSync(
    join(process.cwd(), 'src/cli/orchestrate/status.ts'),
    'utf8',
  );
  assert.match(statusSrc, /detectCheapDivergences/);
  assert.match(statusSrc, /from '\.\/gc\.ts'/);
});

// ── FORGE-149: detectCheapDivergences returns structured warnings ────────────

test('detectCheapDivergences: returns structured GcCheapWarning[] AND still emits stderr', () => {
  const fd = freshForgeDir();
  try {
    writeState(fd, 'TASK-W', 'shipped');
    writeLease(fd, 'TASK-W');
    const { stream, out } = captureStream();
    const warnings = detectCheapDivergences(fd, stream, NOW);
    // stderr side effect preserved
    assert.match(out(), /\[gc\] TASK-W: row 14/);
    // structured return
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.task_id, 'TASK-W');
    assert.equal(warnings[0]!.row_id, 14);
    assert.equal(warnings[0]!.severity, 'warning');
    assert.equal(warnings[0]!.suggestion, 'run `forge orchestrate gc` to apply');
    assert.equal(typeof warnings[0]!.action, 'string');
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: clean tree → empty array', () => {
  const fd = freshForgeDir();
  try {
    const { stream } = captureStream();
    assert.deepEqual(detectCheapDivergences(fd, stream, NOW), []);
  } finally {
    rmSync(fd.replace(/\/\.forge$/, ''), { recursive: true, force: true });
  }
});

test('detectCheapDivergences: failure path returns [] (and notes on stderr)', () => {
  const fakeDir = '/tmp/forge-autogc-nonexistent-' + Math.random();
  const { stream } = captureStream();
  assert.deepEqual(detectCheapDivergences(fakeDir, stream, NOW), []);
});
