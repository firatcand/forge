// End-to-end coverage for `forge orchestrate reconcile`. Drives the full
// CLI verb through a tmpdir worktree against a shared FakeTracker. Unit
// tests in test/unit/cli/orchestrate-reconcile.test.ts cover argv parsing
// and JSON envelope shape; this file covers behavioral acceptance:
//
// - Round-trip preservation (--pull → --push → --pull = no-op)
// - Unmanaged tracker issue end-to-end path
// - Comment + ordering preservation across --pull writes
//
// Per [[scope-cut-worldview-check-before-multi-adapter-stdlib]] we test the
// Tracker interface contract via a single FakeTracker, not three. Per-adapter
// quirks (forge:task footer parsing, Notion stub) live in FORGE-94's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runOrchestrateReconcile } from '../../../../src/cli/orchestrate/reconcile.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { Issue } from '../../../../src/trackers/types.ts';

interface JsonPayload {
  readonly ok: boolean;
  readonly data?: {
    readonly pull?: { readonly updated: unknown[]; readonly removed: unknown[]; readonly unmanaged: unknown[]; readonly added: unknown[] };
    readonly push?: { readonly succeeded: string[]; readonly failed: unknown[]; readonly plan: { readonly bodies: { readonly task_id: string; readonly body: string }[]; readonly skipped: unknown[] } };
    readonly applied?: boolean;
    readonly mutations?: number;
  };
}

function captureStream(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, chunks };
}

function mkScratchWorktree(opts: { phasesYaml: string }): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-reconcile-e2e-'));
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'phases.yaml'), opts.phasesYaml);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// FakeTracker — single in-memory adapter implementing the Tracker contract.
// Stores issues AND bodies pushed via updateIssueBody so the round-trip test
// can assert what reached the tracker. Per Codex 2nd-pass: the prior version
// discarded the body argument, making "round-trip preserves all fields" a
// structural placebo.
function makeFakeTracker(initial: Issue[]): {
  tracker: Tracker;
  setIssue: (issue: Issue) => void;
  getIssue: (id: string) => Issue | undefined;
  callsToUpdateBody: string[];
  bodiesById: Map<string, string>;
} {
  const issues = new Map<string, Issue>();
  for (const i of initial) issues.set(i.id, i);
  const calls: string[] = [];
  const bodiesById = new Map<string, string>();
  const tracker: Tracker = {
    type: 'linear',
    listActiveIssues: async () => Array.from(issues.values()),
    async claim() {
      throw new Error('unused');
    },
    async releaseClaim() {},
    async updateState() {},
    async comment() {},
    async updateIssueBody(id: string, body: string) {
      calls.push(id);
      bodiesById.set(id, body);
    },
    async createProject() {
      return { id: 'p', url: 'u' };
    },
    async createIssue() {
      throw new Error('unused');
    },
    async setBlockedBy() {},
    async healthCheck() {
      return { ok: true };
    },
  };
  return {
    tracker,
    setIssue: (issue: Issue) => issues.set(issue.id, issue),
    getIssue: (id: string) => issues.get(id),
    callsToUpdateBody: calls,
    bodiesById,
  };
}

const PHASES_FIXTURE = `# Top-level comment — must survive --pull writes
project: forge
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      # Task comment — must survive
      - id: P1-T01
        tracker_issue_id: t-1
        title: Task one
        description: First task
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['It works']
      - id: P1-T02
        tracker_issue_id: t-2
        title: Task two
        description: Second
        type: backend
        priority: P1
        depends_on: [P1-T01]
        estimate: M
        owner_type: backend-dev
        acceptance: ['Also works']
`;

async function runVerb(opts: {
  cwd: string;
  argv: string[];
  tracker: Tracker;
}): Promise<{ exitCode: number; out: string; err: string }> {
  const o = captureStream();
  const e = captureStream();
  const result = await runOrchestrateReconcile({
    cwd: opts.cwd,
    argv: opts.argv,
    stdout: o.stream,
    stderr: e.stream,
    trackerOverride: opts.tracker,
  });
  return { exitCode: result.exitCode, out: o.chunks.join(''), err: e.chunks.join('') };
}

