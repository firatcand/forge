// FORGE-180 — `audit create-issues` (RENDER-ONLY): renders one tracker-issue
// spec per finding; mutates nothing (the /audit skill files them out-of-band).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAuditCreateIssues } from '../../../../src/cli/orchestrate/audit.ts';
import type { WorkOrder } from '../../../../src/schemas/audit.ts';

function makeRepo(prefix: string, withTracker: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  if (withTracker) {
    mkdirSync(join(repo, '.forge'), { recursive: true });
    writeFileSync(
      join(repo, '.forge', 'settings.yaml'),
      [
        'version: 1',
        'project:',
        '  name: t',
        'tracker:',
        '  type: github',
        '  config:',
        '    repo: acme/t',
        'secrets:',
        '  manager: env_file',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return repo;
}

function captureStdout(t: { after: (fn: () => void) => void }): { json(): unknown } {
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = orig;
  });
  return {
    json(): unknown {
      return JSON.parse(captured.join('').trim().split('\n').pop()!);
    },
  };
}

function workOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    scope: ['src/**'],
    dimensions: ['dead-code'],
    verify_configured: true,
    warnings: [],
    findings: [
      {
        file: 'src/foo.ts',
        line: 12,
        dimension: 'dead-code',
        classification: 'delete-safe',
        evidence: 'e',
        why_safe: 'w',
        proposed_change: 'p',
        blast_radius: 'b',
      },
    ],
    summary: {
      'delete-safe': 1,
      'de-export-safe': 0,
      'simplify-safe': 0,
      'needs-tests-first': 0,
      risky: 0,
      'do-not-touch': 0,
    },
    ...overrides,
  };
}

function writeWorkOrder(repo: string, wo: WorkOrder): string {
  const p = join(repo, 'work-order.json');
  writeFileSync(p, JSON.stringify(wo), 'utf8');
  return p;
}

test('create-issues — renders one spec per finding with the classification label', (t) => {
  const repo = makeRepo('forge-ci-ok-', true);
  try {
    const cap = captureStdout(t);
    const wo = writeWorkOrder(repo, workOrder());
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: wo });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { tracker_type: string; count: number; issue_specs: { title: string; labels: string[]; classification: string }[] } };
    assert.equal(env.ok, true);
    assert.equal(env.data.tracker_type, 'github');
    assert.equal(env.data.count, 1);
    assert.equal(env.data.issue_specs.length, 1);
    assert.match(env.data.issue_specs[0]!.title, /\[audit:delete-safe\] src\/foo\.ts:12 — dead-code/);
    assert.deepEqual(env.data.issue_specs[0]!.labels, ['audit', 'delete-safe']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — refuses with NO_TRACKER_CONFIGURED when no settings/tracker', (t) => {
  const repo = makeRepo('forge-ci-notrk-', false);
  try {
    const cap = captureStdout(t);
    const wo = writeWorkOrder(repo, workOrder());
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: wo });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'NO_TRACKER_CONFIGURED');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — missing --work-order errors', (t) => {
  const repo = makeRepo('forge-ci-nowo-', true);
  try {
    const cap = captureStdout(t);
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'INVALID_ARGS');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — bad-shape work-order is rejected (WORK_ORDER_INVALID)', (t) => {
  const repo = makeRepo('forge-ci-bad-', true);
  try {
    const cap = captureStdout(t);
    const p = join(repo, 'work-order.json');
    writeFileSync(p, JSON.stringify({ not: 'a work order' }), 'utf8');
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: p });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'WORK_ORDER_INVALID');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — empty findings renders zero specs (exit 0)', (t) => {
  const repo = makeRepo('forge-ci-empty-', true);
  try {
    const cap = captureStdout(t);
    const wo = writeWorkOrder(repo, workOrder({ findings: [], summary: { 'delete-safe': 0, 'de-export-safe': 0, 'simplify-safe': 0, 'needs-tests-first': 0, risky: 0, 'do-not-touch': 0 } }));
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: wo });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { count: number } };
    assert.equal(env.data.count, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — verify-unconfigured work-order notes unverifiable in the body + warning', (t) => {
  const repo = makeRepo('forge-ci-nover-', true);
  try {
    const cap = captureStdout(t);
    const wo = writeWorkOrder(repo, workOrder({ verify_configured: false }));
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: wo });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { issue_specs: { body: string }[]; warnings: string[] } };
    assert.match(env.data.issue_specs[0]!.body, /UNVERIFIABLE/);
    assert.ok(env.data.warnings.some((w) => /verify gate/.test(w)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — --umbrella renders an umbrella spec the children reference', (t) => {
  const repo = makeRepo('forge-ci-umb-', true);
  try {
    const cap = captureStdout(t);
    const wo = writeWorkOrder(repo, workOrder());
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: wo, umbrella: 'Audit 2026-01' });
    assert.equal(exitCode, 0);
    const env = cap.json() as { ok: boolean; data: { umbrella_spec?: { title: string }; issue_specs: { body: string }[] } };
    assert.equal(env.data.umbrella_spec?.title, 'Audit 2026-01');
    assert.match(env.data.issue_specs[0]!.body, /Audit 2026-01/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — non-regular --work-order (a directory) is rejected', (t) => {
  const repo = makeRepo('forge-ci-wdir-', true);
  try {
    const cap = captureStdout(t);
    const dir = join(repo, 'a-dir');
    mkdirSync(dir, { recursive: true });
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: dir });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'WORK_ORDER_INVALID');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — oversized --work-order is rejected before parse', (t) => {
  const repo = makeRepo('forge-ci-wbig-', true);
  try {
    const cap = captureStdout(t);
    const p = join(repo, 'work-order.json');
    writeFileSync(p, '['.padEnd(9 * 1024 * 1024, ' '), 'utf8'); // 9 MB > 8 MB cap
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: p });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'WORK_ORDER_TOO_LARGE');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('create-issues — non-JSON --work-order is rejected', (t) => {
  const repo = makeRepo('forge-ci-wjson-', true);
  try {
    const cap = captureStdout(t);
    const p = join(repo, 'work-order.json');
    writeFileSync(p, 'not json {{{', 'utf8');
    const { exitCode } = runAuditCreateIssues({ forgeDir: join(repo, '.forge'), json: true, workOrderFile: p });
    assert.equal(exitCode, 1);
    const env = cap.json() as { ok: boolean; error: { code: string } };
    assert.equal(env.error.code, 'WORK_ORDER_INVALID');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('registry lists audit create-issues', async () => {
  const { CLI_VERBS } = await import('../../../../src/cli/registry.ts');
  assert.ok(CLI_VERBS.some((v) => v.name === 'audit create-issues'));
});
