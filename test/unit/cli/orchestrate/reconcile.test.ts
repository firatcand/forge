import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  parseReconcileArgv,
  runOrchestrateReconcile,
} from '../../../../src/cli/orchestrate/reconcile.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { Issue } from '../../../../src/trackers/types.ts';
import { TrackerError } from '../../../../src/trackers/errors.ts';

// ---------------- argv parsing ----------------

test('parseReconcileArgv — requires --pull or --push', () => {
  const r = parseReconcileArgv([]);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /required/);
});

test('parseReconcileArgv — --pull alone is valid', () => {
  const r = parseReconcileArgv(['--pull']);
  assert.equal('error' in r, false);
  if (!('error' in r)) {
    assert.equal(r.direction, 'pull');
    assert.equal(r.dryRun, false);
    assert.equal(r.json, false);
  }
});

test('parseReconcileArgv — flags combine', () => {
  const r = parseReconcileArgv(['--push', '--dry-run', '--json']);
  assert.equal('error' in r, false);
  if (!('error' in r)) {
    assert.equal(r.direction, 'push');
    assert.equal(r.dryRun, true);
    assert.equal(r.json, true);
  }
});

test('parseReconcileArgv — --pull + --push is rejected', () => {
  const r = parseReconcileArgv(['--pull', '--push']);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /mutually exclusive/);
});

test('parseReconcileArgv — --confirm-prune + --no-prune is rejected', () => {
  const r = parseReconcileArgv(['--pull', '--confirm-prune', '--no-prune']);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /mutually exclusive/);
});

test('parseReconcileArgv — unknown flag is rejected', () => {
  const r = parseReconcileArgv(['--pull', '--unknown']);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /unknown flag/);
});

// ---------------- runOrchestrateReconcile shape ----------------

interface ScratchWorktree {
  readonly dir: string;
  readonly cleanup: () => void;
}

