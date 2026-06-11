import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  computeNextTaskId,
  runOrchestrateAmendRoadmap,
} from '../../../../src/cli/orchestrate/amend-roadmap.ts';
import { acquirePhasesWriteLock } from '../../../../src/cli/orchestrate/reconcile.ts';
import { insertTaskIntoDocument } from '../../../../src/orchestrator/reconcile.ts';
import { PhasesSchema } from '../../../../src/schemas/phases.ts';
import { amendPayloadHash, AmendPayloadSchema } from '../../../../src/schemas/amend-journal.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { Issue, IssueListPage } from '../../../../src/trackers/types.ts';
import { parseDocument } from 'yaml';

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // Record AND forward. node:test (child mode) multiplexes its reporter
  // protocol over this same stream — a swallow-only hook races the runner's
  // async report flushing and silently drops test results (observed: a 26-test
  // file reporting "pass 3"). Forwarding keeps the protocol flowing; our
  // envelope chunks interleave as ordinary test output, which the runner
  // tolerates by design (same as console.log in a test).
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    buf.push(String(chunk));
    return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return buf;
}

function lastJson(buf: string[]): { ok: boolean; data?: any; error?: any } {
  // The capture hook also swallows node:test reporter traffic that flushes
  // while a test body is awaiting (visible with the 5s lock-retry test), and
  // that traffic shares no line discipline with our output. The envelope,
  // however, is always ONE pure write() — `JSON.stringify(envelope) + '\n'`
  // (envelope.ts emit) — i.e., one captured chunk. Scan chunks backwards.
  for (let i = buf.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(buf[i]!.trim()) as Record<string, unknown>;
      if (parsed !== null && typeof parsed === 'object' && 'ok' in parsed) {
        return parsed as { ok: boolean; data?: any; error?: any };
      }
    } catch {
      // not a pure JSON chunk (reporter noise) — keep scanning
    }
  }
  throw new Error(`no JSON envelope chunk found in captured stdout (${buf.length} chunks)`);
}

// phases.yaml fixture: one phase, two tasks (one tracker-backed, one local-only).
const PHASES = `project: demo
source:
  tracker: linear
  project_id: proj-1
  synced_at: 2026-06-01T00:00:00.000Z
  spec_revision: abc123
phases:
  - id: phase-2
    name: Core
    status: active
    goal: Build the core
    gate_criteria:
      - all green
    tasks:
      - id: P2-T01
        tracker_issue_id: FORGE-90
        title: Existing tracker-backed task
        description: Already shipped to tracker.
        type: backend
        priority: P0
        depends_on: []
        estimate: M
        owner_type: backend-dev
        acceptance:
          - works
      - id: P2-T02
        title: Local-only task
        description: Never pushed.
        type: backend
        priority: P1
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance:
          - works
`;

const BASE_PAYLOAD = {
  phase: 'phase-2',
  title: 'Add caching layer',
  description: 'Cache tracker reads between verbs.',
  type: 'backend',
  priority: 'P1',
  estimate: 'M',
  owner_type: 'backend-dev',
  acceptance: ['cache hit ratio measured'],
  depends_on: ['P2-T01'],
};

interface FakeIssueTracker extends Tracker {
  readonly createCalls: unknown[];
  readonly blockedByCalls: { issueId: string; blockerId: string }[];
}

