import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DOC_CATEGORIES, mapChangesToRequiredDocs } from '../../../src/docs-coverage/map.ts';
import { SettingsSchema } from '../../../src/schemas/settings.ts';

// Resolve the fully-defaulted docs_coverage categories via the schema so the
// test exercises the SAME config shape the CLI consumes.
function defaultCategories() {
  const settings = SettingsSchema.parse({
    version: 1,
    project: { name: 't' },
    tracker: { type: 'linear', config: { team_id: 'T' } },
    secrets: { manager: 'env_file' },
    agents: { primary_host_cli: 'claude', review_host_cli: 'codex' },
  });
  return settings.docs_coverage.categories;
}

function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), 'forge-docsmap-'));
}

test('Contract triggers on src/schemas/** and src/cli/**', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const a = mapChangesToRequiredDocs(['src/schemas/x.ts'], cats, repo);
  assert.deepEqual(a.required, ['Contract']);
  const b = mapChangesToRequiredDocs(['src/cli/orchestrate/doctor.ts'], cats, repo);
  assert.ok(b.required.includes('Contract'));
});

test('Operator triggers on src/trackers/** and settings files', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const a = mapChangesToRequiredDocs(['src/trackers/github.ts'], cats, repo);
  assert.ok(a.required.includes('Operator'));
  const b = mapChangesToRequiredDocs(['src/core/settings.ts'], cats, repo);
  assert.ok(b.required.includes('Operator'), 'a *settings*.ts path triggers Operator');
});

test('Walkthrough triggers on spec/PRD.md', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const r = mapChangesToRequiredDocs(['spec/PRD.md'], cats, repo);
  assert.ok(r.required.includes('Walkthrough'));
});

test('Rationale triggers on spec/decisions/**', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const r = mapChangesToRequiredDocs(['spec/decisions/2026-01-01-x.md'], cats, repo);
  assert.ok(r.required.includes('Rationale'));
});

test('FieldNote NEVER gap-triggers (satisfy-only)', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  // Even a path under its satisfy glob must not make it "required".
  const r = mapChangesToRequiredDocs(['docs/learnings/note.md'], cats, repo);
  assert.ok(!r.required.includes('FieldNote'));
  // And it is never in DOC_CATEGORIES required output for any input.
  for (const c of DOC_CATEGORIES) {
    if (c === 'FieldNote') {
      const r2 = mapChangesToRequiredDocs(['src/schemas/x.ts', 'docs/learnings/y.md'], cats, repo);
      assert.ok(!r2.required.includes('FieldNote'));
    }
  }
});

test('unknown paths trigger nothing', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const r = mapChangesToRequiredDocs(['LICENSE', 'package.json', 'random/thing.txt'], cats, repo);
  assert.deepEqual(r.required, []);
  assert.deepEqual(r.warnings, []);
});

test('empty diff → no required categories', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const r = mapChangesToRequiredDocs([], cats, repo);
  assert.deepEqual(r.required, []);
});

test('a malformed configured trigger glob → warning + skip (no throw)', () => {
  const repo = emptyRepo();
  const cats = {
    ...defaultCategories(),
    Contract: { trigger: ['', 'src/schemas/**'], satisfy: ['spec/SPEC.md'] },
  } as ReturnType<typeof defaultCategories>;
  const r = mapChangesToRequiredDocs(['src/schemas/x.ts'], cats, repo);
  // The valid glob still triggers Contract; the empty glob produced a warning.
  assert.ok(r.required.includes('Contract'));
  assert.ok(r.warnings.some((w) => /invalid/i.test(w)), 'a warning was recorded for the bad glob');
});

test('CRITICAL.md paths feed Rationale triggers', () => {
  const repo = emptyRepo();
  writeFileSync(join(repo, 'CRITICAL.md'), '- `src/orchestrator/leases.ts`\n', 'utf8');
  const cats = defaultCategories();
  // A path NOT in any configured trigger, but listed in CRITICAL.md, makes
  // Rationale required.
  const r = mapChangesToRequiredDocs(['src/orchestrator/leases.ts'], cats, repo);
  assert.ok(r.required.includes('Rationale'), 'CRITICAL.md path triggered Rationale');
});

test('output is deterministic (DOC_CATEGORIES order)', () => {
  const cats = defaultCategories();
  const repo = emptyRepo();
  const r = mapChangesToRequiredDocs(
    ['spec/PRD.md', 'src/schemas/x.ts', 'spec/decisions/d.md'],
    cats,
    repo,
  );
  // Contract before Walkthrough before Rationale per DOC_CATEGORIES.
  assert.deepEqual(r.required, ['Contract', 'Walkthrough', 'Rationale']);
});