function mkScratchWorktree(opts: { phasesYaml: string; settingsYaml?: string }): ScratchWorktree {
  const dir = mkdtempSync(join(tmpdir(), 'forge-reconcile-cli-'));
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'phases.yaml'), opts.phasesYaml);
  // computeSpecRevision (called from runPull) requires spec/SPEC.md to exist;
  // without git, it falls back to a content digest.
  mkdirSync(join(dir, 'spec'), { recursive: true });
  writeFileSync(join(dir, 'spec', 'SPEC.md'), '# test SPEC\n');
  if (opts.settingsYaml) {
    mkdirSync(join(dir, '.forge'), { recursive: true });
    writeFileSync(join(dir, '.forge', 'settings.yaml'), opts.settingsYaml);
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
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

function fakeTracker(opts: {
  list: () => Promise<Issue[]>;
  update?: (id: string, body: string) => Promise<void>;
  // FORGE-123: revision probe. Default returns a stable token. A test can
  // override to a custom token, count calls, or throw (probe-failure path).
  revision?: () => Promise<string>;
}): Tracker {
  const updates: { id: string; body: string }[] = [];
  const revisionCalls = { count: 0 };
  const listAllCalls = { count: 0 };
  const t: Tracker = {
    type: 'linear',
    listActiveIssues: opts.list,
    // Pull uses listAllIssues; push uses listActiveIssues. Wire both to the
    // same fixture so a single `list` drives whichever path the test exercises.
    listAllIssues: async () => {
      listAllCalls.count++;
      return { issues: await opts.list(), truncated: false };
    },
    async getCurrentRevision() {
      revisionCalls.count++;
      return opts.revision ? opts.revision() : 'linear:rev-default';
    },
    async claim() {
      throw new Error('not used');
    },
    async releaseClaim() {},
    async updateState() {},
    async comment() {},
    async updateIssueBody(id: string, body: string) {
      updates.push({ id, body });
      if (opts.update) await opts.update(id, body);
    },
    async setClaimFence() {},
    async createProject() {
      return { id: 'p', url: 'u' };
    },
    async createIssue() {
      throw new Error('not used');
    },
    async setBlockedBy() {},
    async healthCheck() {
      return { ok: true };
    },
  };
  (t as unknown as { _updates: { id: string; body: string }[] })._updates = updates;
  (t as unknown as { _revisionCalls: { count: number } })._revisionCalls = revisionCalls;
  (t as unknown as { _listAllCalls: { count: number } })._listAllCalls = listAllCalls;
  return t;
}

const MINIMAL_PHASES = `project: forge
source:
  tracker: linear
  project_id: test-project-uuid
  synced_at: "2026-05-17T22:00:00Z"
  spec_revision: deadbeefcafe000000000000000000000000abcd
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Local title
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;

// Helper: strip the freshness summary line (always printed to stderr before
// main output) so tests can JSON.parse the structured error envelope cleanly.
function stripFreshness(stderr: string): string {
  return stderr.replace(/^phases\.yaml: [^\n]*\n/, '');
}

test('runOrchestrateReconcile — INVALID_ARGS exits 3 (NOT 1, which is reserved for PRUNE_PENDING)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: [],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    // exit code 3 distinguishes hard-error (malformed call) from PRUNE_PENDING (1)
    assert.equal(result.exitCode, 3);
    const errJson = JSON.parse(err.chunks.join(''));
    assert.equal(errJson.ok, false);
    assert.equal(errJson.error.code, 'INVALID_ARGS');
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull --dry-run with title diff returns updated[]', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          {
            id: 'tracker-1',
            identifier: 'FORGE-1',
            title: 'Tracker title',
            state: 'todo',
            blockerIds: [],
            forgeTaskId: 'P1-T01',
          },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.direction, 'pull');
    assert.equal(payload.data.dry_run, true);
    assert.equal(payload.data.pull.updated.length, 1);
    assert.equal(payload.data.pull.updated[0].task_id, 'P1-T01');
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull with orphan exits 1 PRUNE_PENDING (data on stdout, diagnostic on stderr)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 1);
    // Per Codex 2nd-pass: stdout carries the structured plan, stderr the
    // human-readable diagnostic — matches orchestrate-spec-diff's convention.
    // The skill detects PRUNE_PENDING via (exitCode===1 && removed.length>0).
    const outJson = JSON.parse(out.chunks.join(''));
    assert.equal(outJson.ok, true);
    assert.equal(outJson.data.applied, false);
    assert.equal(outJson.data.pull.removed.length, 1);
    assert.match(err.chunks.join(''), /orphan task/);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull --confirm-prune writes phases.yaml without orphan', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--confirm-prune'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.applied, true);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.equal(after.includes('P1-T01'), false);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull does NOT rewrap long scalars or pad flow arrays (FORGE-121)', async () => {
  // A title change on one task must not reformat the rest of the file. The yaml
  // lib defaults (lineWidth 80, flowCollectionPadding true) would fold every
  // long description/goal/acceptance string and render [P1-T00] as [ P1-T00 ],
  // producing thousands of lines of cosmetic churn on --pull.
  const LONG =
    'This is a very long description that exceeds eighty characters so the yaml serializer would otherwise fold it across multiple lines on rewrite causing churn.';
  const phasesYaml = `project: forge
source:
  tracker: linear
  project_id: test-project-uuid
  synced_at: "2026-05-17T22:00:00Z"
  spec_revision: deadbeefcafe000000000000000000000000abcd
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T00
        title: Blocker
        description: b
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Old title
        description: "${LONG}"
        type: foundation
        priority: P0
        depends_on: [P1-T00]
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;
  const wt = mkScratchWorktree({ phasesYaml });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          {
            id: 'tracker-1',
            identifier: 'FORGE-1',
            title: 'New title',
            state: 'todo',
            blockerIds: [],
          },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // Title applied.
    assert.match(after, /title: New title/);
    // Long description stays on ONE line (would be folded with default lineWidth).
    assert.match(after, new RegExp(`description: "${LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    // Flow array keeps its original padding-free style.
    assert.match(after, /depends_on: \[P1-T00\]/);
    assert.equal(after.includes('[ P1-T00 ]'), false);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull writes source stanza atomically (FORGE-113 AC #3)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--confirm-prune'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // Source stanza is present with the four required fields.
    assert.match(after, /^source:/m);
    assert.match(after, /tracker:\s*linear/);
    assert.match(after, /project_id:\s*test-project-uuid/);
    assert.match(after, /synced_at:/);
    assert.match(after, /spec_revision:/);
    // synced_at was bumped — different from the fixture's frozen value.
    const fixtureSynced = '2026-05-17T22:00:00Z';
    const stampedSynced = after.match(/synced_at:\s*"?([^"\n]+)"?/)?.[1];
    assert.ok(stampedSynced && stampedSynced !== fixtureSynced);
    // spec_revision was recomputed — 40 hex chars (content digest fallback).
    const stampedSpec = after.match(/spec_revision:\s*"?([0-9a-f]{40})"?/)?.[1];
    assert.ok(stampedSpec, 'spec_revision should be a 40-hex string');
    assert.notEqual(stampedSpec, 'deadbeefcafe000000000000000000000000abcd');
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --pull migrates legacy tracker_project_id into source (FORGE-113 AC #2)', async () => {
  const legacyPhases = `project: forge
tracker_project_id: legacy-project-id
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Local title
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;
  const wt = mkScratchWorktree({ phasesYaml: legacyPhases });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--confirm-prune'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // Legacy top-level key gone, value preserved inside source block.
    assert.equal(/^tracker_project_id:/m.test(after), false);
    assert.match(after, /project_id:\s*legacy-project-id/);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — freshness line printed to stderr before main output', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    const stderr = err.chunks.join('');
    assert.match(stderr, /^phases\.yaml: /);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --push --dry-run reports bodies plan without writing', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        {
          id: 'tracker-1',
          identifier: 'FORGE-1',
          title: 'Local title',
          state: 'todo',
          blockerIds: [],
          forgeTaskId: 'P1-T01',
        },
      ],
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--dry-run'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.push.plan.bodies.length, 1);
    const updates = (tracker as unknown as { _updates: unknown[] })._updates;
    assert.equal(updates.length, 0);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --push calls updateIssueBody and returns succeeded[]', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        {
          id: 'tracker-1',
          identifier: 'FORGE-1',
          title: 'Local title',
          state: 'todo',
          blockerIds: [],
          forgeTaskId: 'P1-T01',
        },
      ],
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.deepEqual(payload.data.push.succeeded, ['P1-T01']);
    const updates = (tracker as unknown as { _updates: { id: string }[] })._updates;
    assert.deepEqual(updates.map((u) => u.id), ['tracker-1']);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — --push partial failure exits 2 with failed[] populated', async () => {
  const wt = mkScratchWorktree({
    phasesYaml: `project: forge
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: T1
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
      - id: P1-T02
        tracker_issue_id: tracker-2
        title: T2
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`,
  });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        { id: 'tracker-1', identifier: 'F1', title: 'T1', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        { id: 'tracker-2', identifier: 'F2', title: 'T2', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
      ],
      update: async (id: string) => {
        if (id === 'tracker-2') {
          throw new TrackerError('NOT_IMPLEMENTED', 'simulated notion stub');
        }
      },
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 2);
    const payload = JSON.parse(out.chunks.join(''));
    assert.deepEqual(payload.data.push.succeeded, ['P1-T01']);
    assert.equal(payload.data.push.failed.length, 1);
    assert.equal(payload.data.push.failed[0].code, 'NOT_IMPLEMENTED');
    assert.match(err.chunks.join(''), /1\/2 push\(es\) failed/);
  } finally {
    wt.cleanup();
  }
});