function fakeTracker(opts: {
  issues?: Issue[];
  truncated?: boolean;
  failCreate?: boolean;
  failSetBlockedBy?: boolean;
  createdId?: { id: string; identifier: string };
} = {}): FakeIssueTracker {
  const createCalls: unknown[] = [];
  const blockedByCalls: { issueId: string; blockerId: string }[] = [];
  const issues: Issue[] = opts.issues ?? [
    {
      id: 'uuid-90',
      identifier: 'FORGE-90',
      title: 'Existing tracker-backed task',
      state: 'todo',
      blockerIds: [],
      forgeTaskId: 'P2-T01',
    },
  ];
  const notUsed = (m: string) => () => Promise.reject(new Error(`fakeTracker.${m} not expected`));
  return {
    type: 'linear',
    createCalls,
    blockedByCalls,
    async listAllIssues(): Promise<IssueListPage> {
      return { issues: [...issues], truncated: opts.truncated ?? false };
    },
    async createIssue(payload) {
      if (opts.failCreate) throw new Error('simulated createIssue failure');
      createCalls.push(payload);
      const created: Issue = {
        id: opts.createdId?.id ?? 'uuid-new',
        identifier: opts.createdId?.identifier ?? 'FORGE-200',
        title: (payload as { title: string }).title,
        state: 'todo',
        blockerIds: [],
        forgeTaskId: (payload as { forgeTaskId: string }).forgeTaskId,
        url: `https://linear.app/demo/issue/${opts.createdId?.identifier ?? 'FORGE-200'}`,
      };
      issues.push(created);
      return created;
    },
    async setBlockedBy(issueId: string, blockerId: string) {
      if (opts.failSetBlockedBy) throw new Error('simulated setBlockedBy failure');
      blockedByCalls.push({ issueId, blockerId });
    },
    listActiveIssues: notUsed('listActiveIssues') as Tracker['listActiveIssues'],
    claim: notUsed('claim') as Tracker['claim'],
    releaseClaim: notUsed('releaseClaim') as Tracker['releaseClaim'],
    updateState: notUsed('updateState') as Tracker['updateState'],
    comment: notUsed('comment') as Tracker['comment'],
    updateIssueBody: notUsed('updateIssueBody') as Tracker['updateIssueBody'],
    setClaimFence: notUsed('setClaimFence') as Tracker['setClaimFence'],
    createProject: notUsed('createProject') as Tracker['createProject'],
    healthCheck: notUsed('healthCheck') as Tracker['healthCheck'],
  };
}

function setupRepo(): { repoRoot: string; forgeDir: string; payloadPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'amend-test-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  mkdirSync(join(repoRoot, 'spec'), { recursive: true });
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), PHASES, 'utf8');
  // computeSpecRevision (inner reconcile --pull, source stanza re-stamp)
  // requires spec/SPEC.md to exist in the repo root.
  writeFileSync(join(repoRoot, 'spec', 'SPEC.md'), '# SPEC\n', 'utf8');
  const payloadPath = join(repoRoot, 'amend-payload.json');
  writeFileSync(payloadPath, JSON.stringify(BASE_PAYLOAD), 'utf8');
  return { repoRoot, forgeDir, payloadPath };
}

function loadPhasesFile(repoRoot: string) {
  const raw = readFileSync(join(repoRoot, 'plans', 'phases.yaml'), 'utf8');
  return { raw, parsed: PhasesSchema.parse(parseDocument(raw).toJS()) };
}

// ── computeNextTaskId ────────────────────────────────────────────────────────

test('computeNextTaskId: max+1 within phase, zero-padded', () => {
  const phases = PhasesSchema.parse(parseDocument(PHASES).toJS()).phases;
  assert.equal(computeNextTaskId(phases, 'phase-2'), 'P2-T03');
});

test('computeNextTaskId: suffixed ids count toward the stem max; collisions skipped', () => {
  const phases = PhasesSchema.parse(
    parseDocument(PHASES.replace('id: P2-T02', 'id: P2-T04a')).toJS(),
  ).phases;
  // max stem is 4 (from T04a) → next is 5.
  assert.equal(computeNextTaskId(phases, 'phase-2'), 'P2-T05');
});

// ── insertTaskIntoDocument ───────────────────────────────────────────────────

