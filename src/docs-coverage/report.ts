// FORGE-205: pure docs-coverage report over a diff.
//
// Builds on map.ts: a category is REQUIRED when a changed path matches a
// trigger glob, and SATISFIED iff some changed path matches its `satisfy`
// globs. The satisfy check is CATEGORY-LEVEL PRESENCE (coarse, intended): an
// unrelated SPEC.md edit in the same diff "satisfies" a Contract gap — slice 1
// asserts no semantic linkage between the triggering change and the doc edit.
// `gaps` = required − satisfied, each with a human `why` + the trigger path(s)
// that fired it. Deterministic: categories in DOC_CATEGORIES order, paths
// sorted + capped.

import {
  DOC_CATEGORIES,
  mapChangesToRequiredDocs,
  type DocCategory,
} from './map.ts';
import { matchAny, InvalidGlobError } from '../orchestrator/glob-match.ts';
import { parseCriticalGlobs } from '../core/critical-globs.ts';
import type { DocsCoverage } from '../schemas/settings.ts';

// Cap the triggered-by path list per gap so a sweeping trigger glob can't bloat
// the JSON. The flag (required/satisfied) is still correct; only the evidence
// list is bounded.
const MAX_TRIGGERED_BY = 20;

export interface CoverageGap {
  readonly category: DocCategory;
  readonly why: string;
  readonly triggeredBy: string[];
}

export interface CoverageReport {
  readonly required: DocCategory[];
  readonly satisfied: DocCategory[];
  readonly gaps: CoverageGap[];
  readonly warnings: string[];
}

// Per-glob defensive matcher (mirror map.ts) — used here for the satisfy check
// and for collecting the trigger evidence paths.
function matchPathDefensive(
  relPath: string,
  globs: readonly string[],
  label: string,
  warnings: string[],
): boolean {
  for (const glob of globs) {
    try {
      if (matchAny(relPath, [glob]).matched) return true;
    } catch (e) {
      if (e instanceof InvalidGlobError) {
        warnings.push(`docs-coverage: invalid ${label} glob '${e.glob}': ${e.message}; skipping that glob.`);
        continue;
      }
      warnings.push(
        `docs-coverage: could not match '${relPath}' against ${label} glob '${glob}': ${e instanceof Error ? e.message : String(e)}; treating as no-match.`,
      );
      continue;
    }
  }
  return false;
}

function effectiveTriggers(
  category: DocCategory,
  configured: readonly string[],
  repoRoot: string,
): readonly string[] {
  if (category !== 'Rationale') return configured;
  const union = new Set<string>(configured);
  for (const g of parseCriticalGlobs(repoRoot)) union.add(g);
  return [...union];
}

function whyString(category: DocCategory, triggeredBy: readonly string[], satisfyGlobs: readonly string[]): string {
  const changed = triggeredBy.length > 0 ? triggeredBy[0] : '(a tracked path)';
  const docList = satisfyGlobs.length > 0 ? satisfyGlobs.join(', ') : '(no satisfy globs configured)';
  return `diff changed ${changed} but no ${category} doc (${docList}) was updated`;
}

export function coverageReport(opts: {
  readonly diffPaths: readonly string[];
  readonly repoRoot: string;
  readonly config: DocsCoverage;
}): CoverageReport {
  const { diffPaths, repoRoot, config } = opts;
  const warnings: string[] = [];

  // Required categories (FieldNote excluded inside map.ts). map.ts owns the
  // canonical trigger logic + its own warnings.
  const mapped = mapChangesToRequiredDocs(diffPaths, config.categories, repoRoot);
  warnings.push(...mapped.warnings);
  const requiredSet = new Set<DocCategory>(mapped.required);

  const satisfied: DocCategory[] = [];
  const gaps: CoverageGap[] = [];

  for (const category of DOC_CATEGORIES) {
    if (!requiredSet.has(category)) continue;
    const cfg = config.categories[category];

    // Is the requirement satisfied? Category-level presence: any diff path
    // matching a satisfy glob.
    const isSatisfied = diffPaths.some((p) =>
      matchPathDefensive(p, cfg.satisfy, `${category} satisfy`, warnings),
    );

    if (isSatisfied) {
      satisfied.push(category);
      continue;
    }

    // Gap: collect the trigger evidence paths (sorted + capped).
    const triggers = effectiveTriggers(category, cfg.trigger, repoRoot);
    const triggeredBy = diffPaths
      .filter((p) => matchPathDefensive(p, triggers, `${category} trigger`, warnings))
      .sort();
    const capped = triggeredBy.slice(0, MAX_TRIGGERED_BY);
    gaps.push({
      category,
      why: whyString(category, capped, cfg.satisfy),
      triggeredBy: capped,
    });
  }

  return {
    required: [...mapped.required],
    satisfied,
    gaps,
    warnings: [...new Set(warnings)].sort(),
  };
}
