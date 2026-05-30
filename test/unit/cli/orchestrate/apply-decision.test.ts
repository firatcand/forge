import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runOrchestrateApplyDecision,
  type ApplyDecisionDeps,
} from '../../../../src/cli/orchestrate/apply-decision.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { TrackerType } from '../../../../src/trackers/types.ts';
import type { ApplyJournal } from '../../../../src/schemas/apply-journal.ts';

const SLUG = 'switch-tracker-transport';

function captureStdout(t: { after: (fn: () => void) => void }): string[] {
  const buf: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    buf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return buf;
}

function lastJson(buf: string[]): { ok: boolean; data?: any; error?: any } {
  const lines = buf.join('').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

interface FakeTracker extends Tracker {
  readonly bodyCalls: { id: string; body: string }[];
}

// Minimal Tracker for the override seam: only `type` + `updateIssueBody` matter
// to apply-decision; the rest throw so an accidental call is loud.
function fakeTracker(opts: { type?: TrackerType; failOnCall?: number } = {}): FakeTracker {
  const bodyCalls: { id: string; body: string }[] = [];
  let calls = 0;
  const notUsed = (m: string) => () => Promise.reject(new Error(`fakeTracker.${m} not expected`));
  return {
    type: opts.type ?? 'github',
    bodyCalls,
    async updateIssueBody(id: string, body: string) {
      calls += 1;
      if (opts.failOnCall && calls === opts.failOnCall) {
        throw new Error('simulated tracker failure');
      }
      bodyCalls.push({ id, body });
    },
    listActiveIssues: notUsed('listActiveIssues') as Tracker['listActiveIssues'],
    listAllIssues: notUsed('listAllIssues') as Tracker['listAllIssues'],
    claim: notUsed('claim') as Tracker['claim'],
    releaseClaim: notUsed('releaseClaim') as Tracker['releaseClaim'],
    updateState: notUsed('updateState') as Tracker['updateState'],
    comment: notUsed('comment') as Tracker['comment'],
    createProject: notUsed('createProject') as Tracker['createProject'],
    createIssue: notUsed('createIssue') as Tracker['createIssue'],
    setBlockedBy: notUsed('setBlockedBy') as Tracker['setBlockedBy'],
    healthCheck: notUsed('healthCheck') as Tracker['healthCheck'],
  };
}

const ADR = `---
slug: ${SLUG}
date: 2026-05-30
status: accepted
affected_spec_sections:
  - "spec/SPEC.md §CLI surface"
affected_prd_sections:
  - "spec/PRD.md §Feature 2"
affected_phases_tasks:
  - P2.5-T04
affected_tasks:
  - FORGE-95
---

# Switch tracker transport

## Context
MCP is heavy.

## Decision
Use ntn.
`;

const SPEC = `# SPEC

## CLI surface

old surface

## Other

keep me
`;

const PRD = `# PRD

## Feature 2

old prd
`;

const PHASES = `project: demo
phases:
  - id: phase-2.5
    name: Closed loop
    status: active
    goal: x
    gate_criteria:
      - g
    tasks:
      - id: P2.5-T04
        title: apply-decision
        description: old
        type: backend
        priority: P1
        estimate: M
        owner_type: backend-dev
        acceptance:
          - old AC
`;

interface Repo {
  repoRoot: string;
  forgeDir: string;
  journalPath: string;
  completedPath: string;
  commitMsgPath: string;
  adrPath: string;
  indexPath: string;
  specPath: string;
}

function setupRepo(opts: { adrStatus?: string; journal?: Partial<ApplyJournal>; omitJournal?: boolean } = {}): Repo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-apply-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(join(repoRoot, 'spec', 'decisions'), { recursive: true });
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  const jdir = join(forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal');
  mkdirSync(jdir, { recursive: true });

  writeFileSync(join(repoRoot, 'spec', 'SPEC.md'), SPEC, 'utf8');
  writeFileSync(join(repoRoot, 'spec', 'PRD.md'), PRD, 'utf8');
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), PHASES, 'utf8');
  const adr = opts.adrStatus ? ADR.replace('status: accepted', `status: ${opts.adrStatus}`) : ADR;
  const adrPath = join(repoRoot, 'spec', 'decisions', `2026-05-30-${SLUG}.md`);
  writeFileSync(adrPath, adr, 'utf8');

  const journalPath = join(jdir, `${SLUG}.json`);
  if (!opts.omitJournal) {
    const journal: ApplyJournal = {
      version: 1,
      slug: SLUG,
      started_at: '2026-05-30T00:00:00.000Z',
      spec_sections: [{ ref: 'spec/SPEC.md#cli-surface', new_body: '## CLI surface\n\nNEW SURFACE', status: 'pending' }],
      prd_sections: [{ ref: 'spec/PRD.md#feature-2', new_body: '## Feature 2\n\nNEW PRD', status: 'pending' }],
      phases_tasks: [{ id: 'P2.5-T04', field: 'acceptance', value: ['new AC 1', 'new AC 2'], status: 'pending' }],
      tracker_issues: [{ id: 'FORGE-95', new_body: 'updated body', retries: 0, status: 'pending' }],
      finalize: { commit_msg_written: false, index_appended: false, adr_deleted: false, archived: false },
      ...opts.journal,
    };
    writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
  }

  return {
    repoRoot,
    forgeDir,
    journalPath,
    completedPath: join(jdir, 'completed', `${SLUG}.json`),
    commitMsgPath: join(jdir, `${SLUG}.commit-msg.txt`),
    adrPath,
    indexPath: join(repoRoot, 'spec', 'decisions', 'INDEX.md'),
    specPath: join(repoRoot, 'spec', 'SPEC.md'),
  };
}