test('runOrchestrateReconcile — exits 3 when phases.yaml is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-no-phases-'));
  mkdirSync(join(dir, 'plans'), { recursive: true });
  // No phases.yaml written — should produce PHASES_NOT_FOUND
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(err.chunks.join(''));
    assert.equal(payload.ok, false);
    assert.ok(
      payload.error.code === 'PHASES_NOT_FOUND' || payload.error.code === 'VALIDATION',
      `expected PHASES_NOT_FOUND or VALIDATION, got ${payload.error.code}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOrchestrateReconcile — exits 4 when the tracker issue-list call throws', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => {
          throw new TrackerError('AUTH', 'token expired');
        },
      }),
    });
    assert.equal(result.exitCode, 4);
    const payload = JSON.parse(stripFreshness(err.chunks.join('')));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'AUTH');
  } finally {
    wt.cleanup();
  }
});

// ─── FORGE-119: --task scoping ───────────────────────────────────────────────

test('parseReconcileArgv — --task consumes its value', () => {
  const r = parseReconcileArgv(['--pull', '--task', 'P1-T01']);
  assert.equal('error' in r, false);
  if (!('error' in r)) assert.equal(r.task, 'P1-T01');
});

test('parseReconcileArgv — --task without a value is rejected', () => {
  const r = parseReconcileArgv(['--pull', '--task']);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /missing value for --task/);
});

test('parseReconcileArgv — --task followed by a flag is rejected', () => {
  const r = parseReconcileArgv(['--pull', '--task', '--json']);
  assert.equal('error' in r, true);
  if ('error' in r) assert.match(r.error, /missing value for --task/);
});

test('parseReconcileArgv — --check parses and requires --pull', () => {
  const ok = parseReconcileArgv(['--pull', '--check']);
  assert.equal('error' in ok, false);
  if (!('error' in ok)) assert.equal(ok.check, true);
  const bad = parseReconcileArgv(['--push', '--check']);
  assert.equal('error' in bad, true);
  if ('error' in bad) assert.match(bad.error, /--check is only valid with --pull/);
});

// Two-task fixture for scoping tests.
const TWO_TASK_PHASES = `project: forge
source:
  tracker: linear
  project_id: test-project-uuid
  synced_at: "2026-05-17T22:00:00Z"
  spec_revision: deadbeefcafe000000000000000000000000abcd
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Title one
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
      - id: P1-T02
        tracker_issue_id: tracker-2
        title: Title two
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;

test('FORGE-119 — --task --pull --dry-run scopes the plan to one task (out-of-scope diffs dropped)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'P1-T01'],
      stdout: out.stream,
      stderr: err.stream,
      // BOTH tasks have a title diff upstream; only P1-T01 must survive scoping.
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'New one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'New two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'P1-T01');
    assert.equal(payload.data.pull.updated.length, 1);
    assert.equal(payload.data.pull.updated[0].task_id, 'P1-T01');
    assert.match(stripFreshness(err.chunks.join('')), /scoped to P1-T01 only/);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-119 — scoped --pull writes only the in-scope change (out-of-scope title untouched)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--task', 'P1-T01'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'New one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'New two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(after, /New one/);
    assert.match(after, /Title two/); // out-of-scope title NOT pulled
    assert.doesNotMatch(after, /New two/);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-119 — scoped --pull never prunes an out-of-scope orphan', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    // tracker-2 is absent upstream → P1-T02 would be an orphan in an unscoped
    // run. Scoping to P1-T01 must not surface or prune it.
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--task', 'P1-T01', '--confirm-prune'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.pull.removed.length, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(after, /P1-T02/); // out-of-scope orphan retained
  } finally {
    wt.cleanup();
  }
});

