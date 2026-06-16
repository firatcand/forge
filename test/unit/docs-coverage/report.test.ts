import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coverageReport } from '../../../src/docs-coverage/report.ts';
import { SettingsSchema, type DocsCoverage } from '../../../src/schemas/settings.ts';

function defaultConfig(): DocsCoverage {
  const settings = SettingsSchema.parse({
    version: 1,
    project: { name: 't' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: 'codex' },
  });
  return settings.docs_coverage;
}

function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'forge-docsrep-'));
}

test('Contract gap when a schema changed with no Contract doc', () => {
  const repo = emptyRepo();
  const r = coverageReport({ diffPaths: ['src/schemas/x.ts'], repoRoot: repo, config: defaultConfig() });
  assert.deepEqual(r.required, ['Contract']);
  assert.deepEqual(r.satisfied, []);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0]!.category, 'Contract');
  assert.deepEqual(r.gaps[0]!.triggeredBy, ['src/schemas/x.ts']);
  assert.match(r.gaps[0]!.why, /Contract/);
});

test('satisfied (coarse category-level presence) when SPEC.md is ALSO in the diff', () => {
  const repo = emptyRepo();
  // The SPEC.md edit need not be semantically related — slice 1 is intentionally
  // coarse: any satisfy-glob match in the SAME diff satisfies the category.
  const r = coverageReport({
    diffPaths: ['src/schemas/x.ts', 'spec/SPEC.md'],
    repoRoot: repo,
    config: defaultConfig(),
  });
  assert.deepEqual(r.required, ['Contract']);
  assert.deepEqual(r.satisfied, ['Contract']);
  assert.deepEqual(r.gaps, []);
});

test('empty diff → empty report', () => {
  const repo = emptyRepo();
  const r = coverageReport({ diffPaths: [], repoRoot: repo, config: defaultConfig() });
  assert.deepEqual(r.required, []);
  assert.deepEqual(r.satisfied, []);
  assert.deepEqual(r.gaps, []);
});

test('deterministic sorted output across multiple gaps', () => {
  const repo = emptyRepo();
  const r = coverageReport({
    diffPaths: ['spec/decisions/d.md', 'src/schemas/x.ts', 'src/trackers/gh.ts'],
    repoRoot: repo,
    config: defaultConfig(),
  });
  // required follows DOC_CATEGORIES order: Contract, Operator, Rationale.
  assert.deepEqual(r.required, ['Contract', 'Operator', 'Rationale']);
  // Rationale's satisfy glob includes spec/decisions/** → satisfied by the
  // d.md edit itself; Contract + Operator are gaps.
  assert.deepEqual(r.satisfied, ['Rationale']);
  assert.deepEqual(r.gaps.map((g) => g.category), ['Contract', 'Operator']);
});

test('triggeredBy paths are sorted', () => {
  const repo = emptyRepo();
  const r = coverageReport({
    diffPaths: ['src/cli/z.ts', 'src/cli/a.ts', 'src/schemas/m.ts'],
    repoRoot: repo,
    config: defaultConfig(),
  });
  const contract = r.gaps.find((g) => g.category === 'Contract');
  assert.ok(contract);
  assert.deepEqual(contract!.triggeredBy, ['src/cli/a.ts', 'src/cli/z.ts', 'src/schemas/m.ts']);
});