test('insertTaskIntoDocument: inserts a full task, preserves comments, idempotent', () => {
  const doc = parseDocument(`project: demo
phases:
  - id: phase-2
    name: Core # keep this comment
    status: active
    goal: g
    gate_criteria: [x]
    tasks:
      - id: P2-T01
        title: t
        description: d
        type: backend
        priority: P0
        depends_on: []
        estimate: M
        owner_type: backend-dev
        acceptance: [a]
`);
  const task = {
    id: 'P2-T02',
    tracker_issue_id: 'FORGE-200',
    title: 'New',
    description: 'New task',
    type: 'backend' as const,
    priority: 'P1' as const,
    depends_on: ['P2-T01'],
    estimate: 'M' as const,
    owner_type: 'backend-dev' as const,
    acceptance: ['done'],
  };
  assert.equal(insertTaskIntoDocument(doc, 'phase-2', task), true);
  // Idempotent: second insert is a no-op.
  assert.equal(insertTaskIntoDocument(doc, 'phase-2', task), false);
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  assert.match(out, /# keep this comment/);
  assert.match(out, /id: P2-T02/);
  assert.match(out, /depends_on: \[P2-T01\]/); // flow style
  // Result still validates.
  PhasesSchema.parse(doc.toJS());
});

test('insertTaskIntoDocument: unknown phase throws', () => {
  const doc = parseDocument(PHASES);
  assert.throws(
    () =>
      insertTaskIntoDocument(doc, 'phase-9', {
        id: 'P9-T01',
        title: 't',
        description: 'd',
        type: 'backend',
        priority: 'P0',
        depends_on: [],
        estimate: 'S',
        owner_type: 'backend-dev',
        acceptance: ['a'],
      }),
    /phase 'phase-9' not found/,
  );
});

// ── payload schema ───────────────────────────────────────────────────────────

test('AmendPayloadSchema: XL estimate refused', () => {
  const result = AmendPayloadSchema.safeParse({ ...BASE_PAYLOAD, estimate: 'XL' });
  assert.equal(result.success, false);
});

test('amendPayloadHash: stable under depends_on order + dupes', () => {
  const a = AmendPayloadSchema.parse({ ...BASE_PAYLOAD, depends_on: ['P2-T01', 'P2-T01'] });
  const b = AmendPayloadSchema.parse({ ...BASE_PAYLOAD, depends_on: ['P2-T01'] });
  assert.equal(amendPayloadHash(a), amendPayloadHash(b));
});

// ── verb: happy path ─────────────────────────────────────────────────────────

test('amend-roadmap happy path: issue created, relation wired, phases.yaml materialized, journal archived', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  const tracker = fakeTracker();

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );

  assert.equal(result.exitCode, 0);
  const out = lastJson(buf);
  assert.equal(out.ok, true);
  assert.equal(out.data.task_id, 'P2-T03');
  assert.equal(out.data.tracker_identifier, 'FORGE-200');
  assert.deepEqual(out.data.depends_on, ['P2-T01']);
  assert.equal(out.data.phases_updated, true);

  // createIssue payload carried the forge task id + acceptance-bearing body.
  assert.equal(tracker.createCalls.length, 1);
  const created = tracker.createCalls[0] as { forgeTaskId: string; body: string };
  assert.equal(created.forgeTaskId, 'P2-T03');
  assert.match(created.body, /## Acceptance/);
  assert.match(created.body, /cache hit ratio measured/);

  // Relation wired with INTERNAL ids on both sides.
  assert.deepEqual(tracker.blockedByCalls, [{ issueId: 'uuid-new', blockerId: 'uuid-90' }]);

  // phases.yaml gained the task, still valid, bound to the identifier.
  const { parsed } = loadPhasesFile(repoRoot);
  const newTask = parsed.phases[0]!.tasks.find((x) => x.id === 'P2-T03');
  assert.ok(newTask);
  assert.equal(newTask!.tracker_issue_id, 'FORGE-200');
  assert.deepEqual(newTask!.depends_on, ['P2-T01']);

  // Journal archived; active journal gone.
  assert.equal(
    existsSync(join(forgeDir, 'orchestrator', 'global', 'amend-journal', 'completed', 'P2-T03.json')),
    true,
  );
  assert.equal(
    existsSync(join(forgeDir, 'orchestrator', 'global', 'amend-journal', 'P2-T03.json')),
    false,
  );
});

