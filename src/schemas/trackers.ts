import { z } from 'zod';

// gh CLI `--json` output schemas (parsed defensively against version drift).

export const GhLabelJsonSchema = z.object({
  name: z.string(),
});

export const GhIssueJsonSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(GhLabelJsonSchema),
  body: z.string().nullable(),
  url: z.string(),
  // Only requested by the list paths (listActiveIssues/listAllIssues), not the
  // single-issue claim view — hence optional. `stateReason` is null for open
  // issues and "COMPLETED"/"NOT_PLANNED"/"REOPENED" for closed ones.
  state: z.string().optional(),
  stateReason: z.string().nullable().optional(),
});

export const GhIssueLabelsOnlySchema = z.object({
  labels: z.array(GhLabelJsonSchema),
});

export const GhIssueBodyOnlySchema = z.object({
  body: z.string().nullable(),
});

export const GhMilestoneJsonSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
});

export type GhIssueJson = z.infer<typeof GhIssueJsonSchema>;
export type GhMilestoneJson = z.infer<typeof GhMilestoneJsonSchema>;

// ─── Notion API response shapes (via the `ntn` CLI since FORGE-117) ─────────
//
// Pinned subsets of the Notion REST API responses (parsed from `ntn api`
// stdout). Each entry documents what the adapter actually reads — extra
// fields are ignored
// (z.object is non-strict by default, allowing the upstream server to add
// fields without breaking forge).

// `notion-fetch` on a database page returns this shape (subset).
const NotionRichTextItemSchema = z.object({
  plain_text: z.string().default(''),
});

const NotionTitlePropertySchema = z.object({
  type: z.literal('title'),
  title: z.array(NotionRichTextItemSchema).default([]),
});

const NotionRichTextPropertySchema = z.object({
  type: z.literal('rich_text'),
  rich_text: z.array(NotionRichTextItemSchema).default([]),
});

const NotionStatusPropertySchema = z.object({
  type: z.literal('status'),
  status: z.object({ name: z.string() }).nullable(),
});

export const NotionPagePropertySchema = z.union([
  NotionTitlePropertySchema,
  NotionRichTextPropertySchema,
  NotionStatusPropertySchema,
  // Accept any other property type without modeling it — defensive against drift.
  z.object({ type: z.string() }).passthrough(),
]);

export const NotionPageSchema = z.object({
  object: z.literal('page').optional(),
  id: z.string().min(1),
  url: z.string().optional(),
  archived: z.boolean().optional(),
  last_edited_time: z.string().min(1),
  properties: z.record(z.string(), NotionPagePropertySchema),
});

export const NotionDatabaseQueryResponseSchema = z.object({
  results: z.array(NotionPageSchema),
  next_cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional(),
});

export const NotionDatabaseSchema = z.object({
  object: z.literal('database').optional(),
  id: z.string().min(1),
  url: z.string().optional(),
});

export type NotionPage = z.infer<typeof NotionPageSchema>;
export type NotionDatabaseQueryResponse = z.infer<
  typeof NotionDatabaseQueryResponseSchema
>;
export type NotionDatabase = z.infer<typeof NotionDatabaseSchema>;
