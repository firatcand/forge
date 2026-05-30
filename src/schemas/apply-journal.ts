import { z } from 'zod';

// Journal for `forge orchestrate apply-decision` (FORGE-95).
//
// The verb is a MECHANICAL applier: it does not synthesise the new artifact
// content — that is produced upstream by `/update-spec --draft` (FORGE-93) or a
// test fixture. Each entry therefore carries its full PAYLOAD (the exact bytes
// to write), so a retry under `--resume` re-writes identical content and is
// idempotent. The ADR frontmatter is only a coverage check + accepted-gate; it
// is NOT the source of payloads (Codex 2nd-pass on the FORGE-95 plan).
//
// Mirrors spec/SPEC.md §ADR layer → "/update-spec --apply journal", extended
// with the per-entry payloads + a journaled, world-state-idempotent finalize
// phase.

export const ENTRY_STATUSES = ['pending', 'applied', 'failed'] as const;
export const EntryStatusSchema = z.enum(ENTRY_STATUSES);
export type EntryStatus = z.infer<typeof EntryStatusSchema>;

// Common per-entry bookkeeping.
const entryBase = {
  status: EntryStatusSchema,
  applied_at: z.string().datetime().optional(),
  error: z.string().max(4_000).optional(),
};

// SPEC / PRD section: `ref` is a "file#anchor" locator (e.g.
// "spec/SPEC.md#cli-surface"); `new_body` is the full replacement section body
// (heading line included) written between the section's marker block.
export const MarkdownSectionEntrySchema = z.object({
  ref: z.string().min(1).max(500),
  new_body: z.string().max(200_000),
  ...entryBase,
});
export type MarkdownSectionEntry = z.infer<typeof MarkdownSectionEntrySchema>;

// phases.yaml task amendment: a deterministic `doc.setIn(set_path, set_value)`
// against the parsed YAML document (comment-preserving). `id` is the task id.
export const PhasesTaskEntrySchema = z.object({
  id: z.string().min(1).max(64),
  set_path: z.array(z.string().min(1)).min(1),
  set_value: z.union([z.string(), z.array(z.string())]),
  ...entryBase,
});
export type PhasesTaskEntry = z.infer<typeof PhasesTaskEntrySchema>;

// Tracker issue body replacement. `id` is the tracker issue id; `new_body` is
// the full replacement body (footer managed by the adapter). `retries` counts
// transient failures across `--resume` invocations.
export const TrackerIssueEntrySchema = z.object({
  id: z.string().min(1).max(128),
  new_body: z.string().max(200_000),
  retries: z.number().int().min(0).default(0),
  ...entryBase,
});
export type TrackerIssueEntry = z.infer<typeof TrackerIssueEntrySchema>;

// Finalize phase. Each flag is set AFTER its (idempotent) side-effect. On
// `--resume` the side-effects are re-checked against the world (file present /
// slug-line present / archive present), so a crash between side-effect and
// flag-set never duplicates or corrupts (Codex 2nd-pass round 2).
export const FinalizeStateSchema = z.object({
  commit_msg_written: z.boolean().default(false),
  index_appended: z.boolean().default(false),
  adr_deleted: z.boolean().default(false),
  archived: z.boolean().default(false),
});
export type FinalizeState = z.infer<typeof FinalizeStateSchema>;

export const ApplyJournalSchema = z.object({
  version: z.literal(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  started_at: z.string().datetime(),
  spec_sections: z.array(MarkdownSectionEntrySchema).default([]),
  prd_sections: z.array(MarkdownSectionEntrySchema).default([]),
  phases_tasks: z.array(PhasesTaskEntrySchema).default([]),
  tracker_issues: z.array(TrackerIssueEntrySchema).default([]),
  finalize: FinalizeStateSchema.default({}),
  completed_at: z.string().datetime().optional(),
});
export type ApplyJournal = z.infer<typeof ApplyJournalSchema>;