// ── verb: validation failures (no journal, no tracker calls) ────────────────

test('unknown dependency refused before any tracker call or journal write', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  writeFileSync(payloadPath, JSON.stringify({ ...BASE_PAYLOAD, depends_on: ['P9-T99'] }), 'utf8');
  const tracker = fakeTracker();

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'INVALID_DEPENDENCY');
  assert.equal(tracker.createCalls.length, 0);
  assert.equal(existsSync(join(forgeDir, 'orchestrator', 'global', 'amend-journal')), false);
});

test('dependency without tracker backing refused', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  writeFileSync(payloadPath, JSON.stringify({ ...BASE_PAYLOAD, depends_on: ['P2-T02'] }), 'utf8');

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );

  assert.equal(result.exitCode, 1);
  const out = lastJson(buf);
  assert.equal(out.error.code, 'INVALID_DEPENDENCY');
  assert.match(out.error.message, /no tracker_issue_id/);
});

test('missing source stanza refused (NO_TRACKER_BINDING)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  writeFileSync(
    join(repoRoot, 'plans', 'phases.yaml'),
    PHASES.replace(/source:[\s\S]*?spec_revision: abc123\n/, ''),
    'utf8',
  );

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'NO_TRACKER_BINDING');
});

test('unknown phase refused (PHASE_NOT_FOUND)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  writeFileSync(payloadPath, JSON.stringify({ ...BASE_PAYLOAD, phase: 'phase-9' }), 'utf8');

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'PHASE_NOT_FOUND');
});

// ── verb: failure + resume ───────────────────────────────────────────────────

test('createIssue failure journals the step; --resume adopts the tracker-created issue without duplicating', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  const first = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );
  assert.equal(first.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'CREATE_ISSUE_FAILED');
  assert.equal(
    existsSync(join(forgeDir, 'orchestrator', 'global', 'amend-journal', 'P2-T03.json')),
    true,
  );

  // Simulate "the createIssue actually landed on the tracker before the crash":
  // resume sees exactly one forgeTaskId match with matching title → adopts.
  const adoptable: Issue = {
    id: 'uuid-new',
    identifier: 'FORGE-200',
    title: BASE_PAYLOAD.title,
    state: 'todo',
    blockerIds: [],
    forgeTaskId: 'P2-T03',
    url: 'https://linear.app/demo/issue/FORGE-200',
  };
  const tracker = fakeTracker({
    issues: [
      {
        id: 'uuid-90',
        identifier: 'FORGE-90',
        title: 'Existing tracker-backed task',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T01',
      },
      adoptable,
    ],
  });
  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );
  assert.equal(second.exitCode, 0);
  const out = lastJson(buf);
  assert.equal(out.data.tracker_identifier, 'FORGE-200');
  // Adoption — createIssue was NOT called again.
  assert.equal(tracker.createCalls.length, 0);
  // Relation still wired.
  assert.deepEqual(tracker.blockedByCalls, [{ issueId: 'uuid-new', blockerId: 'uuid-90' }]);
  // Materialized.
  const { parsed } = loadPhasesFile(repoRoot);
  assert.ok(parsed.phases[0]!.tasks.some((x) => x.id === 'P2-T03'));
});

test('resume with truncated tracker view and no adoption match refuses to re-create', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );

  const truncated = fakeTracker({ truncated: true });
  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', forgeDir, repoRoot, json: true },
    { trackerOverride: truncated },
  );
  assert.equal(second.exitCode, 1);
  const out = lastJson(buf);
  assert.equal(out.error.code, 'CREATE_ISSUE_FAILED');
  assert.match(out.error.message, /truncated/);
  assert.equal(truncated.createCalls.length, 0);
});

