import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestrateApplyDecision } from '../../../../src/cli/orchestrate/apply-decision.ts';
import type { Tracker } from '../../../../src/trackers/base.ts';
import type { ApplyJournal } from '../../../../src/schemas/apply-journal.ts';

const SLUG = 'closed-loop-rollout';

function fakeTracker(opts: { failOnCall?: number } = {}): Tracker & { bodyCalls: { id: string; body: string }[] } {
  const bodyCalls: { id: string; body: string }[] = [];
  let calls = 0;
  const no = (m: string) => () => Promise.reject(new Error(`fakeTracker.${m}`));
  return {
    type: 'github',
    bodyCalls,
    async updateIssueBody(id: string, body: string) {
      calls += 1;
      if (opts.failOnCall && calls === opts.failOnCall) throw new Error('simulated tracker failure');
      bodyCalls.push({ id, body });
    },
    listActiveIssues: no('a') as Tracker['listActiveIssues'],
    listAllIssues: no('b') as Tracker['listAllIssues'],
    claim: no('c') as Tracker['claim'],
    releaseClaim: no('d') as Tracker['releaseClaim'],
    updateState: no('e') as Tracker['updateState'],
    comment: no('f') as Tracker['comment'],
    createProject: no('g') as Tracker['createProject'],
    createIssue: no('h') as Tracker['createIssue'],
    setBlockedBy: no('i') as Tracker['setBlockedBy'],
    setClaimFence: no('k') as Tracker['setClaimFence'],
    getCurrentRevision: no('l') as Tracker['getCurrentRevision'],
    healthCheck: no('j') as Tracker['healthCheck'],
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
---

# Closed loop rollout

## Context
ctx

## Decision
decide
`;

const SPEC = `# SPEC\n\n## CLI surface\n\nold\n\n## Tail\n\nkeep\n`;
const PRD = `# PRD\n\n## Feature 2\n\nold\n`;
const PHASES = `project: demo
phases:
  - id: phase-2.5
    name: CL
    status: active
    goal: g
    gate_criteria:
      - c
    tasks:
      - id: P2.5-T04
        title: t
        description: old
        type: backend
        priority: P1
        estimate: M
        owner_type: backend-dev
        acceptance:
          - old
`;

interface Repo {
  repoRoot: string;
  forgeDir: string;
  journalPath: string;
  completedPath: string;
  adrPath: string;
  indexPath: string;
}

function setup(journalOverride?: Partial<ApplyJournal>, seedIndex?: boolean): Repo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-apply-e2e-'));
  const forgeDir = join(repoRoot, '.forge');
  mkdirSync(join(repoRoot, 'spec', 'decisions'), { recursive: true });
  mkdirSync(join(repoRoot, 'plans'), { recursive: true });
  const jdir = join(forgeDir, 'orchestrator', 'global', 'update-spec-apply-journal');
  mkdirSync(jdir, { recursive: true });
  writeFileSync(join(repoRoot, 'spec', 'SPEC.md'), SPEC);
  writeFileSync(join(repoRoot, 'spec', 'PRD.md'), PRD);
  writeFileSync(join(repoRoot, 'plans', 'phases.yaml'), PHASES);
  const adrPath = join(repoRoot, 'spec', 'decisions', `2026-05-30-${SLUG}.md`);
  writeFileSync(adrPath, ADR);
  const indexPath = join(repoRoot, 'spec', 'decisions', 'INDEX.md');
  if (seedIndex) writeFileSync(indexPath, `# Decision index\n\n- 2026-05-30 — \`${SLUG}\`\n`);

  const journal: ApplyJournal = {
    version: 1,
    slug: SLUG,
    started_at: '2026-05-30T00:00:00.000Z',
    spec_sections: [{ ref: 'spec/SPEC.md#cli-surface', new_body: '## CLI surface\n\nNEW', status: 'pending' }],
    prd_sections: [{ ref: 'spec/PRD.md#feature-2', new_body: '## Feature 2\n\nNEW', status: 'pending' }],
    phases_tasks: [{ id: 'P2.5-T04', field: 'acceptance', value: ['ac1'], status: 'pending' }],
    tracker_issues: [
      { id: 'FORGE-1', new_body: 'b1', retries: 0, status: 'pending' },
      { id: 'FORGE-2', new_body: 'b2', retries: 0, status: 'pending' },
      { id: 'FORGE-3', new_body: 'b3', retries: 0, status: 'pending' },
      { id: 'FORGE-4', new_body: 'b4', retries: 0, status: 'pending' },
    ],
    finalize: { commit_msg_written: false, index_appended: false, adr_deleted: false, archived: false },
    ...journalOverride,
  };
  const journalPath = join(jdir, `${SLUG}.json`);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));

  return { repoRoot, forgeDir, journalPath, completedPath: join(jdir, 'completed', `${SLUG}.json`), adrPath, indexPath };
}

