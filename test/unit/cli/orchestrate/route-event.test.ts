import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runOrchestrateRoute } from '../../../../src/cli/orchestrate/route.ts';
import { acquire } from '../../../../src/orchestrator/leases.ts';
import { readAttemptEvents } from '../../../../src/orchestrator/attempt-events.ts';
import type { AvailabilitySet } from '../../../../src/orchestrator/availability.ts';
import type { ModelsCatalog } from '../../../../src/schemas/models-catalog.ts';

function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-route-event-'));
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: (c: unknown) => {
      chunks.push(String(c));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => chunks.join('') };
}

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj), 'utf8');
}

function writePhases(repo: string): void {
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(
    join(repo, 'plans/phases.yaml'),
    `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
    gate_criteria: [ships]
    tasks:
      - id: P1-T01
        title: First task
        description: First task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        model_tier: standard
        write_globs: ["docs/**"]
`,
    'utf8',
  );
}

function writeCache(forgeDir: string, cat: ModelsCatalog): void {
  writeJson(join(forgeDir, 'models-catalog.json'), cat);
}

function catalog(): ModelsCatalog {
  return {
    version: 1,
    refreshed_at: '2026-06-14T00:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-sonnet', tier: 'standard', sources: ['https://x'] }] },
    },
  };
}

function avail(): AvailabilitySet {
  const mk = (a: boolean) => ({ available: a, reasons: a ? [] : ['fixed'] });
  return { claude: mk(true), codex: mk(false), gemini: mk(false), cursor: mk(false) };
}

test('route --attempt WITH a held lease appends a model_routed event', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo);
  writeCache(forgeDir, catalog());
  // A real lease so caller identity is recoverable (mirrors guardrail-check).
  acquire({ forgeDir, taskId: 'P1-T01', runId: 'run-1'});

  const out = capture();
  const errS = capture();
  const res = await runOrchestrateRoute({
    forgeDir,
    cwd: repo,
    taskId: 'P1-T01',
    attemptId: 'att-1',
    json: true,
    availability: avail(),
    stdout: out.stream,
    stderr: errS.stream,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(JSON.parse(out.text()).ok, true);

  const events = readAttemptEvents({ forgeDir, taskId: 'P1-T01', attemptId: 'att-1' });
  const routed = events.filter((e) => e.ok && e.event.type === 'model_routed');
  assert.equal(routed.length, 1);
  assert.equal(routed[0]!.ok, true);
  if (routed[0]!.ok && routed[0]!.event.type === 'model_routed') {
    assert.equal(routed[0]!.event.host, 'claude');
    assert.equal(routed[0]!.event.model, 'claude-sonnet');
    assert.equal(routed[0]!.event.tier_effective, 'standard');
    assert.equal(routed[0]!.event.downgraded, false);
  }
});

test('route advisory (no --attempt) emits the route but appends NO event', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo);
  writeCache(forgeDir, catalog());
  acquire({ forgeDir, taskId: 'P1-T01', runId: 'run-1'});

  const out = capture();
  const errS = capture();
  const res = await runOrchestrateRoute({
    forgeDir,
    cwd: repo,
    taskId: 'P1-T01',
    json: true,
    availability: avail(),
    stdout: out.stream,
    stderr: errS.stream,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(JSON.parse(out.text()).ok, true);

  // With no --attempt the verb cannot know which attempt log to write to.
  const events = readAttemptEvents({ forgeDir, taskId: 'P1-T01', attemptId: 'att-1' });
  assert.equal(events.length, 0);
});

test('route --attempt WITHOUT a lease still emits the route, skips the event', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo);
  writeCache(forgeDir, catalog());
  // No lease acquired.

  const out = capture();
  const errS = capture();
  const res = await runOrchestrateRoute({
    forgeDir,
    cwd: repo,
    taskId: 'P1-T01',
    attemptId: 'att-1',
    json: true,
    availability: avail(),
    stdout: out.stream,
    stderr: errS.stream,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(JSON.parse(out.text()).ok, true);

  const events = readAttemptEvents({ forgeDir, taskId: 'P1-T01', attemptId: 'att-1' });
  assert.equal(events.length, 0);
  // Best-effort skip is silent (no stderr warning when there's simply no lease).
  assert.equal(errS.text(), '');
});