function baseArgs(repo: Repo, extra: Record<string, unknown> = {}) {
  return { slug: SLUG, yesAll: false, resume: false, dryRun: false, repoRoot: repo.repoRoot, forgeDir: repo.forgeDir, json: true, ...extra };
}

test('missing journal → MISSING_JOURNAL', async (t) => {
  const repo = setupRepo({ omitJournal: true });
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo));
  const env = lastJson(buf);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'MISSING_JOURNAL');
});

test('non-accepted ADR → ADR_NOT_ACCEPTED, nothing mutated', async (t) => {
  const repo = setupRepo({ adrStatus: 'proposed' });
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker() });
  const env = lastJson(buf);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'ADR_NOT_ACCEPTED');
  assert.equal(readFileSync(repo.specPath, 'utf8'), SPEC); // untouched
});

test('journal missing a declared section → JOURNAL_COVERAGE_MISMATCH', async (t) => {
  const repo = setupRepo({ journal: { spec_sections: [] } });
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker() });
  const env = lastJson(buf);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'JOURNAL_COVERAGE_MISMATCH');
});

test('--dry-run writes nothing', async (t) => {
  const repo = setupRepo();
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo, { dryRun: true }), { trackerOverride: fakeTracker() });
  const env = lastJson(buf);
  assert.equal(env.ok, true);
  assert.equal(env.data.dry_run, true);
  assert.equal(readFileSync(repo.specPath, 'utf8'), SPEC); // untouched
  assert.equal(existsSync(repo.indexPath), false);
  assert.equal(existsSync(repo.commitMsgPath), false);
  assert.equal(existsSync(repo.adrPath), true);
});

test('incapable tracker (notion) → TRACKER_INCAPABLE before any mutation', async (t) => {
  const repo = setupRepo();
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker({ type: 'notion' }) });
  const env = lastJson(buf);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'TRACKER_INCAPABLE');
  // No local artifact was touched.
  assert.equal(readFileSync(repo.specPath, 'utf8'), SPEC);
  assert.equal(existsSync(repo.adrPath), true);
});

