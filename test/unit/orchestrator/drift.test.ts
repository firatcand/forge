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

// ── FORGE-131: doctor symbol-mention check ──

import {
  BASE_SYMBOL_ALLOWLIST,
} from '../../../src/orchestrator/drift.ts';

// fs adapter with a one-level src/ directory (files + bodies) so the symbol
// mention index can be built. `srcFiles` maps a bare filename → file body; all
// live directly under <repo>/src/.
function makeFsWithSrc(
  specFiles: Record<string, string>,
  srcFiles: Record<string, string>,
): DriftFsAdapter {
  const all: Record<string, string> = { ...specFiles };
  for (const [name, body] of Object.entries(srcFiles)) {
    all[`${REPO}/src/${name}`] = body;
  }
  return {
    readFileSync(p: string, _enc: 'utf8'): string {
      if (!(p in all)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return all[p] ?? '';
    },
    statSync(p: string): unknown {
      if (!(p in all)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return { isFile: () => true };
    },
    readdirSync(p: string) {
      if (p === `${REPO}/src`) {
        return Object.keys(srcFiles).map((name) => ({
          name,
          isDirectory: () => false,
          isFile: () => true,
        }));
      }
      return [];
    },
  };
}

test('FORGE-131 — missing symbol detected (PhantomSchema absent from src)', () => {
  const fs = makeFsWithSrc(
    { [`${REPO}/spec/SPEC.md`]: 'The `PhantomSchema` validates leases.\n' },
    { 'lease.ts': 'export const LeaseSchema = 1;\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  const symbols = r.drift.filter((d) => d.kind === 'missing_symbol');
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]?.target, 'PhantomSchema');
  assert.equal(symbols[0]?.source, 'spec/SPEC.md');
});

test('FORGE-131 — present symbol (mention anywhere in src) → no drift', () => {
  const fs = makeFsWithSrc(
    { [`${REPO}/spec/SPEC.md`]: 'The `LeaseSchema` validates leases.\n' },
    { 'lease.ts': 'export const LeaseSchema = 1;\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift.filter((d) => d.kind === 'missing_symbol'), []);
});

test('FORGE-131 — built-in allowlisted term ignored even when absent from src', () => {
  const term = BASE_SYMBOL_ALLOWLIST[0]!; // e.g. 'GitHub'
  const fs = makeFsWithSrc(
    { [`${REPO}/spec/SPEC.md`]: `We push to \`${term}\`.\n` },
    { 'lease.ts': 'nothing relevant\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift.filter((d) => d.kind === 'missing_symbol'), []);
});

test('FORGE-131 — settings symbol_allowlist extension honored', () => {
  const fs = makeFsWithSrc(
    { [`${REPO}/spec/SPEC.md`]: 'Adopter uses `MyCustomThing` extensively.\n' },
    { 'lease.ts': 'nothing\n' },
  );
  const without = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(without.drift.filter((d) => d.kind === 'missing_symbol').length, 1);
  const withAllow = detectSpecCodeDrift({ repoRoot: REPO, fs, symbolAllowlist: ['MyCustomThing'] });
  assert.deepEqual(withAllow.drift.filter((d) => d.kind === 'missing_symbol'), []);
});

test('FORGE-131 — shape filter: plain prose words and short ids are NOT flagged', () => {
  const fs = makeFsWithSrc(
    {
      // None of these match the identifier-shape filter: lowercase prose, short
      // ids, hyphenated, spaced.
      [`${REPO}/spec/SPEC.md`]: 'The `lease` has an `id` and a `cwd`; see `the worker` and `spec-code`.\n',
    },
    { 'lease.ts': 'nothing\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift.filter((d) => d.kind === 'missing_symbol'), []);
});

test('FORGE-131 — shape filter: all three code shapes ARE flagged when absent', () => {
  const fs = makeFsWithSrc(
    {
      [`${REPO}/spec/SPEC.md`]:
        'Types `CamelCaseName`, fns `someCamelFn`, consts `ALL_CAPS_NAME` — all absent.\n',
    },
    { 'lease.ts': 'nothing\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  const targets = r.drift.filter((d) => d.kind === 'missing_symbol').map((d) => d.target).sort();
  assert.deepEqual(targets, ['ALL_CAPS_NAME', 'CamelCaseName', 'someCamelFn']);
});

test('FORGE-131 — no readdirSync adapter → symbol check skipped (legacy fixtures)', () => {
  // makeFs (the legacy helper above) has no readdirSync; the symbol check must
  // be a no-op so existing file-path-only tests are unaffected.
  const fs = makeFs({ [`${REPO}/spec/SPEC.md`]: 'A `DefinitelyMissingSymbol` here.\n' });
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.deepEqual(r.drift, []);
});

test('FORGE-131 — symbol drift deduped per spec file', () => {
  const fs = makeFsWithSrc(
    { [`${REPO}/spec/SPEC.md`]: 'Use `GhostSchema` and again `GhostSchema` and `GhostSchema`.\n' },
    { 'lease.ts': 'nothing\n' },
  );
  const r = detectSpecCodeDrift({ repoRoot: REPO, fs });
  assert.equal(r.drift.filter((d) => d.kind === 'missing_symbol').length, 1);
});