test('setBlockedBy failure resumes through relations without re-creating the issue', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failingRel = fakeTracker({ failSetBlockedBy: true });
  const first = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failingRel },
  );
  assert.equal(first.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'SET_RELATION_FAILED');
  assert.equal(failingRel.createCalls.length, 1); // issue WAS created

  // Resume with a healthy tracker whose listing contains the created issue.
  const tracker = fakeTracker({
    issues: [
      {
        id: 'uuid-90',
        identifier: 'FORGE-90',
        title: 'Existing tracker-backed task',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T01',
      },
      {
        id: 'uuid-new',
        identifier: 'FORGE-200',
        title: BASE_PAYLOAD.title,
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T03',
      },
    ],
  });
  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );
  assert.equal(second.exitCode, 0);
  assert.equal(tracker.createCalls.length, 0);
  assert.deepEqual(tracker.blockedByCalls, [{ issueId: 'uuid-new', blockerId: 'uuid-90' }]);
});

test('resume with a mutated payload is refused (PAYLOAD_MISMATCH)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );

  writeFileSync(payloadPath, JSON.stringify({ ...BASE_PAYLOAD, title: 'Edited title' }), 'utf8');
  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(second.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'PAYLOAD_MISMATCH');
});

test('re-run without --resume but identical payload is an implicit resume (no duplicate journal error)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );

  const tracker = fakeTracker();
  const second = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );
  assert.equal(second.exitCode, 0);
  assert.equal(lastJson(buf).data.task_id, 'P2-T03');
});

test('different payload while a journal reserves the same id → JOURNAL_EXISTS', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );

  writeFileSync(payloadPath, JSON.stringify({ ...BASE_PAYLOAD, title: 'A different task' }), 'utf8');
  const second = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(second.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'JOURNAL_EXISTS');
});

test('completed amend is idempotent on --resume (already_applied)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const tracker = fakeTracker();
  const first = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );
  assert.equal(first.exitCode, 0);

  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(second.exitCode, 0);
  assert.equal(lastJson(buf).data.already_applied, true);
});

// ── Codex impl-review hardening (fix loop 1) ─────────────────────────────────

test('--resume with a non-canonical task id is refused before any path construction', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir } = setupRepo();

  for (const evil of ['../../etc/passwd', 'P2-T01/../escape', 'FORGE-101', '..']) {
    const result = await runOrchestrateAmendRoadmap(
      { resumeTaskId: evil, forgeDir, repoRoot, json: true },
      { trackerOverride: fakeTracker() },
    );
    assert.equal(result.exitCode, 1, `should refuse '${evil}'`);
    assert.equal(lastJson(buf).error.code, 'INVALID_ARGS');
  }
});

test('pending-journal crash window: implicit resume adopts a tracker-created issue instead of duplicating', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  // Hand-author a journal exactly as it looks when the process dies BETWEEN
  // the createIssue round-trip and the journal persist: create_issue still
  // 'pending', yet the issue exists on the tracker.
  const payload = AmendPayloadSchema.parse(BASE_PAYLOAD);
  const journalDir = join(forgeDir, 'orchestrator', 'global', 'amend-journal');
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    join(journalDir, 'P2-T03.json'),
    JSON.stringify({
      version: 1,
      task_id: 'P2-T03',
      phase: 'phase-2',
      payload,
      payload_hash: amendPayloadHash(payload),
      resolved_depends_on: ['P2-T01'],
      started_at: '2026-06-11T00:00:00.000Z',
      create_issue: { status: 'pending' },
      relations: [
        { status: 'pending', blocker_task_id: 'P2-T01', blocker_issue_id: 'FORGE-90', retries: 0 },
      ],
      reconcile_pull: { status: 'pending' },
    }),
    'utf8',
  );

  const tracker = fakeTracker({
    issues: [
      {
        id: 'uuid-90',
        identifier: 'FORGE-90',
        title: 'Existing tracker-backed task',
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T01',
      },
      {
        id: 'uuid-new',
        identifier: 'FORGE-200',
        title: BASE_PAYLOAD.title,
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T03',
      },
    ],
  });

  // Re-run with the SAME payload, no --resume — the implicit-resume path.
  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: tracker },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(lastJson(buf).data.tracker_identifier, 'FORGE-200');
  // The crux: createIssue was NOT called again.
  assert.equal(tracker.createCalls.length, 0);
});

