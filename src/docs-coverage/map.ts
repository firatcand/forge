// FORGE-205: pure mapping from diff paths → required doc categories.
//
// A category is REQUIRED when some changed path matches one of its `trigger`
// globs. FieldNote is satisfy-only (its trigger list is empty by default and it
// NEVER gap-triggers — field notes are already owned by `/learn`). Rationale's
// triggers additionally include the adopter's CRITICAL.md paths (unioned at
// runtime via parseCriticalGlobs — they're per-repo, not a static config
// default). All matching goes through `matchAny`; a malformed configured glob
// throws InvalidGlobError, which we CATCH per-glob → push a warning + skip that
// glob (mirrors audit.ts:431-444) so a bad adopter config never crashes the
// public `doctor`. Deterministic: categories iterate in DOC_CATEGORIES order,
// outputs are sorted.

import { parseCriticalGlobs } from '../core/critical-globs.ts';
import { matchAny, InvalidGlobError } from '../orchestrator/glob-match.ts';
import type { DocsCoverage } from '../schemas/settings.ts';

// Exact casing is load-bearing (it's the public report vocabulary + the
// settings.docs_coverage.categories keys).
export const DOC_CATEGORIES = ['Contract', 'Operator', 'Walkthrough', 'Rationale', 'FieldNote'] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

// FieldNote is satisfy-only in slice 1 — never gap-triggering.
const GAP_TRIGGERING: ReadonlySet<DocCategory> = new Set<DocCategory>([
  'Contract',
  'Operator',
  'Walkthrough',
  'Rationale',
]);

export interface RequiredDocsResult {
  readonly required: DocCategory[];
  readonly warnings: string[];
}

// Match `path` against `globs` ONE GLOB AT A TIME so a single malformed glob
// (InvalidGlobError) degrades to a warning + skip rather than aborting the
// whole category. Returns true on the first glob that matches.
function matchAnyDefensive(
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
      // matchAny also throws a plain Error on an absolute diff path. git
      // returns repo-relative POSIX, but be defensive: warn + treat as no-match
      // for this glob rather than crashing the public verb.
      warnings.push(
        `docs-coverage: could not match '${relPath}' against ${label} glob '${glob}': ${e instanceof Error ? e.message : String(e)}; treating as no-match.`,
      );
      continue;
    }
  }
  return false;
}

// Resolve a category's effective trigger globs. Rationale unions the adopter's
// CRITICAL.md paths into its configured triggers (per-repo, runtime).
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

export function mapChangesToRequiredDocs(
  diffPaths: readonly string[],
  categoriesConfig: DocsCoverage['categories'],
  repoRoot: string,
): RequiredDocsResult {
  const warnings: string[] = [];
  const required = new Set<DocCategory>();

  for (const category of DOC_CATEGORIES) {
    if (!GAP_TRIGGERING.has(category)) continue; // FieldNote: never gap-triggers.
    const cfg = categoriesConfig[category];
    const triggers = effectiveTriggers(category, cfg.trigger, repoRoot);
    if (triggers.length === 0) continue;
    for (const p of diffPaths) {
      if (matchAnyDefensive(p, triggers, `${category} trigger`, warnings)) {
        required.add(category);
        break;
      }
    }
  }

  return {
    required: DOC_CATEGORIES.filter((c) => required.has(c)),
    warnings: [...new Set(warnings)].sort(),
  };
}