test('happy path applies all 4 artifact classes + finalizes', async (t) => {
  const repo = setupRepo();
  const tracker = fakeTracker();
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: tracker });
  const env = lastJson(buf);
  assert.equal(env.ok, true);
  assert.equal(env.data.applied, true);

  // SPEC + PRD rewritten within marker blocks
  const spec = readFileSync(repo.specPath, 'utf8');
  assert.match(spec, /NEW SURFACE/);
  assert.match(spec, /forge:adr-section:cli-surface/);
  assert.match(spec, /## Other/); // adjacent section preserved
  assert.match(readFileSync(join(repo.repoRoot, 'spec', 'PRD.md'), 'utf8'), /NEW PRD/);
  // phases.yaml acceptance amended
  assert.match(readFileSync(join(repo.repoRoot, 'plans', 'phases.yaml'), 'utf8'), /new AC 1/);
  // tracker body pushed
  assert.deepEqual(tracker.bodyCalls, [{ id: 'FORGE-95', body: 'updated body' }]);
  // finalize: commit-msg + INDEX + ADR deleted + journal archived
  assert.match(readFileSync(repo.commitMsgPath, 'utf8'), /## Decision/);
  assert.match(readFileSync(repo.indexPath, 'utf8'), new RegExp(`\`${SLUG}\``));
  assert.equal(existsSync(repo.adrPath), false);
  assert.equal(existsSync(repo.completedPath), true);
  assert.equal(existsSync(repo.journalPath), false);
});

// Codex impl-review #1 + confirmation pass: a non-accepted ADR that still
// exists on disk must be gated regardless of the journal's finalize flags —
// including commit_msg_written=true (a hand-authored journal can't fake its way
// past the gate).
for (const commit_msg_written of [false, true]) {
  test(`non-accepted ADR on disk is gated even when all-applied + commit_msg_written=${commit_msg_written}`, async (t) => {
    const repo = setupRepo({
      adrStatus: 'proposed',
      journal: {
        spec_sections: [{ ref: 'spec/SPEC.md#cli-surface', new_body: '## CLI surface\n\nX', status: 'applied' }],
        prd_sections: [{ ref: 'spec/PRD.md#feature-2', new_body: '## Feature 2\n\nX', status: 'applied' }],
        phases_tasks: [{ id: 'P2.5-T04', field: 'acceptance', value: ['x'], status: 'applied' }],
        tracker_issues: [{ id: 'FORGE-95', new_body: 'x', retries: 0, status: 'applied' }],
        finalize: { commit_msg_written, index_appended: false, adr_deleted: false, archived: false },
      },
    });
    const buf = captureStdout(t);
    await runOrchestrateApplyDecision(baseArgs(repo, { resume: true }));
    const env = lastJson(buf);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'ADR_NOT_ACCEPTED');
    assert.equal(existsSync(repo.adrPath), true); // not deleted
    assert.equal(existsSync(repo.completedPath), false); // not archived
  });
}

test('coverage compares file#anchor, not anchor alone (Codex impl-review #2)', async (t) => {
  // Journal entry targets the right anchor but the WRONG file → must not satisfy
  // the ADR-declared spec/SPEC.md section.
  const repo = setupRepo({
    journal: { spec_sections: [{ ref: 'spec/OTHER.md#cli-surface', new_body: '## CLI surface\n\nX', status: 'pending' }] },
  });
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker() });
  const env = lastJson(buf);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'JOURNAL_COVERAGE_MISMATCH');
});

test('re-running an already-applied decision is an idempotent no-op', async (t) => {
  const repo = setupRepo();
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker() });
  const buf = captureStdout(t);
  await runOrchestrateApplyDecision(baseArgs(repo), { trackerOverride: fakeTracker() });
  const env = lastJson(buf);
  assert.equal(env.ok, true);
  assert.equal(env.data.already_applied, true);
});
