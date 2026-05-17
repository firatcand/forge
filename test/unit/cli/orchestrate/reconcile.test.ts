import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
}): Tracker {
  const updates: { id: string; body: string }[] = [];
  const t: Tracker = {
    type: 'linear',
    listActiveIssues: opts.list,
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

test('runOrchestrateReconcile — exits 4 when listActiveIssues throws', async () => {
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
