import { z } from 'zod';

export const IssueStateSchema = z.enum([
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
  'blocked',
]);

export const IssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  state: IssueStateSchema,
  blockerIds: z.array(z.string()),
  url: z.string().optional(),
  forgeTaskId: z.string().optional(),
});

export const CreateIssuePayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  forgeTaskId: z.string().min(1),
  ownerType: z.string().min(1),
  acceptance: z.array(z.string()),
  dependsOn: z.array(z.string()),
});

// v2 contract (FORGE-72): 'state_changed' replaced by 'version_conflict';
// 'tracker_version' added as optional opaque string on the ok variant.
export const ClaimResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    tracker_version: z.string().min(1).optional(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['already_claimed', 'version_conflict', 'transient_error']),
    detail: z.string().optional(),
  }),
]);

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

// ─── Notion MCP response shapes ──────────────────────────────────────────────
//
// Pinned subsets of the Notion MCP server's tool-result envelopes. Each entry
// here documents what the adapter actually reads — extra fields are ignored
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
