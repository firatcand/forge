import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOrchestrateGc } from '../../../src/cli/orchestrate/gc.ts';

const assertLeaseReleased = (p: string): void => {
  // FORGE-231: release writes a tombstone (file survives); absence only occurs
  // on legacy/admin unlink paths. Either way there must be no ACTIVE lease.
  if (existsSync(p)) {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { status?: string };
    assert.equal(parsed.status, 'released', `expected a release tombstone at ${p}`);
  }
};

import {
  leaseFilePath,
  stateFilePath,
  taskDir,
  attemptDir,
  claimHistoryFilePath,
} from '../../../src/orchestrator/questions/paths.ts';

function freshForgeDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-gc-rec-'));
}

function capture(): {
  stdout: PassThrough;
  stderr: PassThrough;
  out: () => string;
  err: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const o: string[] = [];
  const e: string[] = [];
  stdout.on('data', (c: Buffer) => o.push(c.toString('utf8')));
  stderr.on('data', (c: Buffer) => e.push(c.toString('utf8')));
  return {
    stdout,
    stderr,
    out: () => o.join(''),
    err: () => e.join(''),
  };
}

const fixedNow = (): Date => new Date('2026-05-19T01:00:00.000Z');

function writeLease(
  forgeDir: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
  pathOverride?: string,
): { claim_id: string; generation: number; owner_run_id: string; path: string } {
  const dir = taskDir(forgeDir, taskId);
  mkdirSync(dir, { recursive: true });
  const lease = {
    version: 1,
    claim_id: 'claim-A',
    task_id: taskId,
    attempt_id: null,
    owner_run_id: 'run-A',
    acquired_at: '2026-05-18T10:00:00.000Z',
    expires_at: '2026-05-18T10:30:00.000Z',
    last_heartbeat_at: '2026-05-18T10:00:00.000Z',
    generation: 0,
    spec_revision: 'git:0000000000000000000000000000000000000000',
    ...overrides,
  };
  const path = pathOverride ?? leaseFilePath(forgeDir, taskId);
  writeFileSync(path, JSON.stringify(lease));
  return {
    claim_id: lease.claim_id as string,
    generation: lease.generation as number,
    owner_run_id: lease.owner_run_id as string,
    path,
  };
}

function writeState(
  forgeDir: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = taskDir(forgeDir, taskId);
  mkdirSync(dir, { recursive: true });
  const state = {
    version: 1,
    task_id: taskId,
    state: 'shipped',
    state_version: 0,
    attempt_count: 0,
    current_attempt_id: null,
    updated_at: '2026-05-18T10:00:00.000Z',
    updated_by: { run_id: 'run-A', claim_id: 'claim-A', generation: 0 },
    ...overrides,
  };
  writeFileSync(stateFilePath(forgeDir, taskId), JSON.stringify(state));
}

// ── Clean-tree behavior ──