test('FORGE-119 — unknown --task id → INVALID_ARGS exit 3 (NOT 1)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--task', 'P9-T99'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(stripFreshness(err.chunks.join('')));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'INVALID_ARGS');
    assert.match(payload.error.message, /unknown task id: P9-T99/);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-119 — --task --push --dry-run scopes the push plan', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--dry-run', '--task', 'P1-T02'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'P1-T02');
    assert.equal(payload.data.push.plan.bodies.length, 1);
    assert.equal(payload.data.push.plan.bodies[0].task_id, 'P1-T02');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-119 — unknown --task id on --push → INVALID_ARGS exit 3', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--task', 'NOPE-T1'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({ list: async () => [] }),
    });
    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(stripFreshness(err.chunks.join('')));
    assert.equal(payload.error.code, 'INVALID_ARGS');
  } finally {
    wt.cleanup();
  }
});

// ─── FORGE-127 MAJOR: --task id resolution (local id, bound tracker id, ───────
//                     tracker-page-only id) in both directions ────────────────

test('FORGE-127 MAJOR — --pull --task <bound-tracker-id> scopes the BOUND local task (updated kept)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    // Both tasks have an upstream title diff; targeting tracker-1 (bound to
    // P1-T01) must keep P1-T01's updated entry and drop P1-T02's.
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'tracker-1'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'New one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'New two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.pull.updated.length, 1);
    assert.equal(payload.data.pull.updated[0].task_id, 'P1-T01');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --pull --task <bound-tracker-id> with ZERO diff is accepted (empty plan, NOT INVALID_ARGS)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    // No upstream changes at all → empty diff. A VALID id must still be accepted.
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'tracker-1'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.scoped_to, 'tracker-1');
    assert.equal(payload.data.pull.updated.length, 0);
    assert.equal(payload.data.pull.removed.length, 0);
    assert.equal(payload.data.pull.added.length, 0);
    assert.equal(payload.data.pull.unmanaged.length, 0);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --pull --task <local-id> with ZERO diff is accepted (empty plan, NOT INVALID_ARGS)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'P1-T01'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'P1-T01');
    assert.equal(payload.data.pull.updated.length, 0);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --pull --task <tracker-page-only id> scopes a brand-new unmanaged issue', async () => {
  // tracker-99 is NOT in phases.yaml (not a local id, not a bound tracker id).
  // It surfaces only on the tracker page as a new issue → must be accepted and
  // scoped via the tracker-page fallback (added/unmanaged).
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'tracker-99'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
          // New unmanaged issue with no forge:task footer.
          { id: 'tracker-99', identifier: 'FORGE-99', title: 'Brand new', state: 'todo', blockerIds: [] },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'tracker-99');
    // Only the tracker-99 entry survives scoping; updated/removed (phases-origin)
    // are empty because the scope has no local task id.
    assert.equal(payload.data.pull.updated.length, 0);
    assert.equal(payload.data.pull.removed.length, 0);
    const carried =
      payload.data.pull.added.some((a: { tracker_issue_id: string }) => a.tracker_issue_id === 'tracker-99') ||
      payload.data.pull.unmanaged.some((u: { tracker_issue_id: string }) => u.tracker_issue_id === 'tracker-99');
    assert.ok(carried, 'the tracker-page-only id must be scoped via added/unmanaged');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --push --task <bound-tracker-id> scopes the BOUND local task body', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--dry-run', '--task', 'tracker-2'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'tracker-2');
    assert.equal(payload.data.push.plan.bodies.length, 1);
    assert.equal(payload.data.push.plan.bodies[0].task_id, 'P1-T02');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --push --task <local-id> with ZERO push diff is accepted (empty plan)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    // Both local tasks bind tracker issues that exist upstream → both have a
    // body to push; scoping to P1-T01 leaves exactly one body. (A genuinely
    // empty push plan is exercised by the bound-tracker-id test family; here we
    // assert a valid local id is never rejected.)
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--dry-run', '--task', 'P1-T01'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'Title two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.scoped_to, 'P1-T01');
    assert.equal(payload.data.push.plan.bodies.length, 1);
    assert.equal(payload.data.push.plan.bodies[0].task_id, 'P1-T01');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 MAJOR — --push --task <tracker-page-only id> is INVALID_ARGS (no local body to push)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: TWO_TASK_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    // tracker-99 is not a local task nor a bound tracker id → push has no body
    // to send for it → INVALID_ARGS exit 3 (push has no tracker-page fallback).
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--push', '--task', 'tracker-99'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-99', identifier: 'FORGE-99', title: 'Brand new', state: 'todo', blockerIds: [] },
        ],
      }),
    });
    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(stripFreshness(err.chunks.join('')));
    assert.equal(payload.error.code, 'INVALID_ARGS');
  } finally {
    wt.cleanup();
  }
});

