import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchestratePhases } from '../../../../src/cli/orchestrate/phases.ts';

// FORGE-113 AC #7 — integration: stale phases.yaml (>24h old) still works
// but prints the staleness duration prominently. The CLI exits 0 (the file
// parses and is usable); the freshness line on stderr is what surfaces the
// staleness, not the exit code.

function captureStreams(t: { after: (fn: () => void) => void }): {
  stdout: string[];
  stderr: string[];
} {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutBuf.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrBuf.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  });
  return { stdout: stdoutBuf, stderr: stderrBuf };
}

function repoWithStalePhases(syncedHoursAgo: number): {
  repo: string;
  forgeDir: string;
} {
  const repo = mkdtempSync(join(tmpdir(), 'forge-phases-stale-'));
  mkdirSync(join(repo, 'plans'), { recursive: true });
  const syncedAt = new Date(
    Date.now() - syncedHoursAgo * 60 * 60 * 1000,
  ).toISOString();
  const phasesYaml = `project: forge
source:
  tracker: linear
  project_id: staleness-test
  synced_at: "${syncedAt}"
  spec_revision: feedfacecafebabe0000000000000000000000ab
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: t-1
        title: First task
        description: First
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['done']
`;
  writeFileSync(join(repo, 'plans/phases.yaml'), phasesYaml);
  return { repo, forgeDir: join(repo, '.forge') };
}

test('e2e: phases verb on 25h-stale file exits 0 with prominent STALE marker', async (t) => {
  const { stderr } = captureStreams(t);
  const { repo, forgeDir } = repoWithStalePhases(25);
  const result = await runOrchestratePhases({
    ready: false,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const stderrJoined = stderr.join('');
  // Prominent staleness — STALE marker present, includes age in days/hours,
  // tracker name, and the SPEC@ digest fragment.
  assert.match(stderrJoined, /phases\.yaml: ⚠ STALE — synced \d+d ago from linear \(SPEC@[0-9a-f]{7}\)/);
  void repo;
});

test('e2e: phases verb on 23h-fresh file exits 0 WITHOUT STALE marker', async (t) => {
  const { stderr } = captureStreams(t);
  const { repo, forgeDir } = repoWithStalePhases(23);
  const result = await runOrchestratePhases({
    ready: false,
    forgeDir,
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const stderrJoined = stderr.join('');
  assert.ok(!stderrJoined.includes('STALE'));
  assert.match(stderrJoined, /phases\.yaml: synced \d+h ago from linear/);
  void repo;
});

test('e2e: phases verb on file with NO source block prints documented fallback', async (t) => {
  const { stderr } = captureStreams(t);
  const repo = mkdtempSync(join(tmpdir(), 'forge-phases-no-source-'));
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(
    join(repo, 'plans/phases.yaml'),
    `project: forge
phases:
  - id: phase-1
    name: Phase 1
    status: active
    goal: g
    gate_criteria: ['g']
    tasks:
      - id: P1-T01
        tracker_issue_id: t-1
        title: First task
        description: First
        type: foundation
        priority: P0
        depends_on: []
        estimate: S
        owner_type: backend-dev
        acceptance: ['done']
`,
  );
  const result = await runOrchestratePhases({
    ready: false,
    forgeDir: join(repo, '.forge'),
    json: true,
  });
  assert.equal(result.exitCode, 0);
  const stderrJoined = stderr.join('');
  assert.match(
    stderrJoined,
    /phases\.yaml: no source metadata \(run forge orchestrate reconcile --pull to sync\)/,
  );
});
