// FORGE-179: schemas for the `/audit` read-only core.
//
// `audit collect` ingests an untrusted JSON array of findings assembled by the
// skill from N read-only subagents. These schemas are the validation boundary:
// they are `.strict()` (reject unexpected keys) and bound every string length
// so a runaway subagent cannot blow up the work-order. `collect` validates each
// finding INDIVIDUALLY and DROPS (with a warning) any that fail — it never
// throws on one bad finding (a single malformed entry must not lose the rest).

import { z } from 'zod';

// The 6-way classification rubric (docs/dev/simplification-playbook.md §"Classify
// every candidate" + docs/audits/refactoring-audit-agent-prompt.md step 8). The
// taxonomy is generic to any codebase audit — it carries NO forge-specific path.
export const AUDIT_CLASSIFICATIONS = [
  'delete-safe',
  'de-export-safe',
  'simplify-safe',
  'needs-tests-first',
  'risky',
  'do-not-touch',
] as const;

export type Classification = (typeof AUDIT_CLASSIFICATIONS)[number];

export const ClassificationSchema = z.enum(AUDIT_CLASSIFICATIONS);

// Defensive bounds on untrusted subagent output. A repo-relative path is short;
// the prose fields can be a paragraph but never a megabyte.
const MAX_PATH_LEN = 1024;
const MAX_SHORT_LEN = 512;
const MAX_PROSE_LEN = 8192;

// A STRICT forward-slash repo-relative path grammar — the schema boundary for an
// untrusted subagent `file`. Rejects (Codex cross-review B2/B3): NUL + control
// chars; backslashes (Windows separator / escape forms); POSIX-absolute
// (leading `/`); Windows-absolute drive (`C:...`); and any empty / `.` / `..`
// segment. `path.isAbsolute` alone is platform-local (it would pass `C:\…` on
// POSIX), so absoluteness is rejected HERE for both platforms. The CODE filter
// in `collect` additionally enforces scope / protected / realpath-containment.
export function isSafeRepoRelativePath(s: string): boolean {
  if (s.length === 0 || s.length > MAX_PATH_LEN) return false;
  if (/[\u0000-\u001f]/.test(s)) return false; // NUL + control chars
  if (s.includes('\\')) return false; // backslash (Windows sep / escape)
  if (s.startsWith('/')) return false; // POSIX absolute
  if (/^[A-Za-z]:/.test(s)) return false; // Windows drive-absolute (C:...)
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false; // empty / . / .. segment
  }
  return true;
}

export const FindingSchema = z
  .object({
    // Repo-relative path, bounded + required here. `collect`'s CODE filter
    // enforces the strict path grammar (via isSafeRepoRelativePath) + scope /
    // protected / realpath-containment, with a distinct drop reason per failure.
    file: z.string().min(1).max(MAX_PATH_LEN),
    line: z.number().int().positive().optional(),
    dimension: z.string().min(1).max(MAX_SHORT_LEN),
    classification: ClassificationSchema,
    evidence: z.string().min(1).max(MAX_PROSE_LEN),
    why_safe: z.string().min(1).max(MAX_PROSE_LEN),
    proposed_change: z.string().min(1).max(MAX_PROSE_LEN),
    blast_radius: z.string().min(1).max(MAX_PROSE_LEN),
    tests_required: z.string().max(MAX_PROSE_LEN).optional(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

// Per-classification tally. Every classification key is present (zero-filled by
// `collect`) so consumers can render a stable summary table.
const SummarySchema = z.record(ClassificationSchema, z.number().int().nonnegative());

export const WorkOrderSchema = z
  .object({
    generated_at: z.string().min(1),
    scope: z.array(z.string().min(1)),
    dimensions: z.array(z.string().min(1)),
    // FORGE-168: findings are unverifiable without an adopter `verify:` gate.
    verify_configured: z.boolean(),
    warnings: z.array(z.string()),
    findings: z.array(FindingSchema),
    summary: SummarySchema,
  })
  .strict();

export type WorkOrder = z.infer<typeof WorkOrderSchema>;