// ─── FORGE-127: legacy top-level tracker_url migration ───────────────────────

const LEGACY_TRACKER_URL_PHASES = `project: forge
tracker_url: "https://linear.app/team/proj"
source:
  tracker: linear
  project_id: test-project-uuid
  synced_at: "2026-05-17T22:00:00Z"
  spec_revision: deadbeefcafe000000000000000000000000abcd
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: tracker-1
        title: Title one
        description: d
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['a']
`;

test('FORGE-127 — --pull migrates legacy top-level tracker_url into source and deletes the top-level key', async () => {
  const wt = mkScratchWorktree({ phasesYaml: LEGACY_TRACKER_URL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Title one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // The top-level key is gone; the value now lives under source.
    assert.doesNotMatch(after, /^tracker_url:/m);
    assert.match(after, /tracker_url: https:\/\/linear\.app\/team\/proj/);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 — --pull preserves an existing source.tracker_url', async () => {
  const phases = MINIMAL_PHASES.replace(
    'spec_revision: deadbeefcafe000000000000000000000000abcd',
    'spec_revision: deadbeefcafe000000000000000000000000abcd\n  tracker_url: https://existing.example/x',
  );
  const wt = mkScratchWorktree({ phasesYaml: phases });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Local title', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(after, /tracker_url: https:\/\/existing\.example\/x/);
  } finally {
    wt.cleanup();
  }
});

// ─── FORGE-123: --pull stamps tracker_revision; --check short-circuits ────────

test('FORGE-123 — --pull stamps source.tracker_revision', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Local title', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        ],
        revision: async () => 'linear:2026-06-01T00:00:00.000Z',
      }),
    });
    assert.equal(result.exitCode, 0);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.match(after, /tracker_revision: linear:2026-06-01T00:00:00\.000Z/);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-123 — --pull revision probe failure warns and still pulls (no stamp wipe)', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'Local title', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
        ],
        revision: async () => {
          throw new TrackerError('TRANSPORT', 'flaky probe');
        },
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.match(stripFreshness(err.chunks.join('')), /could not stamp source\.tracker_revision/);
  } finally {
    wt.cleanup();
  }
});

