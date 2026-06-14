import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runOrchestrateRoute } from '../../../../src/cli/orchestrate/route.ts';
import type { RouteData } from '../../../../src/cli/orchestrate/route.ts';
import type { AvailabilitySet } from '../../../../src/orchestrator/availability.ts';
import type { ModelsCatalog } from '../../../../src/schemas/models-catalog.ts';

function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'forge-route-'));
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

function writePhases(repo: string, yaml: string): void {
  mkdirSync(join(repo, 'plans'), { recursive: true });
  writeFileSync(join(repo, 'plans/phases.yaml'), yaml, 'utf8');
}

function writeCache(forgeDir: string, cat: ModelsCatalog): void {
  writeJson(join(forgeDir, 'models-catalog.json'), cat);
}

function seedState(forgeDir: string, taskId: string, attemptCount: number): void {
  writeJson(join(forgeDir, 'orchestrator', 'tasks', taskId, 'state.json'), {
    version: 1,
    task_id: taskId,
    state: 'running',
    state_version: 0,
    attempt_count: attemptCount,
    current_attempt_id: 'att-1',
    updated_at: new Date().toISOString(),
    updated_by: { run_id: 'run-seed', claim_id: 'claim-seed', generation: 0 },
  });
}

// A catalog with one model per tier on each of claude + codex so the resolver
// has exact-tier / auto-upgrade / downgrade choices.
function fullCatalog(): ModelsCatalog {
  return {
    version: 1,
    refreshed_at: '2026-06-14T00:00:00Z',
    hosts: {
      claude: {
        models: [
          { id: 'claude-haiku', tier: 'small', sources: ['https://x'] },
          { id: 'claude-sonnet', tier: 'standard', sources: ['https://x'] },
          { id: 'claude-opus', tier: 'frontier', sources: ['https://x'] },
        ],
      },
      codex: {
        models: [
          { id: 'gpt-mini', tier: 'small', sources: ['https://y'] },
          { id: 'gpt-5', tier: 'standard', sources: ['https://y'] },
          { id: 'gpt-codex', tier: 'frontier', sources: ['https://y'] },
        ],
      },
    },
  };
}

// Fixed availability sets (R6: inject; no real binaries).
function avail(over: Partial<Record<keyof AvailabilitySet, boolean>> = {}): AvailabilitySet {
  const mk = (a: boolean) => ({ available: a, reasons: a ? [] : ['fixed-test'] });
  return {
    claude: mk(over.claude ?? true),
    codex: mk(over.codex ?? true),
    gemini: mk(over.gemini ?? false),
    cursor: mk(over.cursor ?? false),
  };
}

function phasesWith(taskBody: string): string {
  return `project: x
phases:
  - id: phase-1
    name: foundation
    status: active
    goal: build
    gate_criteria: [ships]
    tasks:
${taskBody}
`;
}

const STANDARD_TASK = `      - id: P1-T01
        title: First task
        description: First task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        model_tier: standard
        write_globs: ["src/app/**"]
`;

async function route(
  forgeDir: string,
  repo: string,
  taskId: string,
  availability: AvailabilitySet,
  attemptId?: string,
): Promise<{ ok: boolean; data?: RouteData; error?: { code: string; message: string } }> {
  const out = capture();
  const errStream = capture();
  const res = await runOrchestrateRoute({
    forgeDir,
    cwd: repo,
    taskId,
    json: true,
    availability,
    stdout: out.stream,
    stderr: errStream.stream,
    ...(attemptId ? { attemptId } : {}),
  });
  const env = JSON.parse(out.text());
  return { ...env, exitCode: res.exitCode } as never;
}

test('route: floor satisfaction — stamp standard resolves an exact-tier model', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());

  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_floor, 'standard');
  assert.equal(env.data!.tier_effective, 'standard');
  assert.equal(env.data!.downgraded, false);
  // CATALOG_HOSTS order → claude first; exact standard tier.
  assert.equal(env.data!.host, 'claude');
  assert.equal(env.data!.model, 'claude-sonnet');
});

test('route: auto-upgrade — no exact tier reachable picks the next-higher tier', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  // Only frontier models available (drop small/standard).
  writeCache(forgeDir, {
    version: 1,
    refreshed_at: '2026-06-14T00:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-opus', tier: 'frontier', sources: ['https://x'] }] },
    },
  });

  const env = await route(forgeDir, repo, 'P1-T01', avail({ codex: false }));
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'standard');
  assert.equal(env.data!.downgraded, false);
  assert.equal(env.data!.tier_floor, 'standard');
  // Auto-upgrade to the only reachable (frontier) model.
  assert.equal(env.data!.model, 'claude-opus');
});

test('route: downgrade-with-warning — nothing >= floor reachable downgrades + warns', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  // Only a small model reachable; floor is standard → must downgrade.
  writeCache(forgeDir, {
    version: 1,
    refreshed_at: '2026-06-14T00:00:00Z',
    hosts: {
      claude: { models: [{ id: 'claude-haiku', tier: 'small', sources: ['https://x'] }] },
    },
  });

  const env = await route(forgeDir, repo, 'P1-T01', avail({ codex: false }));
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'standard');
  assert.equal(env.data!.downgraded, true);
  assert.ok(env.data!.warning && env.data!.warning.length > 0);
  assert.equal(env.data!.model, 'claude-haiku');
});

