// `src/orchestrator/drift.ts` — Pure SPEC↔code drift detection (v0.4).
//
// Scans each input spec file for `src/...ts` path references and reports
// any path that does not exist on disk under `repoRoot`. This is the only
// drift check shipped in v0.4 — exported-name / symbol grep is deferred to
// v0.5 (Fork 1 of FORGE-99 plan).
//
// **Pure module contract.** Callers (currently `src/cli/orchestrate/doctor.ts`)
// resolve `repoRoot` from CLI args / settings / env and pass it as an absolute
// path. This module has no env access, no `process.*` calls, no stdout, no
// settings access. Optional `fs` injection enables hermetic unit tests.

import { readFileSync as nodeReadFileSync, statSync as nodeStatSync } from 'node:fs';
import path from 'node:path';

export interface SpecCodeDriftEntry {
  readonly kind: 'missing_file';
  readonly source: string;
  readonly target: string;
}

export interface SpecCodeDriftReport {
  readonly scope: 'spec-code';
  readonly warnings: readonly SpecCodeDriftEntry[];
  readonly drift: readonly SpecCodeDriftEntry[];
}

export interface DriftFsAdapter {
  readonly readFileSync: (p: string, enc: 'utf8') => string;
  readonly statSync: (p: string) => unknown;
}

export interface DriftDetectionOpts {
  readonly repoRoot: string;
  readonly specFiles?: readonly string[];
  readonly fs?: DriftFsAdapter;
}

const DEFAULT_SPEC_FILES = ['spec/SPEC.md', 'spec/ORCHESTRATOR.md', 'spec/PRD.md'] as const;
const FILE_PATH_REGEX = /\b(src\/[A-Za-z0-9_\-./]+\.ts)\b/g;
const REQUIRED_SPEC = 'spec/SPEC.md';

export function detectSpecCodeDrift(opts: DriftDetectionOpts): SpecCodeDriftReport {
  const { repoRoot } = opts;
  const specFiles = opts.specFiles ?? DEFAULT_SPEC_FILES;
  const fs: DriftFsAdapter = opts.fs ?? { readFileSync: nodeReadFileSync, statSync: nodeStatSync };
  const warnings: SpecCodeDriftEntry[] = [];
  const drift: SpecCodeDriftEntry[] = [];

  for (const rel of specFiles) {
    const full = path.join(repoRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      // Only SPEC.md is required; PRD.md + ORCHESTRATOR.md are advisory
      // and missing-silently is intentional for adopter projects that don't
      // ship all three artifacts.
      if (rel === REQUIRED_SPEC) {
        warnings.push({ kind: 'missing_file', source: rel, target: rel });
      }
      continue;
    }
    const refs = new Set<string>();
    for (const m of raw.matchAll(FILE_PATH_REGEX)) {
      const ref = m[1] ?? '';
      if (ref) refs.add(ref);
    }
    for (const ref of refs) {
      const refFull = path.join(repoRoot, ref);
      try {
        fs.statSync(refFull);
      } catch {
        drift.push({ kind: 'missing_file', source: rel, target: ref });
      }
    }
  }

  return { scope: 'spec-code', warnings, drift };
}