test('orchestrate gc reconciler: clean tree (no tasks) → "no divergences" + exit 0', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reconcilerRows?.length, 0);
    assert.match(out(), /no divergences/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Dry-run formatter ──

test('orchestrate gc --dry-run: reconciler plan formatted but not applied (row 14)', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    writeState(fd, 'TASK-X', { state: 'shipped' });
    writeLease(fd, 'TASK-X', { task_id: 'TASK-X' });

    const result = await runOrchestrateGc({
      forgeDir: fd,
      dryRun: true,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reconcilerRows?.length, 1);
    assert.equal(result.reconcilerRows?.[0]?.rowId, 14);
    assert.equal(result.reconcilerRows?.[0]?.action, 'release_lease_admin');

    // Dry-run: lease file MUST still be present (no mutation).
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-X')), true);

    // Output should mention the plan and the row.
    assert.match(out(), /gc reconciler plan/);
    assert.match(out(), /release_lease_admin/);
    assert.match(out(), /Re-run without --dry-run/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 14 ──

test('orchestrate gc apply: row 14 (lease + terminal state) → lease unlinked + admin_released history event', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    writeState(fd, 'TASK-X', { state: 'shipped' });
    writeLease(fd, 'TASK-X', { task_id: 'TASK-X', claim_id: 'claim-X' });
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-X')), true);

    const result = await runOrchestrateGc({
      forgeDir: fd,
      stdout,
      stderr,
      now: fixedNow,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reconcilerRows?.length, 1);
    assert.equal(result.reconcilerErrors?.length ?? 0, 0);

    // Lease file removed.
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-X')), false);
    // claim-history.jsonl has the admin_released event with the right reason.
    const history = readFileSync(claimHistoryFilePath(fd, 'TASK-X'), 'utf8');
    const events = history.trim().split('\n').map((l) => JSON.parse(l));
    const releaseEvent = events.find((e) => e.event === 'admin_released');
    assert.ok(releaseEvent, 'admin_released event expected');
    assert.equal(releaseEvent.reason, 'gc:row-14:terminal-state');
    assert.match(out(), /admin-released lease/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 13 ──

test('orchestrate gc apply: row 13 (multiple leases) → older-generation lease released, canonical untouched', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    // Canonical lease — generation 2
    writeLease(fd, 'TASK-Y', { task_id: 'TASK-Y', generation: 2, claim_id: 'claim-NEW' });
    // Older duplicate — generation 1 at sibling path
    writeLease(
      fd,
      'TASK-Y',
      { task_id: 'TASK-Y', generation: 1, claim_id: 'claim-OLD' },
      leaseFilePath(fd, 'TASK-Y') + '.dup',
    );
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-Y')), true);
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-Y') + '.dup'), true);

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.reconcilerRows?.some(
        (r) => r.rowId === 13 && r.action === 'release_lease_admin',
      ),
      'row 13 should apply',
    );
    // Older lease gone; canonical still present.
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-Y') + '.dup'), false);
    assert.equal(existsSync(leaseFilePath(fd, 'TASK-Y')), true);
    assert.match(out(), /gc:row-13:duplicate/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 2 ──

test('orchestrate gc apply: row 2 (expired running lease) → abandoned + lease released', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    writeState(fd, 'TASK-EXP', { state: 'running' });
    writeLease(fd, 'TASK-EXP', { task_id: 'TASK-EXP', claim_id: 'claim-EXP' });

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.ok(result.reconcilerRows?.some((r) => r.rowId === 2 && r.action === 'mark_abandoned'));
    assertLeaseReleased(leaseFilePath(fd, 'TASK-EXP'));
    const state = JSON.parse(readFileSync(stateFilePath(fd, 'TASK-EXP'), 'utf8'));
    assert.equal(state.state, 'abandoned');
    assert.match(out(), /marked abandoned/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 8 ──

test('orchestrate gc apply: row 8 (verdict without verified copy) → writes verdict.verified.json', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    const taskId = 'TASK-V';
    const attemptId = 'att-001';
    writeState(fd, taskId, { state: 'running' });
    const aDir = attemptDir(fd, taskId, attemptId);
    mkdirSync(aDir, { recursive: true });
    writeFileSync(
      join(aDir, 'verdict.json'),
      JSON.stringify({
        version: 1,
        verdict: 'changes_needed',
        summary: 'Needs another pass',
        tests: { ran: true, passed: 0, failed: 1, skipped: 0, duration_ms: 100, output_excerpt: 'fail' },
        lint: { ran: true, clean: true, violations: 1, output_excerpt: 'lint' },
        branch: 'feat/task-v',
        save_point: 'checkpoint',
      }),
    );

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.ok(result.reconcilerRows?.some((r) => r.rowId === 8 && r.action === 'reverify_verdict'));
    const verified = JSON.parse(readFileSync(join(aDir, 'verdict.verified.json'), 'utf8'));
    assert.equal(verified.verdict, 'changes_needed');
    assert.equal(verified.verified_by, 'cli@gc-self-attest');
    assert.match(out(), /wrote verdict\.verified\.json/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 11 (archive question on terminal attempt) ──

test('orchestrate gc apply: row 11 — question file on terminal attempt is archived', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out, err } = capture();
  try {
    const taskId = 'TASK-Q';
    const attemptId = 'att-001';
    writeState(fd, taskId, { state: 'shipped' });
    const aDir = attemptDir(fd, taskId, attemptId);
    const qDir = join(aDir, 'questions');
    mkdirSync(qDir, { recursive: true });
    writeFileSync(join(qDir, 'q1.json'), '{"question":"are we shipping?"}');
    // Mark attempt terminal by dropping a verdict.json
    writeFileSync(join(aDir, 'verdict.json'), '{"verdict":"ready_for_review"}');
    writeFileSync(join(aDir, 'verdict.verified.json'), '{"verdict":"ready_for_review"}');

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0, `stderr: ${err()}, stdout: ${out()}`);
    // After execution: row 11 archived the question
    assert.equal(existsSync(join(qDir, 'q1.json')), false, 'question file should move');
    assert.equal(
      existsSync(join(aDir, 'archived', 'q1.json')),
      true,
      'archived/q1.json should exist',
    );
    assert.ok(
      result.reconcilerRows?.some((r) => r.action === 'archive_question'),
    );
    assert.match(out(), /archived question to/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Apply mode: row 14 + row 11 in one plan ──

test('orchestrate gc apply: multiple rows in one plan execute deterministically', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr } = capture();
  try {
    // Set up row 14 (terminal task with lease)
    writeState(fd, 'TASK-A', { state: 'shipped' });
    writeLease(fd, 'TASK-A', { task_id: 'TASK-A' });
    // Set up row 11 (question on terminal attempt)
    const taskId = 'TASK-B';
    const attemptId = 'att-001';
    writeState(fd, taskId, { state: 'failed', failure_reason: 'fatal' });
    const aDir = attemptDir(fd, taskId, attemptId);
    mkdirSync(join(aDir, 'questions'), { recursive: true });
    writeFileSync(join(aDir, 'questions', 'q.json'), '{}');
    writeFileSync(join(aDir, 'verdict.json'), '{"verdict":"ready_for_review"}');
    writeFileSync(join(aDir, 'verdict.verified.json'), '{"verdict":"ready_for_review"}');

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reconcilerRows?.length, 2);
    assert.equal(result.reconcilerErrors?.length ?? 0, 0);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Idempotence ──

test('orchestrate gc apply: re-running after apply produces empty reconciler plan', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr } = capture();
  try {
    writeState(fd, 'TASK-IDEM', { state: 'shipped' });
    writeLease(fd, 'TASK-IDEM', { task_id: 'TASK-IDEM' });

    const first = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(first.exitCode, 0);
    assert.equal(first.reconcilerRows?.length, 1);

    const { stdout: s2, stderr: e2, out: out2 } = capture();
    const second = await runOrchestrateGc({ forgeDir: fd, stdout: s2, stderr: e2, now: fixedNow });
    assert.equal(second.exitCode, 0);
    assert.equal(second.reconcilerRows?.length, 0);
    assert.match(out2(), /no divergences/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});

// ── Legacy migration regression: legacy + reconciler coexist in one invocation ──

test('orchestrate gc: legacy migration AND reconciler plan execute in the same invocation', async () => {
  const fd = freshForgeDir();
  const { stdout, stderr, out } = capture();
  try {
    // Legacy artifact
    const legacyQDir = join(fd, 'questions');
    mkdirSync(legacyQDir, { recursive: true });
    writeFileSync(join(legacyQDir, 'q1.json'), '{}');
    // Reconciler artifact (row 14)
    writeState(fd, 'TASK-MIX', { state: 'shipped' });
    writeLease(fd, 'TASK-MIX', { task_id: 'TASK-MIX' });

    const result = await runOrchestrateGc({ forgeDir: fd, stdout, stderr, now: fixedNow });
    assert.equal(result.exitCode, 0);
    // Legacy migrated
    assert.equal(result.migrated.length, 1);
    // Reconciler row applied
    assert.equal(result.reconcilerRows?.length, 1);
    assert.match(out(), /Migrated 1 legacy file/);
    assert.match(out(), /admin-released lease/);
  } finally {
    rmSync(fd, { recursive: true, force: true });
  }
});
