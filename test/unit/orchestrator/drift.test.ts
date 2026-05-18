import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSpecCodeDrift,
  type DriftFsAdapter,
  type SpecCodeDriftReport,
} from '../../../src/orchestrator/drift.ts';

// In-memory fs adapter for hermetic tests. Maps absolute paths → file body.
// A path that is registered with a body is treated as an existing file;
// any path NOT registered throws on stat/read (mimics node:fs ENOENT).
function makeFs(files: Record<string, string>): DriftFsAdapter {
  return {
    readFileSync(p: string, _enc: 'utf8'): string {
      if (!(p in files)) {
        const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        throw err;
      }
      return files[p] ?? '';
    },
    statSync(p: string): unknown {
      if (!(p in files)) {
        const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        throw err;
      }
      return { isFile: () => true };
    },
  };
}

const REPO = '/tmp/forge-test-repo';

test('detectSpecCodeDrift: clean repo — SPEC mentions paths that all exist', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: 'See `src/cli/init.ts` and `src/orchestrator/leases.ts` for details.\n',
    [`${REPO}/src/cli/init.ts`]: '',
    [`${REPO}/src/orchestrator/leases.ts`]: '',
  });
  const r: SpecCodeDriftReport = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.scope, 'spec-code');
});

test('detectSpecCodeDrift: missing SPEC.md → 1 warning, no drift', () => {
  const fs = makeFs({});
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0]?.source, 'spec/SPEC.md');
  assert.equal(r.warnings[0]?.target, 'spec/SPEC.md');
  assert.deepEqual(r.drift, []);
});

test('detectSpecCodeDrift: missing PRD.md → silent skip (no warning, no drift)', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: '# spec — no src paths\n',
    // No PRD.md, no ORCHESTRATOR.md — both advisory.
  });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.drift, []);
});

test('detectSpecCodeDrift: one missing path → 1 drift entry with correct source/target', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: 'See `src/cli/init.ts` and `src/orchestrator/leases.ts`.\n',
    [`${REPO}/src/cli/init.ts`]: '',
    // leases.ts intentionally absent
  });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(r.drift.length, 1);
  assert.equal(r.drift[0]?.source, 'spec/SPEC.md');
  assert.equal(r.drift[0]?.target, 'src/orchestrator/leases.ts');
});

test('detectSpecCodeDrift: same path missing in 2 spec files → 2 drift entries', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: 'See `src/cli/migrate.ts`.\n',
    [`${REPO}/spec/ORCHESTRATOR.md`]: 'Also `src/cli/migrate.ts`.\n',
    // migrate.ts intentionally absent in both passes.
  });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(r.drift.length, 2);
  const sources = r.drift.map((d) => d.source).sort();
  assert.deepEqual(sources, ['spec/ORCHESTRATOR.md', 'spec/SPEC.md']);
  assert.ok(r.drift.every((d) => d.target === 'src/cli/migrate.ts'));
});

test('detectSpecCodeDrift: duplicate mention in one spec file → deduplicated to 1 drift entry', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: 'First `src/missing.ts`, then `src/missing.ts` again, and `src/missing.ts` once more.\n',
  });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(r.drift.length, 1);
  assert.equal(r.drift[0]?.target, 'src/missing.ts');
});

test('detectSpecCodeDrift: non-`src/` path in spec (app/foo.ts) → ignored entirely', () => {
  const fs = makeFs({
    [`${REPO}/spec/SPEC.md`]: 'See `app/utils/foo.ts` and `test/unit/foo.test.ts`.\n',
    // No app/ or test/ entries — but doctor only checks src/*.ts paths.
  });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.warnings, []);
});