function args(repo: Repo, extra: Record<string, unknown> = {}) {
  return { slug: SLUG, yesAll: false, resume: false, dryRun: false, repoRoot: repo.repoRoot, forgeDir: repo.forgeDir, json: true, ...extra };
}

function readJournal(p: string): ApplyJournal {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// AC (phases.yaml:738): 7 entries, tracker fails on entry 4 (its first tracker
// call), --resume completes the remaining.
test('partial failure on entry 4 of 7, then --resume completes', async (t) => {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => { process.stdout.write = origWrite; });

  const repo = setup();

  // Run 1: tracker throws on its first call → spec/prd/phases applied (3),
  // first tracker entry failed, rest pending. ADR not deleted.
  const r1 = await runOrchestrateApplyDecision(args(repo), { trackerOverride: fakeTracker({ failOnCall: 1 }) });
  assert.notEqual(r1.exitCode, 0);
  let j = readJournal(repo.journalPath);
  assert.equal(j.spec_sections[0]!.status, 'applied');
  assert.equal(j.prd_sections[0]!.status, 'applied');
  assert.equal(j.phases_tasks[0]!.status, 'applied');
  assert.equal(j.tracker_issues[0]!.status, 'failed');
  assert.equal(j.tracker_issues[0]!.retries, 1);
  assert.equal(j.tracker_issues[1]!.status, 'pending'); // stopped at first failure
  assert.equal(existsSync(repo.adrPath), true); // not finalized
  assert.equal(existsSync(repo.completedPath), false);

  // Run 2: --resume with a healthy tracker → completes all 4 tracker entries.
  const tracker2 = fakeTracker();
  const r2 = await runOrchestrateApplyDecision(args(repo, { resume: true }), { trackerOverride: tracker2 });
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(tracker2.bodyCalls.map((c) => c.id), ['FORGE-1', 'FORGE-2', 'FORGE-3', 'FORGE-4']);
  assert.equal(existsSync(repo.adrPath), false); // deleted on finalize
  assert.equal(existsSync(repo.completedPath), true); // archived
  assert.equal(existsSync(repo.journalPath), false); // active removed
  // SPEC/PRD/phases were NOT re-applied destructively — still contain the new content.
  assert.match(readFileSync(join(repo.repoRoot, 'spec', 'SPEC.md'), 'utf8'), /NEW/);
});

// Codex 2nd-pass r2: a crash between the INDEX append and its flag must not
// duplicate the INDEX line on resume — upsert is keyed by slug.
test('crash before index_appended flag does not duplicate the INDEX line', async (t) => {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => { process.stdout.write = origWrite; });

  // All entries already applied; INDEX already has the slug line; flag still false
  // (the crash window). No tracker needed (all applied).
  const repo = setup(
    {
      spec_sections: [{ ref: 'spec/SPEC.md#cli-surface', new_body: '## CLI surface\n\nNEW', status: 'applied' }],
      prd_sections: [{ ref: 'spec/PRD.md#feature-2', new_body: '## Feature 2\n\nNEW', status: 'applied' }],
      phases_tasks: [{ id: 'P2.5-T04', field: 'acceptance', value: ['ac1'], status: 'applied' }],
      tracker_issues: [{ id: 'FORGE-1', new_body: 'b1', retries: 0, status: 'applied' }],
      finalize: { commit_msg_written: false, index_appended: false, adr_deleted: false, archived: false },
    },
    /* seedIndex */ true,
  );

  const r = await runOrchestrateApplyDecision(args(repo, { resume: true }));
  assert.equal(r.exitCode, 0);
  const index = readFileSync(repo.indexPath, 'utf8');
  const occurrences = index.split(`\`${SLUG}\``).length - 1;
  assert.equal(occurrences, 1); // exactly one — no duplicate
  assert.equal(existsSync(repo.completedPath), true);
});