test('route: R2 critical-path write_glob ∩ preflight_globs → frontier effective tier', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  // write_globs src/**/*.ts intersects the default preflight glob src/schemas/**.
  const criticalTask = `      - id: P1-T01
        title: Critical task
        description: Critical task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        model_tier: small
        write_globs: ["src/**/*.ts"]
`;
  writePhases(repo, phasesWith(criticalTask));
  writeCache(forgeDir, fullCatalog());

  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  // small stamp escalated to frontier by the critical-path intersection (R2).
  assert.equal(env.data!.tier_floor, 'small');
  assert.equal(env.data!.tier_effective, 'frontier');
  assert.match(env.data!.rationale, /critical-path/);
});

test('route: R1 first attempt (attempt_count=1) → NO tier bump', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());
  seedState(forgeDir, 'P1-T01', 1); // attempt_count=1 → priorFailed=0

  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'standard');
  assert.doesNotMatch(env.data!.rationale, /retry/);
});

test('route: R1 retry (attempt_count=2) → +1 tier bump (standard → frontier)', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());
  seedState(forgeDir, 'P1-T01', 2); // attempt_count=2 → priorFailed=1 → +1 notch

  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'frontier');
  assert.match(env.data!.rationale, /retry×1/);
});

test('route: STATE_NOT_FOUND → priorFailed 0 (no bump)', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());
  // No state.json seeded.

  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'standard');
});

test('route: deterministic replay — same inputs → identical output', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());

  const a = await route(forgeDir, repo, 'P1-T01', avail());
  const b = await route(forgeDir, repo, 'P1-T01', avail());
  assert.deepEqual(a.data, b.data);
});

test('route: TASK_NOT_FOUND for an unknown task id', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());

  const env = await route(forgeDir, repo, 'P9-T99', avail());
  assert.equal(env.ok, false);
  assert.equal(env.error!.code, 'TASK_NOT_FOUND');
});

test('route: NO_MODEL_AVAILABLE when no host is reachable', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());

  const env = await route(
    forgeDir,
    repo,
    'P1-T01',
    avail({ claude: false, codex: false, gemini: false, cursor: false }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.error!.code, 'NO_MODEL_AVAILABLE');
});

test('route: pins filter applied — only the pinned model id survives', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(STANDARD_TASK));
  writeCache(forgeDir, fullCatalog());
  // Pin claude to a frontier-only id, drop its standard model; codex unpinned.
  mkdirSync(forgeDir, { recursive: true });
  writeFileSync(
    join(forgeDir, 'settings.yaml'),
    [
      'version: 1',
      'project:',
      '  name: t',
      'tracker:',
      '  type: linear',
      '  config:',
      '    team_id: T',
      'secrets:',
      '  manager: env_file',
      'models:',
      '  pinned:',
      '    claude: [claude-opus]',
    ].join('\n'),
    'utf8',
  );

  // claude available; only its frontier model survives the pin. Floor is
  // standard → auto-upgrade to claude-opus (the only claude candidate), unless
  // codex offers an exact standard first (CATALOG_HOSTS: claude before codex,
  // but auto-upgrade prefers the LOWEST tier >= floor across all hosts → codex
  // gpt-5 (standard) wins over claude-opus (frontier)).
  const env = await route(forgeDir, repo, 'P1-T01', avail());
  assert.equal(env.ok, true);
  // codex exact-standard beats claude frontier under the resolver's lowest-tier rule.
  assert.equal(env.data!.host, 'codex');
  assert.equal(env.data!.model, 'gpt-5');

  // Now drop codex availability: claude-opus (pinned) is the only candidate.
  const env2 = await route(forgeDir, repo, 'P1-T01', avail({ codex: false }));
  assert.equal(env2.ok, true);
  assert.equal(env2.data!.host, 'claude');
  assert.equal(env2.data!.model, 'claude-opus');
});

// R2 (re-review): state/lease/events are keyed by tracker_issue_id ?? id. When
// --task is the ALTERNATE (phases) id of a tracker-backed task, route must still
// read the state under the tracker id — else retries silently reset to 0.
const TRACKER_TASK = `      - id: P1-T02
        tracker_issue_id: FORGE-99
        title: Tracker task
        description: Tracker-backed task
        type: backend
        priority: P0
        estimate: S
        owner_type: backend-dev
        depends_on: []
        acceptance: [done]
        model_tier: standard
        write_globs: ["src/app/**"]
`;

test('route: R2 tracker-backed task routed by PHASES id reads state under tracker id (retry bump)', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(TRACKER_TASK));
  writeCache(forgeDir, fullCatalog());
  // Seed retry state under the TRACKER id (the canonical state key).
  seedState(forgeDir, 'FORGE-99', 2); // attempt_count=2 → priorFailed=1 → +1 notch
  // Route by the PHASES id — must still find the FORGE-99 state and bump.
  const env = await route(forgeDir, repo, 'P1-T02', avail(), 'att-1');
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'frontier'); // standard +1 = frontier
  assert.match(env.data!.rationale, /retry×1/);
});

test('route: R2 routed by tracker id also reads the same state', async () => {
  const repo = repoRoot();
  const forgeDir = join(repo, '.forge');
  writePhases(repo, phasesWith(TRACKER_TASK));
  writeCache(forgeDir, fullCatalog());
  seedState(forgeDir, 'FORGE-99', 2);
  const env = await route(forgeDir, repo, 'FORGE-99', avail(), 'att-1');
  assert.equal(env.ok, true);
  assert.equal(env.data!.tier_effective, 'frontier');
});