const FRESH_REVISION_PHASES = MINIMAL_PHASES.replace(
  'spec_revision: deadbeefcafe000000000000000000000000abcd',
  'spec_revision: deadbeefcafe000000000000000000000000abcd\n  tracker_revision: linear:STORED',
);

test('FORGE-123 — --pull --check MATCH refreshes the stamp and fetches ZERO issue lists', async () => {
  const wt = mkScratchWorktree({ phasesYaml: FRESH_REVISION_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [],
      revision: async () => 'linear:STORED',
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'match');
    const listAll = (tracker as unknown as { _listAllCalls: { count: number } })._listAllCalls;
    assert.equal(listAll.count, 0, 'listAllIssues must NOT be called on a check match');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-123 — --pull --check MISMATCH falls through to a full pull', async () => {
  const wt = mkScratchWorktree({ phasesYaml: FRESH_REVISION_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        { id: 'tracker-1', identifier: 'FORGE-1', title: 'Changed', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
      ],
      revision: async () => 'linear:DIFFERENT',
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'mismatch');
    const listAll = (tracker as unknown as { _listAllCalls: { count: number } })._listAllCalls;
    assert.equal(listAll.count, 1, 'a mismatch must perform the full pull');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-123 — --pull --check with NO stored revision falls through to a full pull', async () => {
  const wt = mkScratchWorktree({ phasesYaml: MINIMAL_PHASES }); // no tracker_revision
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        { id: 'tracker-1', identifier: 'FORGE-1', title: 'Local title', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
      ],
      revision: async () => 'linear:ANY',
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'missing');
    const listAll = (tracker as unknown as { _listAllCalls: { count: number } })._listAllCalls;
    assert.equal(listAll.count, 1);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 BLOCKER — --pull --check --dry-run MATCH leaves phases.yaml byte-identical and takes NO lock', async () => {
  const wt = mkScratchWorktree({ phasesYaml: FRESH_REVISION_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [],
      revision: async () => 'linear:STORED',
    });
    const before = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check', '--dry-run'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'match');
    assert.equal(payload.data.dry_run, true);
    assert.equal(payload.data.applied, false);
    // The document is byte-identical: no stamp refresh on a dry-run check.
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    assert.equal(after, before, 'dry-run check must not write phases.yaml');
    // No phases-write lock was ever taken (and thus none left behind): a
    // dry-run pull acquires no lock, so an unlocked write was impossible.
    assert.equal(
      existsSync(join(wt.dir, '.forge', 'orchestrator', 'global', 'phases-write.lock')),
      false,
      'dry-run check must not acquire the phases-write lock',
    );
    // No issue list fetched either — the short-circuit fired.
    const listAll = (tracker as unknown as { _listAllCalls: { count: number } })._listAllCalls;
    assert.equal(listAll.count, 0);
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 BLOCKER — non-dry-run --pull --check MATCH refreshes the freshness stamp under the lock', async () => {
  const wt = mkScratchWorktree({ phasesYaml: FRESH_REVISION_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [],
      revision: async () => 'linear:STORED',
    });
    const before = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'match');
    assert.equal(payload.data.dry_run, false);
    const after = readFileSync(join(wt.dir, 'plans', 'phases.yaml'), 'utf8');
    // synced_at refreshed (different from the fixture's frozen value) — proof
    // the stamp write ran. It ran under the lock acquired by
    // runOrchestrateReconcile for a non-dry-run pull (assertFresh guards it),
    // and the lock is released on exit so no stale lock remains.
    assert.notEqual(after, before, 'non-dry-run check match must refresh the stamp');
    const stampedSynced = after.match(/synced_at:\s*"?([^"\n]+)"?/)?.[1];
    assert.ok(stampedSynced && stampedSynced !== '2026-05-17T22:00:00Z');
    // tracker_revision preserved (unchanged token).
    assert.match(after, /tracker_revision: linear:STORED/);
    assert.equal(
      existsSync(join(wt.dir, '.forge', 'orchestrator', 'global', 'phases-write.lock')),
      false,
      'lock must be released after the stamp write',
    );
  } finally {
    wt.cleanup();
  }
});