test('adoption from a truncated tracker view is refused even when a match is visible', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const failing = fakeTracker({ failCreate: true });
  await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: failing },
  );

  const truncatedWithMatch = fakeTracker({
    truncated: true,
    issues: [
      {
        id: 'uuid-new',
        identifier: 'FORGE-200',
        title: BASE_PAYLOAD.title,
        state: 'todo',
        blockerIds: [],
        forgeTaskId: 'P2-T03',
      },
    ],
  });
  const second = await runOrchestrateAmendRoadmap(
    { resumeTaskId: 'P2-T03', forgeDir, repoRoot, json: true },
    { trackerOverride: truncatedWithMatch },
  );
  assert.equal(second.exitCode, 1);
  const out = lastJson(buf);
  assert.equal(out.error.code, 'CREATE_ISSUE_FAILED');
  assert.match(out.error.message, /truncated/);
  assert.equal(truncatedWithMatch.createCalls.length, 0);
});

test('tracker type differing from phases source.tracker is refused (SOURCE_TRACKER_MISMATCH)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const githubTracker = { ...fakeTracker(), type: 'github' as const };
  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: githubTracker },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(lastJson(buf).error.code, 'SOURCE_TRACKER_MISMATCH');
  assert.equal(githubTracker.createCalls.length, 0);
});

// ── Codex impl-review hardening (fix loop 2: phases.yaml write lock) ─────────

const TWO_PHASE_PHASES = PHASES.replace(
  /$/,
  `  - id: phase-3
    name: Polish
    status: active
    goal: Polish it
    gate_criteria:
      - shiny
    tasks:
      - id: P3-T01
        tracker_issue_id: FORGE-91
        title: Existing polish task
        description: Already shipped to tracker.
        type: backend
        priority: P1
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance:
          - works
`,
);

test('concurrent amends into different phases both materialize (no lost update)', async (t) => {
  captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), TWO_PHASE_PHASES, 'utf8');

  const payloadB = join(repoRoot, 'amend-payload-b.json');
  writeFileSync(
    payloadB,
    JSON.stringify({
      ...BASE_PAYLOAD,
      phase: 'phase-3',
      title: 'Polish the cache',
      depends_on: [],
    }),
    'utf8',
  );

  const issuesBase: Issue[] = [
    {
      id: 'uuid-90',
      identifier: 'FORGE-90',
      title: 'Existing tracker-backed task',
      state: 'todo',
      blockerIds: [],
      forgeTaskId: 'P2-T01',
    },
  ];
  const trackerA = fakeTracker({ issues: [...issuesBase] });
  const trackerB = fakeTracker({
    issues: [...issuesBase],
    createdId: { id: 'uuid-new-b', identifier: 'FORGE-201' },
  });

  // The lost-update race: both runs read the same phases.yaml snapshot, then
  // write in sequence. The phases-write lock must serialize them so the
  // second pull re-reads the first one's write.
  const [a, b] = await Promise.all([
    runOrchestrateAmendRoadmap(
      { payloadPath, forgeDir, repoRoot, json: true },
      { trackerOverride: trackerA },
    ),
    runOrchestrateAmendRoadmap(
      { payloadPath: payloadB, forgeDir, repoRoot, json: true },
      { trackerOverride: trackerB },
    ),
  ]);

  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  const { parsed } = loadPhasesFile(repoRoot);
  const allIds = parsed.phases.flatMap((p) => p.tasks.map((x) => x.id));
  assert.ok(allIds.includes('P2-T03'), `P2-T03 missing from ${allIds.join(',')}`);
  assert.ok(allIds.includes('P3-T02'), `P3-T02 missing from ${allIds.join(',')}`);
});