test('e2e — round-trip: pull → push → re-pull yields no further updates', async () => {
  const wt = mkScratchWorktree({ phasesYaml: PHASES_FIXTURE });
  try {
    // Tracker state matches phases.yaml exactly.
    const fake = makeFakeTracker([
      {
        id: 't-1',
        identifier: 'F-1',
        title: 'Task one',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P1-T01',
      },
      {
        id: 't-2',
        identifier: 'F-2',
        title: 'Task two',
        state: 'todo',
        blockerIds: ['t-1'],
        forgeTaskId: 'P1-T02',
      },
    ]);

    // First --pull: no diff, no writes
    const r1 = await runVerb({ cwd: wt.dir, argv: ['--pull'], tracker: fake.tracker });
    assert.equal(r1.exitCode, 0);
    const p1: JsonPayload = JSON.parse(r1.out);
    assert.equal(p1.data?.pull?.updated.length, 0);
    assert.equal(p1.data?.applied, false);

    // --push: emits two updateIssueBody calls
    const r2 = await runVerb({ cwd: wt.dir, argv: ['--push'], tracker: fake.tracker });
    assert.equal(r2.exitCode, 0);
    const p2: JsonPayload = JSON.parse(r2.out);
    assert.deepEqual(p2.data?.push?.succeeded.slice().sort(), ['P1-T01', 'P1-T02']);
    assert.deepEqual(fake.callsToUpdateBody.slice().sort(), ['t-1', 't-2']);

    // Body fidelity — per Codex 2nd-pass: assert what reached the tracker,
    // not just that the call happened. renderTaskBody output must include
    // the task ID, type, owner, priority, description, and acceptance.
    const body1 = fake.bodiesById.get('t-1');
    assert.ok(body1, 'updateIssueBody must have stored a body for t-1');
    assert.match(body1!, /\*\*Forge task ID:\*\* P1-T01/);
    assert.match(body1!, /\*\*Type:\*\* foundation/);
    assert.match(body1!, /\*\*Owner:\*\* backend-dev/);
    assert.match(body1!, /First task/);
    assert.match(body1!, /## Acceptance\n- \[ \] It works/);

    const body2 = fake.bodiesById.get('t-2');
    assert.ok(body2, 'updateIssueBody must have stored a body for t-2');
    assert.match(body2!, /\*\*Depends on:\*\* P1-T01/);

    // Re-pull: tracker state unchanged → still no diff
    const r3 = await runVerb({ cwd: wt.dir, argv: ['--pull'], tracker: fake.tracker });
    assert.equal(r3.exitCode, 0);
    const p3: JsonPayload = JSON.parse(r3.out);
    assert.equal(p3.data?.pull?.updated.length, 0);
    assert.equal(p3.data?.pull?.removed.length, 0);
  } finally {
    wt.cleanup();
  }
});

test('e2e — unmanaged tracker issue surfaces in unmanaged[] and is not added to phases.yaml', async () => {
  const wt = mkScratchWorktree({ phasesYaml: PHASES_FIXTURE });
  try {
    const fake = makeFakeTracker([
      {
        id: 't-1',
        identifier: 'F-1',
        title: 'Task one',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P1-T01',
      },
      {
        id: 't-2',
        identifier: 'F-2',
        title: 'Task two',
        state: 'todo',
        blockerIds: ['t-1'],
        forgeTaskId: 'P1-T02',
      },
      // Unmanaged: no forgeTaskId footer (issue created outside forge)
      {
        id: 't-99',
        identifier: 'F-99',
        title: 'Hand-filed bug',
        state: 'todo',
        blockerIds: [],
      },
    ]);

    const r = await runVerb({ cwd: wt.dir, argv: ['--pull'], tracker: fake.tracker });
    assert.equal(r.exitCode, 0);
    const p: JsonPayload = JSON.parse(r.out);
    assert.equal(p.data?.pull?.unmanaged.length, 1);
    assert.equal(p.data?.pull?.added.length, 0);
    // phases.yaml unchanged
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.equal(after.includes('t-99'), false);
    assert.equal(after.includes('Hand-filed'), false);
  } finally {
    wt.cleanup();
  }
});

test('e2e — --pull preserves comments and field ordering across writes', async () => {
  const wt = mkScratchWorktree({ phasesYaml: PHASES_FIXTURE });
  try {
    const fake = makeFakeTracker([
      {
        id: 't-1',
        identifier: 'F-1',
        title: 'Task one RETITLED',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P1-T01',
      },
      {
        id: 't-2',
        identifier: 'F-2',
        title: 'Task two',
        state: 'todo',
        blockerIds: ['t-1'],
        forgeTaskId: 'P1-T02',
      },
    ]);

    const r = await runVerb({ cwd: wt.dir, argv: ['--pull', '--confirm-prune'], tracker: fake.tracker });
    assert.equal(r.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(after, /# Top-level comment/);
    assert.match(after, /# Task comment/);
    assert.match(after, /title: Task one RETITLED/);
    // Field order: id before tracker_issue_id before title (per fixture)
    const t01Block = after.slice(after.indexOf('id: P1-T01'), after.indexOf('- id: P1-T02'));
    const idIdx = t01Block.indexOf('id: P1-T01');
    const tidIdx = t01Block.indexOf('tracker_issue_id:');
    const titleIdx = t01Block.indexOf('title:');
    assert.ok(idIdx < tidIdx && tidIdx < titleIdx, 'field order preserved');
  } finally {
    wt.cleanup();
  }
});

test('e2e — --pull orphan flow: dry-run → confirm-prune second pass actually prunes', async () => {
  const wt = mkScratchWorktree({ phasesYaml: PHASES_FIXTURE });
  try {
    // Tracker only has t-1; t-2 is orphan in yaml
    const fake = makeFakeTracker([
      {
        id: 't-1',
        identifier: 'F-1',
        title: 'Task one',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P1-T01',
      },
    ]);

    // First pass — dry-run: should exit PRUNE_PENDING and list orphan
    const r1 = await runVerb({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run'],
      tracker: fake.tracker,
    });
    assert.equal(r1.exitCode, 1);
    const p1: JsonPayload = JSON.parse(r1.out);
    assert.equal(p1.data?.pull?.removed.length, 1);

    // phases.yaml still has both
    const before = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(before, /P1-T02/);

    // Second pass — confirm-prune: removes P1-T02
    const r2 = await runVerb({
      cwd: wt.dir,
      argv: ['--pull', '--confirm-prune'],
      tracker: fake.tracker,
    });
    assert.equal(r2.exitCode, 0);
    const p2: JsonPayload = JSON.parse(r2.out);
    assert.equal(p2.data?.applied, true);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.equal(after.includes('P1-T02'), false);
    assert.match(after, /P1-T01/);
  } finally {
    wt.cleanup();
  }
});

test('e2e — --pull --no-prune ignores orphans and applies updates to remaining tasks', async () => {
  const wt = mkScratchWorktree({ phasesYaml: PHASES_FIXTURE });
  try {
    // Tracker has only t-1, RETITLED. t-2 is orphan.
    const fake = makeFakeTracker([
      {
        id: 't-1',
        identifier: 'F-1',
        title: 'Task one RENAMED',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P1-T01',
      },
    ]);

    const r = await runVerb({
      cwd: wt.dir,
      argv: ['--pull', '--no-prune'],
      tracker: fake.tracker,
    });
    assert.equal(r.exitCode, 0);
    const p: JsonPayload = JSON.parse(r.out);
    assert.equal(p.data?.applied, true);
    assert.equal(p.data?.pull?.removed.length, 1);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // Title updated
    assert.match(after, /title: Task one RENAMED/);
    // Orphan kept (no prune)
    assert.match(after, /P1-T02/);
  } finally {
    wt.cleanup();
  }
});