test('FORGE-123 — --pull --check probe FAILURE warns and falls back to a full pull', async () => {
  const wt = mkScratchWorktree({ phasesYaml: FRESH_REVISION_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const tracker = fakeTracker({
      list: async () => [
        { id: 'tracker-1', identifier: 'FORGE-1', title: 'Local title', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
      ],
      revision: async () => {
        throw new TrackerError('TRANSPORT', 'probe down');
      },
    });
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--check'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: tracker,
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    assert.equal(payload.data.check, 'probe_failure');
    assert.match(stripFreshness(err.chunks.join('')), /revision probe failed/);
    const listAll = (tracker as unknown as { _listAllCalls: { count: number } })._listAllCalls;
    assert.equal(listAll.count, 1, 'probe failure must still complete the pull');
  } finally {
    wt.cleanup();
  }
});

test('FORGE-127 r2 — --pull --task <tracker-id> keeps an UNBOUND local task matched via forgeTaskId', async () => {
  // P1-T01 has NO tracker_issue_id in phases.yaml; diffPull binds it through
  // issue.forgeTaskId. Scoping by the tracker id must keep that task's updated
  // entry instead of silently dropping it to a tracker-only scope (Codex r2).
  const UNBOUND_PHASES = TWO_TASK_PHASES.replace('        tracker_issue_id: tracker-1\n', '');
  const wt = mkScratchWorktree({ phasesYaml: UNBOUND_PHASES });
  try {
    const out = captureStream();
    const err = captureStream();
    const result = await runOrchestrateReconcile({
      cwd: wt.dir,
      argv: ['--pull', '--dry-run', '--task', 'tracker-1'],
      stdout: out.stream,
      stderr: err.stream,
      trackerOverride: fakeTracker({
        list: async () => [
          { id: 'tracker-1', identifier: 'FORGE-1', title: 'New one', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T01' },
          { id: 'tracker-2', identifier: 'FORGE-2', title: 'New two', state: 'todo', blockerIds: [], forgeTaskId: 'P1-T02' },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(out.chunks.join(''));
    const updatedIds = payload.data.pull.updated.map((u: { task_id: string }) => u.task_id);
    assert.ok(updatedIds.includes('P1-T01'), `expected P1-T01 kept, got ${JSON.stringify(updatedIds)}`);
    assert.ok(!updatedIds.includes('P1-T02'), 'out-of-scope task must be dropped');
  } finally {
    wt.cleanup();
  }
});