test('a live held phases-write lock makes the inner pull fail (retriable; journal resumes)', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  // Shrink the lock retry budget: the default 5s worst-case wait starves the
  // node:test child-process reporter (its IPC rides the captured stdout).
  process.env.FORGE_PHASES_LOCK_RETRIES = '2';
  process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS = '10';
  t.after(() => {
    delete process.env.FORGE_PHASES_LOCK_RETRIES;
    delete process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS;
  });

  // Simulate another in-flight writer from THIS process: alive pid + fresh
  // timestamp → not stealable; the pull retries, times out, amend fails
  // retriable at the reconcile step.
  const lockPath = join(forgeDir, 'orchestrator', 'global', 'phases-write.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
    'utf8',
  );
  t.after(() => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  });

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(result.exitCode, 1);
  const out = lastJson(buf);
  assert.equal(out.error.code, 'RECONCILE_FAILED');
  assert.match(out.error.message, /PHASES_LOCKED|write lock/);
});

test('lock ownership: late release after an age-steal must NOT remove the successor lock', async (t) => {
  captureStdout(t);
  const { repoRoot } = setupRepo();

  const lock = await acquirePhasesWriteLock(repoRoot);
  // Simulate an age-steal + successor acquire: the pathname now carries a
  // DIFFERENT owner's lock.
  const lockPath = join(repoRoot, '.forge', 'orchestrator', 'global', 'phases-write.lock');
  const successor = JSON.stringify({
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    token: 'successor-token',
  });
  writeFileSync(lockPath, successor, 'utf8');

  // The original holder's release must be a no-op — pathname unlink without
  // ownership proof was the Codex round-3 block.
  lock.release();
  assert.equal(readFileSync(lockPath, 'utf8'), successor);
  unlinkSync(lockPath);
});

test('lock ownership: normal release removes own lock', async (t) => {
  captureStdout(t);
  const { repoRoot } = setupRepo();
  const lockPath = join(repoRoot, '.forge', 'orchestrator', 'global', 'phases-write.lock');

  const lock = await acquirePhasesWriteLock(repoRoot);
  assert.equal(existsSync(lockPath), true);
  lock.release();
  assert.equal(existsSync(lockPath), false);
});

test('lock validity window: past it, release leaves the lock and assertFresh throws', async (t) => {
  captureStdout(t);
  const { repoRoot } = setupRepo();
  const lockPath = join(repoRoot, '.forge', 'orchestrator', 'global', 'phases-write.lock');

  // 100ms staleness → 80ms safe window. A holder that outlives it must not
  // touch the pathname (age-steal owns cleanup) and must refuse to write.
  process.env.FORGE_PHASES_LOCK_STALE_MS = '100';
  t.after(() => {
    delete process.env.FORGE_PHASES_LOCK_STALE_MS;
    try {
      unlinkSync(lockPath);
    } catch {
      /* gone */
    }
  });

  const lock = await acquirePhasesWriteLock(repoRoot);
  await new Promise((r) => setTimeout(r, 120));
  assert.throws(() => lock.assertFresh(), /validity window/);
  lock.release();
  assert.equal(existsSync(lockPath), true); // left for age-steal, not unlinked
});

test('lock body is stamped per attempt: a slow acquisition is not instantly stealable', async (t) => {
  captureStdout(t);
  const { repoRoot } = setupRepo();
  const lockPath = join(repoRoot, '.forge', 'orchestrator', 'global', 'phases-write.lock');

  process.env.FORGE_PHASES_LOCK_STALE_MS = '100';
  process.env.FORGE_PHASES_LOCK_RETRIES = '50';
  process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS = '10';
  t.after(() => {
    delete process.env.FORGE_PHASES_LOCK_STALE_MS;
    delete process.env.FORGE_PHASES_LOCK_RETRIES;
    delete process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS;
    try {
      unlinkSync(lockPath);
    } catch {
      /* gone */
    }
  });

  // A live blocker occupies the lock; it ages past the 100ms stale horizon,
  // gets stolen, and the waiter finally acquires — well after loop start.
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
    'utf8',
  );

  const lock = await acquirePhasesWriteLock(repoRoot);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `acquisition should have waited past the stale horizon (took ${elapsed}ms)`);

  // The Codex round-5 block: a body stamped before the retry loop would now
  // be ≥100ms old — instantly stealable while assertFresh() still passes.
  // Per-attempt stamping means the on-disk acquired_at is from the WINNING
  // attempt, comfortably inside the 80ms safe window.
  const onDisk = JSON.parse(readFileSync(lockPath, 'utf8')) as { acquired_at: string };
  const bodyAge = Date.now() - Date.parse(onDisk.acquired_at);
  assert.ok(bodyAge < 80, `on-disk acquired_at must be from the winning attempt (age ${bodyAge}ms)`);
  lock.assertFresh(); // must not throw
  lock.release();
  assert.equal(existsSync(lockPath), false);
});

