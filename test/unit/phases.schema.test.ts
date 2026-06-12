import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  PhasesSchema,
  PhaseSchema,
  TaskSchema,
  OWNER_TYPES,
  PRIORITIES,
  ESTIMATES,
  TASK_TYPES,
  type Phases,
  type Task,
} from '../../src/schemas/phases.ts';
import {
  PhasesSchema as PhasesSchemaViaBarrel,
  type Phases as PhasesViaBarrel,
} from '../../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', 'fixtures', 'phases');

function loadFixture(name: string): unknown {
  const raw = readFileSync(resolve(fixturesDir, name), 'utf8');
  return parseYaml(raw);
}

function baseTask(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'P1-T01',
    title: 'Task',
    description: 'Does something.',
    type: 'foundation',
    priority: 'P0',
    estimate: 'S',
    owner_type: 'backend-dev',
    acceptance: ['It works.'],
    ...overrides,
  };
}

function basePhases(taskOverrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    project: 'fixture',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase',
        status: 'active',
        goal: 'Goal text.',
        gate_criteria: ['Gate.'],
        tasks: [baseTask(taskOverrides)],
      },
    ],
  };
}

test('AC1 — schema validates the live plans/phases.yaml snapshot', () => {
  const data = loadFixture('live-snapshot.yaml');
  const result = PhasesSchema.safeParse(data);
  if (!result.success) {
    assert.fail(`live snapshot failed: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
  assert.equal(result.data.project, 'forge');
  assert.equal(result.data.phases.length, 3);
  assert.equal(result.data.phases[0]!.id, 'phase-1');
  assert.equal(result.data.phases[0]!.tasks[0]!.id, 'P1-T01');
});

test('AC1 — schema validates a minimal one-phase one-task fixture', () => {
  const data = loadFixture('valid-minimal.yaml');
  const result = PhasesSchema.safeParse(data);
  if (!result.success) {
    assert.fail(`minimal fixture failed: ${JSON.stringify(result.error.issues)}`);
  }
  assert.equal(result.data.phases[0]!.tasks[0]!.depends_on.length, 0);
});

test('AC2 — rejects a two-task A->B->A cycle', () => {
  const data = loadFixture('invalid-cycle.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const cycleIssue = result.error.issues.find((i) => i.message.includes('cycle detected'));
  assert.ok(cycleIssue, `Expected cycle issue, got: ${JSON.stringify(result.error.issues)}`);
});

test('AC2 — rejects a three-task A->B->C->A cycle', () => {
  const data = loadFixture('invalid-cycle-three.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const cycleIssue = result.error.issues.find((i) => i.message.includes('cycle detected'));
  assert.ok(cycleIssue);
  assert.match(cycleIssue!.message, /P1-T0\d -> P1-T0\d -> P1-T0\d -> P1-T0\d/);
});

test('AC2 — rejects a self-loop A->A', () => {
  const data = loadFixture('invalid-self-loop.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const cycleIssue = result.error.issues.find((i) => i.message.includes('cycle detected'));
  assert.ok(cycleIssue);
  assert.match(cycleIssue!.message, /P1-T01 -> P1-T01/);
});

test('AC2 — rejects depends_on pointing at an unknown task id', () => {
  const data = loadFixture('invalid-unknown-dep.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const unknownIssue = result.error.issues.find((i) =>
    i.message.includes('depends_on references unknown task id'),
  );
  assert.ok(unknownIssue);
});

test('AC2 — rejects blocked_by pointing at an unknown phase id', () => {
  const result = PhasesSchema.safeParse({
    project: 'p',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        status: 'blocked',
        blocked_by: 'phase-99',
        goal: 'g',
        gate_criteria: ['g1'],
        tasks: [baseTask()],
      },
    ],
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find((i) =>
    i.message.includes('blocked_by references unknown phase id'),
  );
  assert.ok(issue);
});

test('AC2 — rejects duplicate task ids across phases', () => {
  const result = PhasesSchema.safeParse({
    project: 'p',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        status: 'active',
        goal: 'g',
        gate_criteria: ['g1'],
        tasks: [baseTask({ id: 'P1-T01' })],
      },
      {
        id: 'phase-2',
        name: 'Phase 2',
        status: 'blocked',
        blocked_by: 'phase-1',
        goal: 'g',
        gate_criteria: ['g1'],
        tasks: [baseTask({ id: 'P1-T01' })],
      },
    ],
  });
  assert.equal(result.success, false);
  if (result.success) return;
  const dupIssue = result.error.issues.find((i) => i.message.includes('duplicate task id'));
  assert.ok(dupIssue);
});

test('AC2 — rejects duplicate phase ids', () => {
  const data = loadFixture('invalid-duplicate-phase-id.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const dupIssue = result.error.issues.find((i) => i.message.includes('duplicate phase id'));
  assert.ok(dupIssue, `Expected duplicate phase id issue, got: ${JSON.stringify(result.error.issues)}`);
  assert.deepEqual(dupIssue!.path, ['phases', 1, 'id']);
  assert.match(dupIssue!.message, /duplicate phase id: phase-1/);
});

for (const ownerType of OWNER_TYPES) {
  test(`AC3 — accepts owner_type "${ownerType}"`, () => {
    const result = PhasesSchema.safeParse(basePhases({ owner_type: ownerType }));
    if (!result.success) {
      assert.fail(`owner_type ${ownerType} rejected: ${JSON.stringify(result.error.issues)}`);
    }
    assert.equal(result.data.phases[0]!.tasks[0]!.owner_type, ownerType);
  });
}

for (const priority of PRIORITIES) {
  test(`AC3 — accepts priority "${priority}"`, () => {
    const result = PhasesSchema.safeParse(basePhases({ priority }));
    if (!result.success) {
      assert.fail(`priority ${priority} rejected: ${JSON.stringify(result.error.issues)}`);
    }
    assert.equal(result.data.phases[0]!.tasks[0]!.priority, priority);
  });
}

test('AC3 — rejects invalid owner_type "not-a-role"', () => {
  const result = PhasesSchema.safeParse(basePhases({ owner_type: 'not-a-role' }));
  assert.equal(result.success, false);
});

test('AC3 — rejects invalid priority "P4"', () => {
  const result = PhasesSchema.safeParse(basePhases({ priority: 'P4' }));
  assert.equal(result.success, false);
});

for (const estimate of ESTIMATES) {
  test(`AC3 — accepts estimate "${estimate}"`, () => {
    const result = PhasesSchema.safeParse(basePhases({ estimate }));
    if (!result.success) {
      assert.fail(`estimate ${estimate} rejected: ${JSON.stringify(result.error.issues)}`);
    }
    assert.equal(result.data.phases[0]!.tasks[0]!.estimate, estimate);
  });
}

test('AC3 — rejects invalid estimate "XXL"', () => {
  const result = PhasesSchema.safeParse(basePhases({ estimate: 'XXL' }));
  assert.equal(result.success, false);
});

for (const taskType of TASK_TYPES) {
  test(`AC3 — accepts task_type "${taskType}"`, () => {
    const result = PhasesSchema.safeParse(basePhases({ type: taskType }));
    if (!result.success) {
      assert.fail(`task_type ${taskType} rejected: ${JSON.stringify(result.error.issues)}`);
    }
    assert.equal(result.data.phases[0]!.tasks[0]!.type, taskType);
  });
}

test('AC3 — rejects invalid task_type "misc"', () => {
  const result = PhasesSchema.safeParse(basePhases({ type: 'misc' }));
  assert.equal(result.success, false);
});

test('FD-6 retro — rejects task missing required owner_type', () => {
  const data = loadFixture('invalid-missing-owner-type.yaml');
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find((i) => i.path.includes('owner_type'));
  assert.ok(issue);
});

test('FD-6 retro — rejects partial Phase object (missing tasks, goal, etc.)', () => {
  const result = PhasesSchema.safeParse({ phases: [{}] });
  assert.equal(result.success, false);
  if (result.success) return;
  const missingProject = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'project',
  );
  assert.ok(missingProject, 'project key absence must surface as its own issue');
  const insidePhase = result.error.issues.filter(
    (i) => i.path[0] === 'phases' && i.path[1] === 0,
  );
  assert.ok(insidePhase.length >= 3, 'partial phase must produce multiple missing-field issues');
});

test('FD-6 retro — rejects empty phases array', () => {
  const result = PhasesSchema.safeParse({ project: 'p', phases: [] });
  assert.equal(result.success, false);
});

test('FD-6 retro — rejects empty tasks array on a phase', () => {
  const result = PhasesSchema.safeParse({
    project: 'p',
    phases: [
      {
        id: 'phase-1',
        name: 'P',
        status: 'active',
        goal: 'g',
        gate_criteria: ['g1'],
        tasks: [],
      },
    ],
  });
  assert.equal(result.success, false);
});

test('FD-6 retro — rejects empty acceptance array on a task', () => {
  const result = PhasesSchema.safeParse(basePhases({ acceptance: [] }));
  assert.equal(result.success, false);
});

test('FD-6 retro — rejects empty gate_criteria array on a phase', () => {
  const result = PhasesSchema.safeParse({
    project: 'p',
    phases: [
      {
        id: 'phase-1',
        name: 'P',
        status: 'active',
        goal: 'g',
        gate_criteria: [],
        tasks: [baseTask()],
      },
    ],
  });
  assert.equal(result.success, false);
});

test('default — depends_on defaults to [] when absent on a task', () => {
  const result = PhasesSchema.safeParse(basePhases());
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.phases[0]!.tasks[0]!.depends_on, []);
});

test('default — does NOT default any top-level required key', () => {
  const result = PhasesSchema.safeParse({});
  assert.equal(result.success, false);
  if (result.success) return;
  const paths = result.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.includes('project'));
  assert.ok(paths.includes('phases'));
});

test('default — split_into stays undefined when absent', () => {
  const result = PhasesSchema.safeParse(basePhases());
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.phases[0]!.tasks[0]!.split_into, undefined);
});

test('id regex — rejects bad task id format', () => {
  const result = PhasesSchema.safeParse(basePhases({ id: 'task-1' }));
  assert.equal(result.success, false);
});

test('id regex — rejects bad phase id format', () => {
  const result = PhasesSchema.safeParse({
    project: 'p',
    phases: [
      {
        id: 'Phase1',
        name: 'P',
        status: 'active',
        goal: 'g',
        gate_criteria: ['g1'],
        tasks: [baseTask()],
      },
    ],
  });
  assert.equal(result.success, false);
});

test('id regex — accepts split-task suffix (e.g. P2-T07a)', () => {
  const result = PhasesSchema.safeParse(basePhases({ id: 'P2-T07a' }));
  assert.equal(result.success, true);
});

test('id regex — accepts decimal phase task id (e.g. P2.5-T01)', () => {
  const result = TaskSchema.safeParse(baseTask({ id: 'P2.5-T01' }));
  assert.equal(result.success, true);
});

test('id regex — accepts decimal phase id (e.g. phase-2.5)', () => {
  const result = PhaseSchema.safeParse({
    id: 'phase-2.5',
    name: 'Phase 2.5',
    status: 'active',
    goal: 'g',
    gate_criteria: ['g1'],
    tasks: [baseTask({ id: 'P2.5-T01' })],
  });
  assert.equal(result.success, true);
});

test('FORGE-100 — TaskSchema accepts optional status + lifecycle metadata', () => {
  const task = baseTask({
    status: 'deferred-v0.5',
    deferred_at: '2026-05-17',
    deferred_reason: 'Team-mode minimum architecture pivot',
  });
  const result = TaskSchema.safeParse(task);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.status, 'deferred-v0.5');
  assert.equal(result.data.deferred_at, '2026-05-17');
});

test('FORGE-100 — TaskSchema accepts dropped + paused lifecycle fields', () => {
  const dropped = TaskSchema.safeParse(
    baseTask({ status: 'dropped', dropped_at: '2026-05-17', dropped_reason: 'no longer needed' }),
  );
  assert.equal(dropped.success, true);
  const paused = TaskSchema.safeParse(
    baseTask({ status: 'paused', paused_at: '2026-05-17', paused_reason: 'blocked on infra' }),
  );
  assert.equal(paused.success, true);
});

test('FORGE-65 — TaskSchema accepts an optional per-task question_budget override', () => {
  const result = TaskSchema.safeParse(baseTask({ question_budget: { soft: 2, hard: 4 } }));
  assert.equal(result.success, true);
  const partial = TaskSchema.safeParse(baseTask({ question_budget: { hard: 8 } }));
  assert.equal(partial.success, true);
});

test('FORGE-65 — TaskSchema rejects question_budget with hard < soft', () => {
  const result = TaskSchema.safeParse(baseTask({ question_budget: { soft: 5, hard: 3 } }));
  assert.equal(result.success, false);
});

test('FORGE-100 — PHASE_STATUSES accepts "paused"', () => {
  const result = PhaseSchema.safeParse({
    id: 'phase-1',
    name: 'P',
    status: 'paused',
    goal: 'g',
    gate_criteria: ['g1'],
    tasks: [baseTask()],
  });
  assert.equal(result.success, true);
});

test('FORGE-100 — TASK_TYPES includes "skill" and "docs"', () => {
  for (const t of ['skill', 'docs'] as const) {
    const result = TaskSchema.safeParse(baseTask({ type: t }));
    assert.equal(result.success, true, `expected ${t} to be accepted`);
  }
});

test('barrel — PhasesSchema reachable through src/index.ts', () => {
  const result = PhasesSchemaViaBarrel.safeParse(loadFixture('valid-minimal.yaml'));
  assert.equal(result.success, true);
});

test('types — z.infer surface compiles via satisfies', () => {
  const result = PhasesSchema.safeParse(loadFixture('valid-minimal.yaml'));
  assert.equal(result.success, true);
  if (!result.success) return;
  const phases: Phases = result.data;
  const viaBarrel: PhasesViaBarrel = result.data;
  const firstTask: Task = phases.phases[0]!.tasks[0]!;
  assert.equal(typeof firstTask.id, 'string');
  assert.equal(typeof viaBarrel.project, 'string');
  result.data satisfies {
    project: string;
    phases: Array<{
      id: string;
      name: string;
      status: 'active' | 'blocked' | 'done' | 'paused';
      goal: string;
      gate_criteria: string[];
      tasks: Array<{
        id: string;
        title: string;
        description: string;
        priority: 'P0' | 'P1' | 'P2';
        depends_on: string[];
        estimate: 'S' | 'M' | 'L' | 'XL';
        owner_type:
          | 'frontend-dev'
          | 'backend-dev'
          | 'db-architect'
          | 'devops-engineer'
          | 'qa-engineer'
          | 'security-auditor'
          | 'design-engineer'
          | 'integration'
          | 'human';
        acceptance: string[];
      }>;
    }>;
  };
});

test('component schemas — PhaseSchema and TaskSchema exported separately', () => {
  const phaseOk = PhaseSchema.safeParse({
    id: 'phase-1',
    name: 'P',
    status: 'active',
    goal: 'g',
    gate_criteria: ['g1'],
    tasks: [baseTask()],
  });
  assert.equal(phaseOk.success, true);

  const taskOk = TaskSchema.safeParse(baseTask());
  assert.equal(taskOk.success, true);
});

test('TaskSchema accepts tracker_issue_id', () => {
  const task = baseTask({ tracker_issue_id: 'gh#42' });
  const result = TaskSchema.safeParse(task);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.tracker_issue_id, 'gh#42');
});

test('PhasesSchema tolerates a legacy top-level tracker_url and strips it (FORGE-127)', () => {
  // FORGE-127 moved tracker_url into source. PhasesSchema is non-strict, so an
  // unmigrated file with a top-level tracker_url still PARSES (no validation
  // error) but the field is silently stripped from the parsed object — the
  // first --pull migrates it into source.tracker_url.
  const data = {
    ...basePhases(),
    tracker_url: 'https://github.com/org/repo',
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    (result.data as Record<string, unknown>).tracker_url,
    undefined,
    'legacy top-level tracker_url must be stripped on parse',
  );
});

test('SourceSchema accepts tracker_url (FORGE-127)', () => {
  const data = {
    ...basePhases(),
    source: {
      tracker: 'github' as const,
      project_id: 'proj_abc',
      synced_at: '2026-05-17T22:17:11Z',
      spec_revision: 'abc1234',
      tracker_url: 'https://github.com/org/repo',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.source?.tracker_url, 'https://github.com/org/repo');
});

test('SourceSchema accepts tracker_revision (FORGE-123)', () => {
  const data = {
    ...basePhases(),
    source: {
      tracker: 'linear' as const,
      project_id: 'proj_abc',
      synced_at: '2026-05-17T22:17:11Z',
      spec_revision: 'abc1234',
      tracker_revision: 'linear:2026-05-17T22:17:11.000Z',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    result.data.source?.tracker_revision,
    'linear:2026-05-17T22:17:11.000Z',
  );
});

test('PhasesSchema accepts optional source block', () => {
  const data = {
    ...basePhases(),
    source: {
      tracker: 'linear' as const,
      project_id: 'proj_abc',
      synced_at: '2026-05-17T22:17:11Z',
      spec_revision: '8fa22260dfb272c0ba61a6b78288942fc1d0f418',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.source?.tracker, 'linear');
  assert.equal(result.data.source?.project_id, 'proj_abc');
  assert.equal(result.data.source?.synced_at, '2026-05-17T22:17:11Z');
  assert.equal(
    result.data.source?.spec_revision,
    '8fa22260dfb272c0ba61a6b78288942fc1d0f418',
  );
});

test('PhasesSchema rejects unknown tracker in source.tracker', () => {
  const data = {
    ...basePhases(),
    source: {
      tracker: 'jira',
      project_id: 'proj_abc',
      synced_at: '2026-05-17T22:17:11Z',
      spec_revision: 'abc1234',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
});

test('PhasesSchema rejects non-ISO synced_at in source', () => {
  const data = {
    ...basePhases(),
    source: {
      tracker: 'linear' as const,
      project_id: 'proj_abc',
      synced_at: 'last tuesday',
      spec_revision: 'abc1234',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
});

test('PhasesSchema rejects extra keys inside source (strict)', () => {
  // tracker_revision and tracker_url are now legitimate SourceSchema fields
  // (FORGE-123 / FORGE-127); use a genuinely-unknown key to prove .strict().
  const data = {
    ...basePhases(),
    source: {
      tracker: 'linear' as const,
      project_id: 'proj_abc',
      synced_at: '2026-05-17T22:17:11Z',
      spec_revision: 'abc1234',
      sneaky_extra_field: 'nope',
    },
  };
  const result = PhasesSchema.safeParse(data);
  assert.equal(result.success, false);
});

test('PhaseSchema accepts tracker_milestone_id', () => {
  const phase = {
    id: 'phase-1',
    tracker_milestone_id: 'milestone-uuid',
    name: 'Phase',
    status: 'active',
    goal: 'g',
    gate_criteria: ['g1'],
    tasks: [baseTask()],
  };
  const result = PhaseSchema.safeParse(phase);
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.tracker_milestone_id, 'milestone-uuid');
});

// --- FORGE-120: TaskSchema.status enum rejection ----------------------------

test('FORGE-120 — TaskSchema rejects an out-of-enum status value', () => {
  const result = TaskSchema.safeParse(baseTask({ status: 'foo' }));
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find((i) => i.path.includes('status'));
  assert.ok(issue, 'expected a status enum issue');
});

// --- FORGE-177: 'human' owner_type ------------------------------------------

test("FORGE-177 — TaskSchema accepts owner_type 'human'", () => {
  const result = TaskSchema.safeParse(baseTask({ owner_type: 'human' }));
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.owner_type, 'human');
});

test("FORGE-177 — OWNER_TYPES includes 'human'", () => {
  assert.ok((OWNER_TYPES as readonly string[]).includes('human'));
});
