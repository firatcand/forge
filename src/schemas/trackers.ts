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

export const ClaimResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['already_claimed', 'state_changed', 'transient_error']),
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