test('stale takeover is serialized: a live steal-mutex blocks the steal', async (t) => {
  captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  process.env.FORGE_PHASES_LOCK_RETRIES = '3';
  process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS = '10';
  t.after(() => {
    delete process.env.FORGE_PHASES_LOCK_RETRIES;
    delete process.env.FORGE_PHASES_LOCK_RETRY_DELAY_MS;
  });

  const lockDir = join(forgeDir, 'orchestrator', 'global');
  mkdirSync(lockDir, { recursive: true });
  const stale = JSON.stringify({ pid: 999999, acquired_at: '2020-01-01T00:00:00.000Z' });
  writeFileSync(join(lockDir, 'phases-write.lock'), stale, 'utf8');
  // Another contender is mid-takeover (live pid, fresh timestamp) — our
  // steal must defer, and with the lock never freed the amend fails retriable.
  const liveSteal = JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() });
  writeFileSync(join(lockDir, 'phases-write.lock.steal'), liveSteal, 'utf8');
  t.after(() => {
    for (const f of ['phases-write.lock', 'phases-write.lock.steal']) {
      try {
        unlinkSync(join(lockDir, f));
      } catch {
        /* gone */
      }
    }
  });

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(result.exitCode, 1);
  // The stale main lock was NOT stolen while the steal-mutex was held.
  assert.equal(readFileSync(join(lockDir, 'phases-write.lock'), 'utf8'), stale);
});

test('a stale phases-write lock (dead holder) is stolen and the amend completes', async (t) => {
  captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  const lockPath = join(forgeDir, 'orchestrator', 'global', 'phases-write.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  // pid 999999 is beyond macOS/Linux default pid ranges → dead holder.
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, acquired_at: '2020-01-01T00:00:00.000Z' }),
    'utf8',
  );

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(result.exitCode, 0);
});

// ── drift warnings ───────────────────────────────────────────────────────────

test('drift warnings list active attempts after a successful amend', async (t) => {
  const buf = captureStdout(t);
  const { repoRoot, forgeDir, payloadPath } = setupRepo();

  // Seed two task states: one active (running), one terminal (shipped).
  const stateDir = join(forgeDir, 'orchestrator', 'tasks');
  const mkState = (taskId: string, state: string) => {
    mkdirSync(join(stateDir, taskId), { recursive: true });
    writeFileSync(
      join(stateDir, taskId, 'state.json'),
      JSON.stringify({
        version: 1,
        task_id: taskId,
        state,
        state_version: 1,
        attempt_count: 1,
        current_attempt_id: '019eb598-0000-7000-8000-000000000000',
        updated_at: '2026-06-11T00:00:00.000Z',
        updated_by: { run_id: 'r', claim_id: 'c', generation: 0 },
      }),
      'utf8',
    );
  };
  mkState('FORGE-93', 'running');
  mkState('FORGE-95', 'shipped');

  const result = await runOrchestrateAmendRoadmap(
    { payloadPath, forgeDir, repoRoot, json: true },
    { trackerOverride: fakeTracker() },
  );
  assert.equal(result.exitCode, 0);
  const out = lastJson(buf);
  assert.deepEqual(
    out.data.drift_warnings.map((d: { task_id: string }) => d.task_id),
    ['FORGE-93'],
  );
});
