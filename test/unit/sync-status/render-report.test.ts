import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport } from '../../../src/sync-status/index.ts';
import type { DiagnosticReport } from '../../../src/sync-status/index.ts';

const FROZEN = '2026-05-16T12:00:00.000Z';

function emptyReport(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    phase_suggestions: [],
    orphans: [],
    generated_at: FROZEN,
    ...overrides,
  };
}

test('render: ready_to_gate phase produces "no active tracker issues remain" wording', () => {
  const report = emptyReport({
    phase_suggestions: [
      {
        phase_id: 'phase-2',
        tracked_total: 14,
        tracked_inactive: 14,
        untracked_warnings: [],
        ready_to_gate: true,
      },
    ],
  });
  const out = renderReport(report, 'human');

  assert.ok(out.includes('phase-2 (active): no active tracker issues remain (14/14 tracked).'));
  assert.ok(out.includes('Verify the phase is complete and run `/phase-gate phase-2`.'));
  assert.ok(!/all tasks Done/i.test(out), 'must NOT use the misleading "all tasks Done" wording');
});

test('render: untracked warnings present → manual review required block', () => {
  const report = emptyReport({
    phase_suggestions: [
      {
        phase_id: 'phase-2',
        tracked_total: 14,
        tracked_inactive: 14,
        untracked_warnings: [
          { task_id: 'P2-T20', title: 'Spike: GraphQL client' },
          { task_id: 'P2-T21', title: 'Doc audit' },
        ],
        ready_to_gate: false,
      },
    ],
  });
  const out = renderReport(report, 'human');

  assert.ok(out.includes('2 tasks missing tracker_issue_id — manual review required before `/phase-gate`:'));
  assert.ok(out.includes('  - P2-T20 "Spike: GraphQL client"'));
  assert.ok(out.includes('  - P2-T21 "Doc audit"'));
  assert.ok(!out.includes('Verify the phase is complete'), 'no /phase-gate suggestion when warnings exist');
});

test('render: no suggestions + orphans → orphan list only', () => {
  const report = emptyReport({
    orphans: [
      { identifier: 'FORGE-99', state: 'todo', title: 'Hot-fix: claim label too long' },
      { identifier: 'FORGE-82', state: 'in_progress', title: 'Fix: claimed-by exceeds cap' },
    ],
  });
  const out = renderReport(report, 'human');

  assert.ok(out.includes('Orphan tracker issues (active in tracker, not in plans/phases.yaml):'));
  assert.ok(out.includes('FORGE-99'));
  assert.ok(out.includes('Todo'));
  assert.ok(out.includes('Hot-fix: claim label too long'));
  assert.ok(out.includes('FORGE-82'));
  assert.ok(out.includes('In Progress'));
  assert.ok(out.includes('2 orphans — review whether to backfill into phases.yaml or treat as out-of-band.'));
});

test('render: empty report → "No phase suggestions." + "No orphan tracker issues. ✓"', () => {
  const report = emptyReport();
  const out = renderReport(report, 'human');

  assert.ok(out.includes('No phase suggestions.'));
  assert.ok(out.includes('No orphan tracker issues. ✓'));
});

test('render: json mode with limit_hit → envelope includes the limit_hit key', () => {
  const report = emptyReport({ limit_hit: { tracker_limit: 250 } });
  const out = renderReport(report, 'json');
  const parsed = JSON.parse(out);

  assert.deepEqual(parsed.limit_hit, { tracker_limit: 250 });
  assert.ok(Object.keys(parsed).includes('limit_hit'));
});

test('render: json mode → valid JSON envelope with expected keys', () => {
  const report = emptyReport({
    phase_suggestions: [
      {
        phase_id: 'phase-2',
        tracked_total: 1,
        tracked_inactive: 1,
        untracked_warnings: [],
        ready_to_gate: true,
      },
    ],
    orphans: [{ identifier: 'FORGE-99', state: 'todo', title: 'Out-of-band' }],
  });
  const out = renderReport(report, 'json');
  const parsed = JSON.parse(out);

  assert.deepEqual(Object.keys(parsed).sort(), ['generated_at', 'orphans', 'phase_suggestions']);
  assert.equal(parsed.phase_suggestions[0].phase_id, 'phase-2');
  assert.equal(parsed.orphans[0].identifier, 'FORGE-99');
  assert.equal(parsed.generated_at, FROZEN);
});

test('render: limit_hit emits the warning banner first', () => {
  const report = emptyReport({ limit_hit: { tracker_limit: 250 } });
  const out = renderReport(report, 'human');

  assert.ok(out.startsWith('⚠ Tracker returned full page (250).'));
});

test('render: single orphan uses singular "orphan" not "orphans"', () => {
  const report = emptyReport({
    orphans: [{ identifier: 'FORGE-99', state: 'todo', title: 'Solo' }],
  });
  const out = renderReport(report, 'human');

  assert.ok(out.includes('1 orphan — review'));
});
